// DTOs for the space preview commands.
//
// Mirrors `space-preview-core/src/models.rs`; every field is camelCase on the
// wire and `modified` is Unix milliseconds. These shapes and the `TextEncoding`
// union are frozen for the lanes that build on this baseline.

/** Text encoding a preview may read and write with. */
export type TextEncoding =
  | "auto"
  | "utf-8"
  | "utf-16le"
  | "utf-16be"
  | "gb18030"
  | "big5"
  | "windows-1252"
  | "shift_jis";

/** The reading font a preview uses. Code and text stay monospaced. */
export type PreviewFont = "auto" | "sans" | "serif" | "mono";

/** How an HTML file opens by default. */
export type PreviewHtmlView = "source" | "web";

/** The trigger that opens the preview window over a file-manager selection. */
export type PreviewKey = "space" | "winSpace";

/** What the backend reports about a file before it is read. */
export interface PreviewFileInfo {
  id: string;
  name: string;
  path: string;
  size: number;
  modified: number;
  mime: string;
  directory: boolean;
  etag: string;
}

/** The result of a text write. */
export interface WriteResult {
  size: number;
  modified: number;
  etag: string;
}

/** Whether the Windows space agent is enabled and actually running. */
export interface AgentStatus {
  enabled: boolean;
  running: boolean;
  comReady: boolean;
}

/** The selection the space agent handed to the preview window. */
export interface InitialPaths {
  paths: string[];
  text: boolean;
  fileManager: boolean;
}

/** The persisted preferences in `preview.json`. */
export interface PreviewPreferences {
  version: number;
  spaceEnabled: boolean;
  readingWidth: number;
  fontSize: number;
  defaultEncoding: TextEncoding;
  /** Files larger than this many kilobytes skip the foldable line view. */
  textPreviewThresholdKb: number;
  font: PreviewFont;
  /** Whether text files wrap long lines. */
  wrap: boolean;
  html: PreviewHtmlView;
  /** The largest file a whole-file preview reads, in mebibytes. */
  maxPreviewMiB: number;
  /** The largest file an archive viewer extracts from an archive, in mebibytes. */
  maxArchiveEntryMiB: number;
  /** Whether the standalone window keeps several files in tabs. */
  tabs: boolean;
  previewKey: PreviewKey;
}
