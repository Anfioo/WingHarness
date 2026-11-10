// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// CAD, 3D-model, RAW-image and design-thumbnail requests are not part of this
// build, so their kinds and result fields are gone.
export interface ArchiveEntry {
  name: string;
  size: number;
  compressed: number;
  directory: boolean;
  index: number;
  offset?: number;
  method?: number;
  encrypted?: boolean;
  crc?: number;
  sourcePath?: string;
}
export interface WorkerRequest {
  archiveEntryLimit?: number;
  progressive?: boolean;
  phase?: 'index' | 'package';
  unit?: number;
  encoding?: import('../engine/files').TextEncoding;
  partial?: boolean;
  kind:
    | 'text'
    | 'markdown'
    | 'archive'
    | 'archive-entry'
    | 'archive-directory'
    | 'archive-data'
    | 'archive-decompress'
    | 'package-directory'
    | 'compound-data'
    | 'web-archive'
    | 'xar-data'
    | 'legacy-doc'
    | 'legacy-ppt'
    | 'metafile'
    | 'docx'
    | 'xlsx'
    | 'legacy-xlsx'
    | 'asciidoc'
    | 'pptx'
    | 'csv'
    | 'odt'
    | 'ods'
    | 'odp'
    | 'epub'
    | 'html'
    | 'fb2'
    | 'notebook'
    | 'tiff'
    | 'mail'
    | 'animation'
    | 'docx-layout';
  name: string;
  bytes: Uint8Array;
  entryName?: string;
  entry?: ArchiveEntry;
  count?: number;
  page?: number;
  fileSize?: number;
}
export interface WorkbookCellStyle {
  fontFamily?: string;
  fontSize?: number;
  fontWeight?: number;
  fontStyle?: 'normal' | 'italic';
  textDecoration?: string;
  color?: string;
  backgroundColor?: string;
  textAlign?: 'left' | 'center' | 'right' | 'justify';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  whiteSpace?: 'pre' | 'pre-wrap';
  borderTop?: string;
  borderRight?: string;
  borderBottom?: string;
  borderLeft?: string;
}
export interface WorkbookMerge {
  row: number;
  column: number;
  rows: number;
  columns: number;
}
export interface WorkbookSheet {
  name: string;
  rows: string[][];
  columns: number;
  truncated: boolean;
  styles?: WorkbookCellStyle[];
  cellStyles?: number[][];
  rowHeights?: Record<number, number>;
  columnWidths?: Record<number, number>;
  defaultRowHeight?: number;
  merges?: WorkbookMerge[];
}
export interface WorkerResult {
  units?: { path: string; name: string }[];
  text?: string;
  html?: string;
  encoding?: string;
  language?: string;
  lines?: number;
  entries?: ArchiveEntry[];
  truncated?: boolean;
  sheets?: WorkbookSheet[];
  slides?: { title: string; paragraphs: string[] }[];
  data?: Uint8Array;
  chapters?: { title: string; html: string }[];
  note?: string;
  raster?: { width: number; height: number; pixels: Uint8Array; pages: number; page: number };
  mail?: import('../engine/mail').MailContent;
  webArchive?: import('../engine/web-archive').WebArchive;
  metafile?: { width: number; height: number; records: number };
  animation?: { data: Record<string, unknown>; names: string[]; page: number };
}
