// Frozen shared types for the Markdown editor.
//
// The wire DTOs live in the command service; they are re-exported here so every
// lane imports from one module, together with the page's own state contracts.
// A0 wrote this file in full: later lanes read it and do not edit it.

export type {
  AppearanceSettings,
  BehaviorSettings,
  Encoding,
  Eol,
  ExportSettings,
  MdAssetResult,
  MdCursor,
  MdEditorError,
  MdEditorErrorCode,
  MdEditorSettings,
  MdFileMeta,
  MdPdfMargins,
  MdPdfOptions,
  MdReadResult,
  MdRecentEntry,
  MdRecentList,
  MdSaveResult,
  MdSession,
  MdSessionTab,
  ViewMode,
  ViewSettings,
} from "@/commands/services/md-editor/types";

import type { Encoding, Eol, MdCursor, ViewMode } from "@/commands/services/md-editor/types";

/** One open document. Untitled tabs have `path: null`. */
export type MdTabState = {
  /** Unique within the session. */
  id: string;
  path: string | null;
  /** Tab title: the file name, or a localized "Untitled". */
  name: string;
  /** Live buffer; always normalized to `\n`. */
  content: string;
  /** Content at the last successful save, for the dirty flag. */
  savedContent: string;
  encoding: Encoding;
  eol: Eol;
  /** Modification time read (or written) last; `null` until first save. */
  mtimeMs: number | null;
  viewMode: ViewMode;
  cursor: MdCursor;
};

/**
 * The module-level store F1 implements in `store.ts`, which survives leaving
 * the page. Dirty means `content !== savedContent`.
 */
export interface MdEditorStore {
  tabs: MdTabState[];
  activeId: string | null;
  active(): MdTabState | null;
  isDirty(id: string): boolean;
  openFile(path: string): Promise<void>;
  newUntitled(): void;
  /** Returns `false` when the user cancelled the unsaved-changes prompt. */
  closeTab(id: string): Promise<boolean>;
  save(id: string): Promise<void>;
  saveAs(id: string): Promise<void>;
  setContent(id: string, content: string): void;
  setViewMode(id: string, mode: ViewMode): void;
}
