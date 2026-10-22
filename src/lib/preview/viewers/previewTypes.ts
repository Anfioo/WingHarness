export type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; stats?: PreviewStat[]; content: PreviewContent }
  | { status: 'error'; message: string }

export type PreviewContent =
  | { kind: 'word'; html: string; outline: WordOutlineItem[] }
  | { kind: 'html'; html: string }
  | { kind: 'text'; text: string }
  | { kind: 'sheet'; tables: SheetTable[] }
  | { kind: 'presentation'; slides: PresentationSlide[]; source?: Uint8Array }
  | { kind: 'archive'; items: ArchiveItem[] }
  | { kind: 'pdf'; objectUrl: string; summary: PdfSummary }
  | { kind: 'media'; media: 'image' | 'tiff' | 'icns' | 'audio' | 'video'; objectUrl: string }
  | { kind: 'font'; objectUrl: string }
  | BookContent
  | { kind: 'email'; subject: string; from: string; to: string; date: string; html: string; attachments: Array<{ name: string; mime: string }> }
  | { kind: 'xmind'; sheets: Array<{ title: string; data: import('mind-elixir').MindElixirData }> }
  | { kind: 'psd'; summary: PsdSummary; objectUrl: string }
  | { kind: 'unsupported' }

export type PreviewStat = {
  label: string
  value: string
}

export type SheetTable = {
  name: string
  rows: string[][]
}

export type PresentationSummary = {
  slides: PresentationSlide[]
}

export type PresentationSlide = {
  index: number
  title: string
  text: string
  notes: string
}

export type WordSummary = {
  outline: WordOutlineItem[]
}

export type WordOutlineItem = {
  level: number
  text: string
}

export type ArchiveItem = {
  name: string
  directory: boolean
  size?: number
  preview?: ArchivePreview
}

export type ArchivePreview =
  | { kind: 'text'; text: string; mime: string }
  | { kind: 'image'; objectUrl: string; mime: string }
  | { kind: 'unsupported'; message: string }

export type PdfSummary = {
  pages: number
  text: string
}

export type BookContent = {
  kind: 'book'
  title: string
  creator: string
  chapters: Array<{ title: string; html: string }>
}

export type PsdSummary = {
  width: number
  height: number
  layerCount: number
  layers: string[]
}
