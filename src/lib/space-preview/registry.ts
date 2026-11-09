// The preview engine registry: extension/signature → engine.
//
// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// The table is trimmed to the core set: CAD, 3D models, RAW/professional images
// and design thumbnails are not part of WingHarness. Labels are English here
// because the UI translates them; the upstream table used Chinese literals.

import { extension, sniffKind } from "./engine/files";
import { sourceLanguage, sourceLanguages } from "./engine/source-languages";

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

// The registry is the built-in plugin boundary. Unknown extensions always have a fallback.
export const engines: EngineDescriptor[] = [
  {
    kind: "image",
    extensions: ["jpg", "jpeg", "jfif", "png", "apng", "gif", "webp", "svg", "bmp", "ico", "avif"],
    label: "Image",
  },
  { kind: "pdf", extensions: ["pdf"], label: "PDF document" },
  { kind: "ofd", extensions: ["ofd"], label: "OFD document" },
  { kind: "tiff", extensions: ["tif", "tiff"], label: "TIFF image" },
  { kind: "metafile", extensions: ["wmf", "emf"], label: "Windows metafile" },
  { kind: "psd", extensions: ["psd", "psb"], label: "Photoshop document" },
  { kind: "xmind", extensions: ["xmind"], label: "XMind mind map" },
  { kind: "font", extensions: ["ttf", "otf", "woff", "woff2", "ttc"], label: "Font" },
  {
    kind: "database",
    extensions: [
      "sqlite",
      "sqlite3",
      "db",
      "db3",
      "sdb",
      "s3db",
      "sl3",
      "sqlitedb",
      "gpkg",
      "mbtiles",
    ],
    label: "SQLite database",
  },
  { kind: "mail", extensions: ["eml", "msg"], label: "Mail" },
  {
    kind: "legacy-xlsx",
    extensions: ["xls", "xlsb", "xlt", "xlw", "dbf", "dif", "sylk", "slk"],
    label: "Excel / data table",
  },
  { kind: "asciidoc", extensions: ["adoc", "asciidoc", "ad"], label: "AsciiDoc document" },
  { kind: "diagram", extensions: ["mermaid", "mmd"], label: "Diagram" },
  { kind: "animation", extensions: ["lottie", "tgs"], label: "Lottie animation" },
  {
    kind: "markdown",
    extensions: [
      "md",
      "markdown",
      "mdx",
      "mmd",
      "mdc",
      "mkd",
      "mdwn",
      "mdown",
      "qmd",
      "rmd",
      "rmarkdown",
      "apib",
      "mdtxt",
      "mdtext",
    ],
    label: "Markdown",
  },
  { kind: "docx", extensions: ["docx", "docm", "dotx", "dotm"], label: "Word document" },
  { kind: "legacy-doc", extensions: ["doc", "dot"], label: "Word 97–2003 document" },
  {
    kind: "legacy-ppt",
    extensions: ["ppt", "pps", "pot"],
    label: "PowerPoint 97–2003 presentation",
  },
  { kind: "html", extensions: ["html", "htm", "xhtml"], label: "HTML document" },
  { kind: "web-archive", extensions: ["mht", "mhtml"], label: "Web archive" },
  { kind: "rtf", extensions: ["rtf"], label: "RTF document" },
  { kind: "xlsx", extensions: ["xlsx", "xlsm", "xltx", "xltm"], label: "Excel workbook" },
  {
    kind: "pptx",
    extensions: ["pptx", "pptm", "potx", "potm", "ppsx", "ppsm"],
    label: "PowerPoint presentation",
  },
  { kind: "csv", extensions: ["csv", "tsv", "tab", "psv"], label: "Delimited table" },
  { kind: "odt", extensions: ["odt", "ott"], label: "OpenDocument text" },
  { kind: "ods", extensions: ["ods", "ots"], label: "OpenDocument spreadsheet" },
  { kind: "odp", extensions: ["odp", "otp"], label: "OpenDocument presentation" },
  { kind: "epub", extensions: ["epub"], label: "EPUB book" },
  { kind: "fb2", extensions: ["fb2"], label: "FictionBook" },
  { kind: "notebook", extensions: ["ipynb"], label: "Jupyter notebook" },
  { kind: "video", extensions: ["mp4", "webm", "mov", "m4v", "ogv"], label: "Video" },
  { kind: "audio", extensions: ["mp3", "wav", "ogg", "flac", "aac", "m4a"], label: "Audio" },
  {
    kind: "archive",
    extensions: [
      "zip",
      "jar",
      "apk",
      "ipa",
      "cbz",
      "whl",
      "nupkg",
      "snupkg",
      "vsix",
      "xpi",
      "egg",
      "pyz",
      "7z",
      "rar",
      "tar",
      "tgz",
      "gz",
      "bz2",
      "xz",
      "lz",
      "lzma",
      "zst",
      "zstd",
      "cb7",
      "cbr",
      "cbt",
      "iso",
      "xar",
      "cpio",
      "ar",
      "deb",
      "asar",
      "crx",
      "cfb",
      "eif",
      "pak",
      "msi",
      "msp",
      "appx",
      "appxbundle",
      "msix",
      "msixbundle",
      "aab",
      "hap",
      "wgt",
      "wgtu",
      "qlplugin",
      "ddeb",
    ],
    label: "Archive / container",
  },
  {
    kind: "text",
    extensions: [
      ...Object.keys(sourceLanguages),
      "txt",
      "text",
      "asc",
      "log",
      "js",
      "jsx",
      "ts",
      "tsx",
      "json",
      "jsonc",
      "py",
      "java",
      "c",
      "cpp",
      "h",
      "hpp",
      "cs",
      "go",
      "rs",
      "swift",
      "html",
      "css",
      "scss",
      "xml",
      "yaml",
      "yml",
      "sql",
      "toml",
      "ini",
      "conf",
      "env",
      "sh",
      "ps1",
      "bat",
      "diff",
      "patch",
      "vue",
      "svelte",
      "gitignore",
      "dockerfile",
      "rtf",
      "mjs",
      "cjs",
      "mts",
      "cts",
      "htm",
      "xhtml",
      "less",
      "sass",
      "rb",
      "php",
      "lua",
      "kt",
      "kts",
      "dart",
      "r",
      "jl",
      "pl",
      "pm",
      "cc",
      "cxx",
      "hh",
      "hxx",
      "cmake",
      "makefile",
      "gradle",
      "properties",
      "cfg",
      "config",
      "editorconfig",
      "gitconfig",
      "gitattributes",
      "npmrc",
      "nvmrc",
      "lock",
      "jsonl",
      "ndjson",
      "nd",
      "srt",
      "vtt",
      "ass",
      "ssa",
      "lrc",
      "tex",
      "bib",
      "rst",
      "adoc",
      "http",
      "graphql",
      "gql",
      "proto",
      "ipynb",
      "license",
      "readme",
      "gemfile",
      "rakefile",
    ],
    label: "Text and code",
  },
];

export function detectKind(name: string): PreviewKind {
  if (/\.lottie\.json$/i.test(name)) return "animation";
  if (
    sourceLanguage(name) !== "plaintext" &&
    /^(?:dockerfile\.|containerfile\.|\.env\.)/i.test(name)
  )
    return "text";
  return engines.find((e) => e.extensions.includes(extension(name)))?.kind ?? "binary";
}

export function previewMime(name: string): string {
  const ext = extension(name);
  const kind = detectKind(name);
  if (kind === "image")
    return (
      {
        svg: "image/svg+xml",
        jpg: "image/jpeg",
        jfif: "image/jpeg",
        apng: "image/png",
        ico: "image/vnd.microsoft.icon",
      }[ext] ?? `image/${ext}`
    );
  if (kind === "audio") return { mp3: "audio/mpeg", m4a: "audio/mp4" }[ext] ?? `audio/${ext}`;
  if (kind === "video")
    return { mov: "video/quicktime", m4v: "video/mp4", ogv: "video/ogg" }[ext] ?? `video/${ext}`;
  if (kind === "pdf") return "application/pdf";
  if (kind === "html") return "text/html";
  if (kind === "text" || kind === "markdown") return "text/plain";
  return "application/octet-stream";
}

export function unsupportedFormatHint(name: string): string | undefined {
  const ext = extension(name);
  if (["raw", "ai"].includes(ext))
    return "This image format needs a dedicated decoder; only file metadata is available.";
  if (["max", "sldprt", "sldasm"].includes(ext))
    return "This engineering format has no engine. Export DXF (2D) or STL/OBJ (3D) to preview it, or open it with the default app.";
}

/** The engine for a file name, optionally refined by its first bytes. */
export function inspectKind(name: string, bytes?: Uint8Array): PreviewKind {
  if (extension(name) === "mdc" && bytes)
    return sniffKind(bytes) === "text" ? "markdown" : "binary";
  const named = detectKind(name);
  return named !== "binary" || !bytes ? named : sniffKind(bytes);
}

/** Whether the registry has an engine for this extension (no dot). */
export function isPreviewExtension(ext: string): boolean {
  const lower = ext.toLowerCase();
  return engines.some((engine) => engine.extensions.includes(lower));
}
