// Turning a runtime archive into files on disk.
//
// The split matters: downloading goes through the moin engine (it is the app's
// HTTP client, and it already carries progress, retries and a resume plan),
// unpacking is 7z-wasm in a worker, and Rust only writes the extracted entries.
// The archive is a temporary artifact: it is deleted from the download list as
// soon as its bytes are in memory.
import {
  moinAddDownload,
  moinDeleteDownload,
  moinForgetDownload,
  moinListDownloads,
  moinResumeDownload,
  runtimeReadArchive,
  runtimeWriteFile,
  type MoinTask,
  type RuntimeKind,
} from "@/commands";

/** Largest archive the installer will accept, mirroring the backend's read cap. */
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024;

/** Extraction is synchronous inside the worker; a stuck archive is terminated. */
const EXTRACT_TIMEOUT_MS = 120_000;

/** How often the download task is polled while the installer waits on it. */
const DOWNLOAD_POLL_MS = 500;

/** Queue time plus transfer time; a task paused by the user hits this. */
const DOWNLOAD_TIMEOUT_MS = 15 * 60_000;

export type ArchiveSource = { name: string; bytes: Uint8Array };

export type ExtractedFile = { path: string; buffer: ArrayBuffer };

export type RuntimeProgress =
  | { phase: "download"; value?: number }
  | { phase: "extract" }
  | { phase: "write"; value: number; done: number; total: number };

type WorkerResponse = { ok: true; files: ExtractedFile[] } | { ok: false; error: string };

/**
 * Download an archive through the moin engine and read it back.
 *
 * The task is a normal download for as long as it runs — it appears in the
 * Downloads page with its progress and may notify on completion — but it is
 * removed again once its bytes are in memory, so installing a runtime does not
 * leave anything in the user's download history.
 */
export async function downloadArchive(
  url: string,
  onProgress?: (value: number | undefined) => void
): Promise<ArchiveSource> {
  const task = await moinAddDownload({ url, category: null, filename: archiveName(url) });
  // "Add downloads paused" applies to every new task, including this one; an
  // install cannot sit and wait for a resume press.
  if (task.status === "paused") await moinResumeDownload(task.id);

  try {
    const finished = await waitForDownload(task.id, onProgress);
    const bytes = await runtimeReadArchive(finished.dest);
    return { name: finished.filename, bytes };
  } finally {
    // Delete removes the file (and any partials); forget removes the record.
    // Both are best effort: a failure here must not turn a successful install
    // into an error.
    await moinDeleteDownload(task.id).catch(() => {});
    await moinForgetDownload(task.id).catch(() => {});
  }
}

/**
 * A URL without an archive extension still yields a usable download: 7-Zip
 * detects the format from the bytes, and the read command wants a known suffix.
 */
function archiveName(url: string): string {
  try {
    const name = new URL(url).pathname.split("/").pop() ?? "";
    return /\.(7z|zip)$/i.test(name) ? name : "runtime.7z";
  } catch {
    return "runtime.7z";
  }
}

async function waitForDownload(
  id: string,
  onProgress?: (value: number | undefined) => void
): Promise<MoinTask> {
  const started = Date.now();
  while (true) {
    const current = (await moinListDownloads()).find((task) => task.id === id);
    if (!current) throw new Error("The download task was removed.");

    if ((current.total ?? current.received) > MAX_ARCHIVE_BYTES) {
      throw new Error(`The archive is larger than ${MAX_ARCHIVE_BYTES / 1024 / 1024} MiB.`);
    }
    onProgress?.(current.total ? Math.min(current.received / current.total, 1) : undefined);

    if (current.status === "completed") return current;
    if (
      current.status === "failed" ||
      current.status === "canceled" ||
      current.status === "stalled"
    ) {
      throw new Error(current.error ?? `The download ended as ${current.status}.`);
    }
    if (Date.now() - started > DOWNLOAD_TIMEOUT_MS) {
      throw new Error("The download timed out.");
    }
    await new Promise((resolve) => window.setTimeout(resolve, DOWNLOAD_POLL_MS));
  }
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
