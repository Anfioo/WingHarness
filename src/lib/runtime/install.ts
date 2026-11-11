// Turning a runtime archive into files on disk.
//
// The split matters: fetching is a frontend job (the http plugin runs it in
// Rust only because the webview is a Cross-Origin context), unpacking is
// 7z-wasm in a worker, and Rust only writes the extracted entries. None of the
// bytes travel through JSON.
import { fetch } from "@tauri-apps/plugin-http";
import { runtimeWriteFile, type RuntimeKind } from "@/commands";

/** Largest archive the frontend will accept, mirroring the backend's read cap. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Extraction is synchronous inside the worker; a stuck archive is terminated. */
const EXTRACT_TIMEOUT_MS = 120_000;

export type ArchiveSource = { name: string; bytes: Uint8Array };

export type ExtractedFile = { path: string; buffer: ArrayBuffer };

export type RuntimeProgress =
  | { phase: "download"; value?: number }
  | { phase: "extract" }
  | { phase: "write"; value: number; done: number; total: number };

type WorkerResponse = { ok: true; files: ExtractedFile[] } | { ok: false; error: string };

/** Download an archive through the plugin's Rust-backed fetch. */
export async function fetchArchive(
  url: string,
  onProgress?: (value: number | undefined) => void
): Promise<ArchiveSource> {
  const response = await fetch(url, { method: "GET" });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);

  const total = Number(response.headers.get("content-length") ?? 0);
  const name = fileName(response.url || url);
  const chunks: Uint8Array[] = [];
  let received = 0;

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > MAX_ARCHIVE_BYTES) {
        await reader.cancel();
        throw new Error(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
      }
      chunks.push(value);
      onProgress?.(total > 0 ? Math.min(received / total, 1) : undefined);
    }
  } else {
    const buffer = new Uint8Array(await response.arrayBuffer());
    received = buffer.byteLength;
    chunks.push(buffer);
  }

  return { name, bytes: concat(chunks, received) };
}

/** Unpack an archive in a fresh worker; the worker is gone once it answers. */
export function extractArchive(source: ArchiveSource): Promise<ExtractedFile[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./extract.worker.ts", import.meta.url), {
      type: "module",
    });
    let settled = false;
    const finish = (action: () => void) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      worker.terminate();
      action();
    };
    const timer = window.setTimeout(() => {
      finish(() => reject(new Error("The archive took too long to unpack; stopped.")));
    }, EXTRACT_TIMEOUT_MS);

    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const response = event.data;
      finish(() => {
        if (response.ok) resolve(response.files);
        else reject(new Error(response.error));
      });
    };
    worker.onerror = () => {
      finish(() => reject(new Error("The extraction worker failed to load.")));
    };

    // A `Uint8Array` may be a view into a larger buffer; the worker needs exactly
    // the archive, and transferring hands its ownership over without a copy.
    const bytes = source.bytes.buffer.slice(
      source.bytes.byteOffset,
      source.bytes.byteOffset + source.bytes.byteLength
    );
    worker.postMessage({ name: source.name, bytes }, [bytes]);
  });
}

/** Write every extracted entry into the runtime directory, one at a time. */
export async function writeArchiveFiles(
  kind: RuntimeKind,
  files: ExtractedFile[],
  onProgress?: (value: number, done: number, total: number) => void
): Promise<void> {
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await runtimeWriteFile(kind, file.path, new Uint8Array(file.buffer));
    onProgress?.((index + 1) / files.length, index + 1, files.length);
  }
}

function fileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.split("/").pop() || "runtime.7z";
  } catch {
    return "runtime.7z";
  }
}

function concat(chunks: Uint8Array[], size: number): Uint8Array {
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
