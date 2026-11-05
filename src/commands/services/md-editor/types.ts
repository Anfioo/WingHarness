// DTOs and error discrimination for the Markdown editor.
//
// Mirrors `md-editor-core/src/models.rs` and `md-editor-core/src/error.rs`.
// Every field is camelCase on the wire; document content always travels
// normalized to `\n`, with `Eol` recording what the file itself uses.

/** Text encoding a document is read and written with. */
export type Encoding = "utf-8" | "gb18030";

/** Line ending a document is written with. */
export type Eol = "\n" | "\r\n";

/** Which panes the active tab shows. */
export type ViewMode = "read" | "source" | "split";

/** A document as read from disk. */
export type MdReadResult = {
  /** Normalized to `\n`. */
  content: string;
  encoding: Encoding;
  eol: Eol;
  mtimeMs: number;
  sizeBytes: number;
};

/** What a save produced. */
export type MdSaveResult = {
  mtimeMs: number;
  sizeBytes: number;
};

/** Existence and timestamps of one path, without reading its contents. */
export type MdFileMeta = {
  exists: boolean;
  mtimeMs: number | null;
  sizeBytes: number | null;
};

/** An image referenced by a document, inlined for the preview and exports. */
export type MdAssetResult = {
  /** `data:<mime>;base64,...` */
  dataUrl: string;
  mime: string;
  sizeBytes: number;
};

/** One entry of `recent.json`. */
export type MdRecentEntry = {
  path: string;
  name: string;
  /** Unix seconds. */
  openedAt: number;
  /** Set by the list command when the file no longer exists. */
  missing: boolean;
};

/** The recently opened documents, newest first. */
export type MdRecentList = {
  entries: MdRecentEntry[];
};

/** A caret position, 1-based. */
export type MdCursor = {
  line: number;
  column: number;
};

/** One tab restored from `session.json`. */
export type MdSessionTab = {
  path: string;
  cursor: MdCursor;
  scrollTop: number;
  viewMode: ViewMode;
};

/** The contents of `session.json`. Untitled documents are never stored here. */
export type MdSession = {
  tabs: MdSessionTab[];
  activePath: string | null;
};

/** Page margins in millimetres. */
export type MdPdfMargins = {
  top: number;
  right: number;
  bottom: number;
  left: number;
};

/** Arguments of the PDF export. Sizes are in millimetres. */
export type MdPdfOptions = {
  path: string;
  pageWidth: number;
  pageHeight: number;
  margins: MdPdfMargins;
};

/** Editor typography and page geometry. */
export type AppearanceSettings = {
  /** Empty means "use the application's own editor font". */
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  contentWidth: number;
  /** Empty means "use the application's own code font". */
  codeFontFamily: string;
};

/** How the source editor behaves while typing. */
export type BehaviorSettings = {
  lineWrap: boolean;
  lineNumbers: boolean;
  tabSize: number;
  autoSave: boolean;
  autoSaveIntervalSec: number;
};

/** Which panes are open by default, and how much room each gets. */
export type ViewSettings = {
  defaultMode: ViewMode;
  splitRatio: number;
  outlineVisible: boolean;
  outlineWidth: number;
};

/** Defaults applied by the export actions. */
export type ExportSettings = {
  htmlInlineStyles: boolean;
  htmlIncludeTitle: boolean;
  imageScale: number;
  imageIncludeOutline: boolean;
  pdfPage: string;
  pdfMarginMm: number;
};

/** The contents of `settings.json`. */
export type MdEditorSettings = {
  version: number;
  appearance: AppearanceSettings;
  behavior: BehaviorSettings;
  view: ViewSettings;
  export: ExportSettings;
};

/** Stable error codes returned by every `md_editor_*` command. */
export type MdEditorErrorCode =
  | "not-found"
  | "invalid-input"
  | "conflict-external-change"
  | "binary-file"
  | "encoding-failed"
  | "too-large"
  | "unsupported"
  | "io"
  | "internal";

/** Shape of a rejected `md_editor_*` command. */
export type MdEditorError = {
  code: MdEditorErrorCode;
  message: string;
  detail: Record<string, unknown> | null;
};

const MD_EDITOR_ERROR_CODES = new Set<string>([
  "not-found",
  "invalid-input",
  "conflict-external-change",
  "binary-file",
  "encoding-failed",
  "too-large",
  "unsupported",
  "io",
  "internal",
]);

/** Narrow a rejected command to the engine's error type. */
export function isMdEditorError(value: unknown): value is MdEditorError {
  if (typeof value !== "object" || value === null) return false;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && MD_EDITOR_ERROR_CODES.has(code);
}

/** `code` of a rejected command, or `null` when it came from somewhere else. */
export function mdEditorErrorCode(value: unknown): MdEditorErrorCode | null {
  return isMdEditorError(value) ? value.code : null;
}
