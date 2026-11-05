// Loads local images referenced by a preview into data URLs.

import { mdEditorErrorCode, mdEditorReadAsset } from "@/commands";
import i18n from "@/i18n";

/** Marks an `<img>` whose source is a local file. */
export const ASSET_ATTR = "data-md-asset";
/** Marks an `<img>` whose local source could not be resolved to a path. */
export const ASSET_MISSING_ATTR = "data-md-asset-missing";

const CACHE_LIMIT = 64;
const PROTOCOL = /^[a-z][a-z0-9+.-]*:/i;
const WINDOWS_ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\\\\)/;
const QUERY_OR_HASH = /[?#]/;
const SEPARATORS = /[\\/]/;

/** `absPath → dataUrl`, least recently used first. */
const cache = new Map<string, string>();
/** Reads in flight, so one image referenced twice is only read once. */
const pending = new Map<string, Promise<string | null>>();

/** Drop every cached image; call when a document's tab is closed. */
export function clearAssetsCache(): void {
  cache.clear();
}

/** Swap every image the renderer marked in `container` for its data URL. */
export async function resolveAssets(container: HTMLElement, docPath: string | null): Promise<void> {
  const images = Array.from(
    container.querySelectorAll<HTMLImageElement>(`img[${ASSET_ATTR}], img[${ASSET_MISSING_ATTR}]`)
  );
  await Promise.all(images.map((image) => loadImage(image, docPath)));
}

/** True when the source points outside the filesystem (http, data, file…). */
export function isRemoteSource(source: string): boolean {
  return PROTOCOL.test(source) || source.startsWith("//");
}

/** Absolute path of a local image reference, or null when it cannot be resolved. */
export function resolveAssetPath(source: string, docPath: string | null): string | null {
  if (WINDOWS_ABSOLUTE.test(source)) return source;
  if (isRemoteSource(source)) return null;
  const base = docPath ? directoryOf(docPath) : "";
  const relative = decodePath(stripQuery(source));
  if (!base || !relative) return null;
  const separator = base.includes("\\") ? "\\" : "/";
  return normalizePath(`${base}${separator}${relative}`, separator);
}

async function loadImage(image: HTMLImageElement, docPath: string | null): Promise<void> {
  const source = image.getAttribute(ASSET_ATTR);
  if (!source) {
    replaceWithPlaceholder(image, image.getAttribute(ASSET_MISSING_ATTR) ?? "");
    return;
  }
  const path = resolveAssetPath(source, docPath);
  if (!path) {
    replaceWithPlaceholder(image, source);
    return;
  }
  const dataUrl = await readAsset(path);
  if (!image.isConnected) return;
  if (!dataUrl) {
    replaceWithPlaceholder(image, source);
    return;
  }
  image.setAttribute("src", dataUrl);
  image.removeAttribute(ASSET_ATTR);
  // Wait for the bitmap so the caller's layout measurements see the final height;
  // a format the webview cannot decode falls back to the placeholder instead of a broken icon.
  const decoded = await image.decode().then(
    () => true,
    () => false
  );
  if (!decoded && image.isConnected) replaceWithPlaceholder(image, source);
}

function readAsset(path: string): Promise<string | null> {
  const cached = cache.get(path);
  if (cached !== undefined) {
    cache.delete(path);
    cache.set(path, cached);
    return Promise.resolve(cached);
  }
  const inFlight = pending.get(path);
  if (inFlight) return inFlight;

  const request = mdEditorReadAsset(path)
    .then((result) => {
      remember(path, result.dataUrl);
      return result.dataUrl;
    })
    .catch((error: unknown) => {
      if (mdEditorErrorCode(error) !== "not-found") {
        console.warn("md-editor: failed to read image asset", path, error);
      }
      return null;
    })
    .finally(() => {
      pending.delete(path);
    });

  pending.set(path, request);
  return request;
}

function remember(path: string, dataUrl: string): void {
  cache.delete(path);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(path, dataUrl);
}

function directoryOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return index >= 0 ? path.slice(0, index) : "";
}

function stripQuery(source: string): string {
  const cut = source.search(QUERY_OR_HASH);
  return cut < 0 ? source : source.slice(0, cut);
}

function decodePath(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** Collapse `.` and `..` segments, keeping the drive or UNC prefix. */
function normalizePath(path: string, separator: string): string {
  const parts = path.split(SEPARATORS);
  const drive = /^[A-Za-z]:$/.test(parts[0] ?? "") ? parts.shift() : undefined;
  const unc = path.startsWith("\\\\") || path.startsWith("//");
  const segments: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      segments.pop();
      continue;
    }
    segments.push(part);
  }
  const tail = segments.join(separator);
  if (drive) return `${drive}${separator}${tail}`;
  return unc ? `${separator}${separator}${tail}` : tail;
}

function replaceWithPlaceholder(image: HTMLImageElement, source: string): void {
  const placeholder = document.createElement("span");
  placeholder.className = "md-image-placeholder";
  placeholder.setAttribute("role", "img");
  placeholder.textContent = i18n.t("mdEditor.preview.imageMissing", {
    src: source || image.getAttribute("alt") || "",
  });
  image.replaceWith(placeholder);
}
