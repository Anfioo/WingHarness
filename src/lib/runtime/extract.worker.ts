// Unpacks one runtime archive with the 7-Zip build the app already ships as
// WebAssembly. It runs off the main thread because extracting a 22 MiB archive
// into ~98 MiB is seconds of synchronous work, and the wasm instance is tied to
// this worker: the caller terminates it after the response.
import SevenZip from "7z-wasm";
import sevenZipWasmUrl from "7z-wasm/7zz.wasm?url";

type ExtractRequest = { name: string; bytes: ArrayBuffer };

type ExtractedFile = { path: string; buffer: ArrayBuffer };

type ExtractResponse = { ok: true; files: ExtractedFile[] } | { ok: false; error: string };

/** `postMessage` in a worker takes a transfer list, not the window options object. */
type WorkerScope = { postMessage(message: unknown, transfer?: Transferable[]): void };

const MAX_FILES = 256;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

self.onmessage = async (event: MessageEvent<ExtractRequest>) => {
  try {
    const files = await extract(event.data.name, new Uint8Array(event.data.bytes));
    const response: ExtractResponse = { ok: true, files };
    (self as unknown as WorkerScope).postMessage(
      response,
      files.map((file) => file.buffer)
    );
  } catch (error) {
    const response: ExtractResponse = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
    self.postMessage(response);
  }
};

async function extract(name: string, bytes: Uint8Array): Promise<ExtractedFile[]> {
  const errors: string[] = [];
  const sevenZip = await SevenZip({
    locateFile: () => sevenZipWasmUrl,
    print: () => {},
    printErr: (value) => errors.push(value),
    // An encrypted archive would otherwise wait on stdin that does not exist.
    stdin: () => null as unknown as number,
  });

  const archive = name.toLowerCase().endsWith(".zip") ? "archive.zip" : "archive.7z";
  sevenZip.FS.writeFile(archive, bytes);
  try {
    sevenZip.callMain(["x", archive, "-oout", "-y", "-bd"]);
  } catch (error) {
    throw new Error(errorText(errors, error));
  }

  let out: string[];
  try {
    out = sevenZip.FS.readdir("out");
  } catch {
    throw new Error(errorText(errors, "The archive produced no files."));
  }
  if (out.length === 0) throw new Error(errorText(errors, "The archive is empty."));

  const files: ExtractedFile[] = [];
  walk(sevenZip, "out", "", files);

  if (files.length === 0) throw new Error(errorText(errors, "The archive produced no files."));
  if (files.length > MAX_FILES)
    throw new Error(`The archive contains more than ${MAX_FILES} files.`);
  const total = files.reduce((sum, file) => sum + file.buffer.byteLength, 0);
  if (total > MAX_TOTAL_BYTES) throw new Error("The unpacked archive is larger than 1 GiB.");

  return stripSingleRoot(files);
}

function walk(
  sevenZip: Awaited<ReturnType<typeof SevenZip>>,
  directory: string,
  prefix: string,
  files: ExtractedFile[]
): void {
  for (const name of sevenZip.FS.readdir(directory)) {
    if (name === "." || name === "..") continue;
    const path = `${directory}/${name}`;
    const stat = sevenZip.FS.stat(path);
    if (sevenZip.FS.isDir(stat.mode)) {
      walk(sevenZip, path, `${prefix}${name}/`, files);
      continue;
    }
    const data = sevenZip.FS.readFile(path);
    const copy = new Uint8Array(data.length);
    copy.set(data);
    const relative = safeRelative(`${prefix}${name}`);
    files.push({ path: relative, buffer: copy.buffer });
  }
}

function safeRelative(path: string): string {
  const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
  const parts = normalized.split("/");
  if (parts.some((part) => part === "" || part === "." || part === "..")) {
    throw new Error(`The archive contains an unsafe path: ${path}`);
  }
  return parts.join("/");
}

/**
 * An archive built from a folder (`frp_0.61.0_windows_amd64/frpc.exe`) should
 * land directly in the runtime directory, not one level below it. Only a single
 * top-level directory is removed: two roots mean the archive really is a tree.
 */
function stripSingleRoot(files: ExtractedFile[]): ExtractedFile[] {
  const roots = new Set(files.map((file) => file.path.split("/")[0]));
  if (roots.size !== 1) return files;
  const root = [...roots][0];
  if (!files.every((file) => file.path.startsWith(`${root}/`))) return files;
  return files.map((file) => ({ ...file, path: file.path.slice(root.length + 1) }));
}

function errorText(errors: string[], fallback: unknown): string {
  const detail = errors
    // 7-Zip erases its progress line with backspaces; the worker only wants
    // the text that survives.
    .map((line) => line.split(String.fromCharCode(8)).join("").trim())
    .filter(Boolean)
    .slice(-6)
    .join("\n");
  if (detail) return detail;
  return fallback instanceof Error ? fallback.message : String(fallback);
}
