// Space preview command service.
//
// Thin, one-to-one wrappers over the `space-preview-core` Rust commands.
// Argument keys are camelCase here; Tauri maps them onto the snake_case Rust
// parameters. The binary commands answer with raw IPC, so their results arrive
// as `ArrayBuffer`. This module is frozen: the lanes use it as-is.

import { invoke } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import type {
  AgentStatus,
  DirectoryPage,
  InitialPaths,
  PreviewFileInfo,
  PreviewPreferences,
  TextEncoding,
  WriteResult,
} from "./types";

/** Admit a path to the backend allowlist and describe the file it names. */
export async function inspectFile(path: string): Promise<PreviewFileInfo> {
  return invokeCommand<{ path: string }, PreviewFileInfo>("sp_inspect_file", { path });
}

/** One bounded page of an inspected directory; its entries are admitted too. */
export async function listDirectory(path: string, offset = 0): Promise<DirectoryPage> {
  return invokeCommand<{ path: string; offset: number }, DirectoryPage>("sp_list_directory", {
    path,
    offset,
  });
}

/** The first `limit` bytes of an inspected file. */
export async function readPrefix(path: string, limit: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("sp_read_prefix", { path, limit });
}

/** `limit` bytes starting at `offset` of an inspected file. */
export async function readRange(path: string, offset: number, limit: number): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("sp_read_range", { path, offset, limit });
}

/** A resource referenced by an inspected HTML file, confined to its directory. */
export async function readHtmlResource(path: string, base: string): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("sp_read_html_resource", { path, base });
}

/** Write a text file back, in the requested encoding, if `etag` still matches. */
export async function writeText(
  path: string,
  text: string,
  encoding: TextEncoding,
  etag?: string
): Promise<WriteResult> {
  return invokeCommand<
    { path: string; text: string; encoding: TextEncoding; etag?: string },
    WriteResult
  >("sp_write_text", { path, text, encoding, etag });
}

/** Whether a local PowerPoint can be driven to render presentations. */
export async function probePresentation(): Promise<boolean> {
  return invokeCommand<Record<string, never>, boolean>("sp_probe_presentation", {});
}

/** Convert a presentation to PDF and describe the cached result. */
export async function renderPresentation(path: string): Promise<PreviewFileInfo> {
  return invokeCommand<{ path: string }, PreviewFileInfo>("sp_render_presentation", { path });
}

/** The system icon for a path, or for a name when no path is given, as PNG. */
export async function fileIcon(
  path: string | null,
  name: string,
  folder: boolean
): Promise<ArrayBuffer> {
  return invoke<ArrayBuffer>("sp_file_icon", { path, name, folder });
}

/** The space agent's current state. */
export async function agentStatus(): Promise<AgentStatus> {
  return invokeCommand<Record<string, never>, AgentStatus>("sp_agent_status", {});
}

/** Turn the space handler on or off; the new state comes back. */
export async function setAgentEnabled(enabled: boolean): Promise<AgentStatus> {
  return invokeCommand<{ enabled: boolean }, AgentStatus>("sp_agent_set_enabled", { enabled });
}

/** Hide the preview window. */
export async function hidePreview(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("sp_hide_preview", {});
}

/** Move through a multi-file selection; returns the path now under the cursor. */
export async function navigateFileSelection(
  current: string | null,
  direction: 1 | -1
): Promise<string | null> {
  return invokeCommand<{ current: string | null; direction: 1 | -1 }, string | null>(
    "sp_navigate_file_selection",
    { current, direction }
  );
}

/** Stop an in-flight selection move. */
export async function cancelFileNavigation(): Promise<void> {
  return invokeCommand<Record<string, never>, void>("sp_cancel_file_navigation", {});
}

/** The selection the space agent handed to this preview window. */
export async function initialPaths(): Promise<InitialPaths> {
  return invokeCommand<Record<string, never>, InitialPaths>("sp_initial_paths", {});
}

/** Open the preview window on these paths, optionally in the text editor. */
export async function openPreview(paths: string[], text = false): Promise<void> {
  return invokeCommand<{ paths: string[]; text: boolean }, void>("sp_open_preview", {
    paths,
    text,
  });
}

/** The persisted preferences. */
export async function getPreviewPreferences(): Promise<PreviewPreferences> {
  return invokeCommand<Record<string, never>, PreviewPreferences>("sp_preferences_get", {});
}

/** Replace the whole preferences object; the stored value comes back. */
export async function savePreviewPreferences(
  preferences: PreviewPreferences
): Promise<PreviewPreferences> {
  return invokeCommand<{ preferences: PreviewPreferences }, PreviewPreferences>(
    "sp_preferences_save",
    { preferences }
  );
}
