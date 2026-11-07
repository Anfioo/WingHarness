import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import { requireActiveProject } from "../../project-context";

/**
 * The file preview backend: raw bytes of a project.
 *
 * The viewers themselves are entirely frontend; these two commands are all the
 * backend does. `path` is the `/`-rooted form the project file tree already
 * speaks, and the backend confines it to `root` — by default the project this
 * window has open, but the notes page passes its own directory instead.
 */

export interface PreviewMeta {
  /** `/`-rooted, relative to the working copy. */
  path: string;
  name: string;
  extension?: string;
  mime: string;
  /** Bytes on disk. */
  size: number;
  /** Unix seconds, the unit the shared `formatTime` helper expects. */
  modified?: number;
  /** Whether the viewer registry has a renderer for this extension. */
  previewable: boolean;
  /** Past the backend's read cap; the page should say so instead of reading. */
  overCap: boolean;
}

/** A file's identity and how the preview should treat it. */
export function previewMetadata(path: string, root?: string): Promise<PreviewMeta> {
  return invokeCommand("preview_metadata", { root: root ?? requireActiveProject(), path });
}

/**
 * A file's bytes.
 *
 * The backend answers with raw IPC rather than a JSON array of numbers, so the
 * result arrives as an `ArrayBuffer` and is wrapped here.
 */
export async function previewBytes(path: string, root?: string): Promise<Uint8Array> {
  try {
    const bytes = await invoke<ArrayBuffer>("preview_bytes", {
      root: root ?? requireActiveProject(),
      path,
    });
    return new Uint8Array(bytes);
  } catch (error) {
    console.error("操作失败：", error);
    throw error;
  }
}
