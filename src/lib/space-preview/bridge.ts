// The data bridge between the preview engine and the sp_* commands.
//
// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// The upstream file used the asset protocol for URLs and invoked the commands
// directly; here every call goes through `src/commands/services/space-preview`
// and `fileUrl` materialises a blob URL instead.

import { open } from "@tauri-apps/plugin-dialog";
import {
  fileIcon,
  inspectFile,
  readPrefix,
  readRange as readFileRange,
  renderPresentation as renderPresentationFile,
} from "@/commands";
import { formatSize } from "./engine/files";
import { readWholeFile } from "./engine/full-read";
import { wholeFileLimit } from "./limits";

/** A file the preview can read. `blob` is set for files dropped from the webview. */
export interface PreviewFile {
  id: string;
  name: string;
  size: number;
  modified: number;
  mime: string;
  path?: string;
  directory?: boolean;
  blob?: Blob;
}

/** Thrown when a file is too large to read into memory for a whole-file preview. */
export class PreviewTooLargeError extends Error {
  readonly code = "preview-too-large";
  readonly size: number;
  readonly limit: number;

  constructor(size: number, limit = wholeFileLimit()) {
    super(
      `This file is ${formatSize(size)}; whole-file previews are limited to ${formatSize(limit)}.`
    );
    this.name = "PreviewTooLargeError";
    this.size = size;
    this.limit = limit;
  }
}

const iconCache = new Map<string, Promise<string | undefined>>();

export function systemFileIcon(
  name: string,
  path?: string,
  folder = false
): Promise<string | undefined> {
  const key = path
    ? `path:${path}`
    : folder
      ? "folder"
      : `type:${name.split(".").at(-1)?.toLowerCase()}`;
  let pending = iconCache.get(key);
  if (!pending) {
    pending = fileIcon(path ?? null, name, folder)
      .then((data) => {
        const bytes = new Uint8Array(data);
        return bytes.length
          ? `data:image/png;base64,${btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(""))}`
          : undefined;
      })
      .catch(() => undefined);
    if (iconCache.size >= 256) iconCache.delete(iconCache.keys().next().value!);
    iconCache.set(key, pending);
  }
  return pending;
}

export async function pickNativeFiles(): Promise<PreviewFile[]> {
  const paths = await open({ multiple: false, directory: false });
  if (!paths) return [];
  return Promise.all((Array.isArray(paths) ? paths : [paths]).map(inspectPath));
}

/** Admit a path to the backend allowlist and describe it to the preview. */
export async function inspectPath(path: string): Promise<PreviewFile> {
  const info = await inspectFile(path);
  return {
    id: info.id,
    name: info.name,
    size: info.size,
    modified: info.modified,
    mime: info.mime,
    path: info.path,
    directory: info.directory,
  };
}

export async function renderPresentation(file: PreviewFile): Promise<PreviewFile> {
  const info = await renderPresentationFile(requirePath(file));
  return {
    id: info.id,
    name: info.name,
    size: info.size,
    modified: info.modified,
    mime: info.mime,
    path: info.path,
    directory: info.directory,
  };
}

export async function readBytes(file: PreviewFile, limit: number): Promise<Uint8Array> {
  if (file.blob) return new Uint8Array(await file.blob.slice(0, limit).arrayBuffer());
  return new Uint8Array(await readPrefix(requirePath(file), limit));
}

export function readFullBytes(
  file: PreviewFile,
  signal: AbortSignal,
  progress?: (percent: number) => void
) {
  if (!file.blob && file.size > wholeFileLimit())
    return Promise.reject(new PreviewTooLargeError(file.size));
  return readWholeFile(
    file.size,
    (offset, length) => readRange(file, offset, length),
    signal,
    progress
  );
}

export async function readRange(
  file: PreviewFile,
  offset: number,
  limit: number
): Promise<Uint8Array> {
  if (
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    !Number.isSafeInteger(limit) ||
    limit < 0 ||
    limit > 32 * 1024 * 1024
  )
    throw new Error("Invalid file read range.");
  if (file.blob) return new Uint8Array(await file.blob.slice(offset, offset + limit).arrayBuffer());
  return new Uint8Array(await readFileRange(requirePath(file), offset, limit));
}

/** A URL the DOM can load; revoke it with `dispose` when the viewer unmounts. */
export async function fileUrl(file: PreviewFile): Promise<{ url: string; dispose: () => void }> {
  if (file.blob) {
    const url = URL.createObjectURL(file.blob);
    return { url, dispose: () => URL.revokeObjectURL(url) };
  }
  const bytes = await readFullBytes(file, new AbortController().signal);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: file.mime }));
  return { url, dispose: () => URL.revokeObjectURL(url) };
}

function requirePath(file: PreviewFile): string {
  if (!file.path) throw new Error("This preview has no path to read from.");
  return file.path;
}
