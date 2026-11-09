// The preview engine registry: extension/signature → engine.
//
// A0 freezes the shape only. F1 replaces the empty table and the two lookups
// with the ported registry; the types and signatures below must not change.

/** Every engine the preview can dispatch to. */
export type PreviewKind =
  | "image"
  | "pdf"
  | "ofd"
  | "text"
  | "markdown"
  | "video"
  | "audio"
  | "archive"
  | "docx"
  | "xlsx"
  | "pptx"
  | "csv"
  | "odt"
  | "ods"
  | "odp"
  | "epub"
  | "html"
  | "rtf"
  | "fb2"
  | "notebook"
  | "tiff"
  | "font"
  | "database"
  | "mail"
  | "legacy-xlsx"
  | "asciidoc"
  | "diagram"
  | "animation"
  | "web-archive"
  | "legacy-doc"
  | "legacy-ppt"
  | "metafile"
  | "psd"
  | "xmind"
  | "binary";

/** One engine's extension set and the label the UI shows for it. */
export interface EngineDescriptor {
  kind: PreviewKind;
  extensions: string[];
  label: string;
}

/** Filled by F1. */
export const engines: EngineDescriptor[] = [];

/** The engine for a file name, optionally refined by its first bytes. */
export function inspectKind(name: string, bytes?: Uint8Array): PreviewKind {
  void name;
  void bytes;
  return "binary";
}

/** Whether the registry has an engine for this extension (no dot). */
export function isPreviewExtension(ext: string): boolean {
  void ext;
  return false;
}
