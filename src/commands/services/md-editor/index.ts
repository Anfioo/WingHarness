// Markdown editor command service.
//
// Thin, one-to-one wrappers over the `md-editor-core` Rust commands. Argument
// keys are camelCase here; Tauri maps them onto the snake_case Rust parameters.
// This module is frozen: the lanes use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isMdEditorError` / `mdEditorErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type {
  Encoding,
  Eol,
  MdAssetResult,
  MdEditorSettings,
  MdFileMeta,
  MdPdfOptions,
  MdReadResult,
  MdRecentList,
  MdSaveResult,
  MdSession,
} from "./types";

// Documents.

/** Read a document, reporting the encoding and EOL it was stored with. */
export async function mdEditorOpenFile(path: string): Promise<MdReadResult> {
  return await invokeCommand<{ path: string }, MdReadResult>("md_editor_open_file", { path });
}

/** Write a document back in its original encoding. */
export async function mdEditorSaveFile(
  path: string,
  content: string,
  encoding: Encoding,
  eol: Eol,
  expectedMtimeMs: number | null = null
): Promise<MdSaveResult> {
  return await invokeCommand<
    {
      path: string;
      content: string;
      encoding: Encoding;
      eol: Eol;
      expectedMtimeMs: number | null;
    },
    MdSaveResult
  >("md_editor_save_file", { path, content, encoding, eol, expectedMtimeMs });
}

/** Existence and timestamps only. */
export async function mdEditorFileMeta(path: string): Promise<MdFileMeta> {
  return await invokeCommand<{ path: string }, MdFileMeta>("md_editor_file_meta", { path });
}

/** Inline a local image as a data URL for the preview and the exports. */
export async function mdEditorReadAsset(path: string): Promise<MdAssetResult> {
  return await invokeCommand<{ path: string }, MdAssetResult>("md_editor_read_asset", { path });
}

/** Write base64 bytes (HTML export, long-image PNG) to `path`. */
export async function mdEditorSaveBinary(path: string, base64: string): Promise<void> {
  return await invokeCommand<{ path: string; base64: string }, void>("md_editor_save_binary", {
    path,
    base64,
  });
}

// Settings.

export async function mdEditorSettingsGet(): Promise<MdEditorSettings> {
  return await invokeCommand<Record<string, never>, MdEditorSettings>("md_editor_settings_get", {});
}

/** Replace the whole settings object; out-of-range values are clamped. */
export async function mdEditorSettingsSet(settings: MdEditorSettings): Promise<MdEditorSettings> {
  return await invokeCommand<{ settings: MdEditorSettings }, MdEditorSettings>(
    "md_editor_settings_set",
    { settings }
  );
}

// Recent files.

export async function mdEditorRecentList(): Promise<MdRecentList> {
  return await invokeCommand<Record<string, never>, MdRecentList>("md_editor_recent_list", {});
}

/** Record a path as recently opened; deduplicated and capped at 30. */
export async function mdEditorRecentAdd(path: string): Promise<MdRecentList> {
  return await invokeCommand<{ path: string }, MdRecentList>("md_editor_recent_add", { path });
}

export async function mdEditorRecentRemove(path: string): Promise<MdRecentList> {
  return await invokeCommand<{ path: string }, MdRecentList>("md_editor_recent_remove", { path });
}

// Session.

export async function mdEditorSessionGet(): Promise<MdSession> {
  return await invokeCommand<Record<string, never>, MdSession>("md_editor_session_get", {});
}

/** Store the open tabs, cursors and view modes of the current run. */
export async function mdEditorSessionSet(session: MdSession): Promise<void> {
  return await invokeCommand<{ session: MdSession }, void>("md_editor_session_set", { session });
}

// Export.

/** Print the current window to `options.path` through WebView2's `PrintToPdf`. */
export async function mdEditorExportPdf(options: MdPdfOptions): Promise<void> {
  return await invokeCommand<{ options: MdPdfOptions }, void>("md_editor_export_pdf", {
    options,
  });
}
