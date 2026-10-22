import { renderOpenDocument } from './openDocumentRenderer'
import { audioFormats, videoFormats } from './mediaFormats'
import type ExcelJS from 'exceljs'
import type JSZip from 'jszip'
import pdfWorkerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'
import { bytesToArrayBuffer, bytesToObjectUrl, bytesToText } from '../lib/bytes'
import { formatBytes } from '../lib/format'
import { decodeXml, stripXml } from '../lib/xml'
import type { FilePayload, UrlPayload } from '../types'
import type { LoadState, PdfSummary, PresentationSummary } from './previewTypes'

export type RenderKind = 'spreadsheet' | 'presentation' | 'pdf' | 'image' | 'tiff' | 'icns' | 'archive' | 'epub' | 'xmind' | 'psd' | 'font' | 'audio' | 'video' | 'email' | 'cur'
export type UrlRenderKind = 'pdf' | 'image' | 'font' | 'audio' | 'video'

export async function renderUrlPayload(payload: UrlPayload, kind: UrlRenderKind): Promise<LoadState> {
  try {
    payload.signal?.throwIfAborted()
    if (kind === 'pdf') {
      const summary = await parsePdf(payload.url, payload.signal)
      return { status: 'ready', content: { kind: 'pdf', objectUrl: payload.url, summary }, stats: [{ label: '页数', value: String(summary.pages) }] }
    }
    if (kind === 'font') return { status: 'ready', content: { kind: 'font', objectUrl: payload.url } }
    return { status: 'ready', content: { kind: 'media', media: kind, objectUrl: payload.url } }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

export async function renderPayload(payload: FilePayload, kind: RenderKind): Promise<LoadState> {
  try {
    return await renderReadyPayload(payload, kind)
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}

async function renderReadyPayload(payload: FilePayload, kind: RenderKind): Promise<LoadState> {
  if (kind === 'cur' || kind === 'psd' || kind === 'xmind') return (await import('./visualFormats')).renderVisual(payload, kind)
  if (kind === 'spreadsheet') {
    return renderSpreadsheet(payload)
  }

  if (kind === 'presentation') {
    if (['odp', 'otp', 'fodp'].includes(payload.extension ?? '')) return renderOpenDocument(payload, 'presentation')
    const presentation = await parsePresentation(payload.bytes)
    return {
      status: 'ready',
      content: { kind: 'presentation', slides: presentation.slides, source: payload.bytes },
      stats: [
        { label: '幻灯片', value: String(presentation.slides.length) },
        { label: '备注', value: String(presentation.slides.filter((slide) => slide.notes).length) },
      ],
    }
  }

  if (kind === 'archive') {
    return (await import('./archiveRenderer')).renderArchivePayload(payload)
  }

  if (kind === 'epub') return (await import('./bookRenderer')).renderBook(payload)
  if (kind === 'email') return (await import('./emailRenderer')).renderEmail(payload)
  if (kind === 'audio' || kind === 'video') {
    const formats = kind === 'audio' ? audioFormats : videoFormats
    return { status: 'ready', content: { kind: 'media', media: kind, objectUrl: bytesToObjectUrl(payload.bytes, formats[payload.extension ?? ''] ?? payload.mime) } }
  }

  if (kind === 'tiff') {
    const tiff = await decodeTiff(payload.bytes)
    return {
      status: 'ready',
      content: { kind: 'media', media: 'tiff', objectUrl: tiff.objectUrl },
      stats: [
        { label: '尺寸', value: `${tiff.width} x ${tiff.height}` },
        { label: '页数', value: String(tiff.pages) },
      ],
    }
  }

  if (kind === 'icns') {
    const icns = decodeIcns(payload.bytes)
    return {
      status: 'ready',
      content: { kind: 'media', media: 'icns', objectUrl: icns.objectUrl },
      stats: [
        { label: '图标块', value: String(icns.entries) },
        { label: '选中类型', value: icns.type },
        { label: '图标大小', value: formatBytes(icns.size) },
      ],
    }
  }

  if (kind === 'pdf') {
    const pdf = await parsePdf(payload.bytes)
    return {
      status: 'ready',
      content: { kind: 'pdf', objectUrl: bytesToObjectUrl(payload.bytes, payload.mime), summary: pdf },
      stats: [
        { label: '页数', value: String(pdf.pages) },
        { label: '文本字符', value: String(pdf.text.length) },
      ],
    }
  }

  if (kind === 'image') {
    return {
      status: 'ready',
      content: { kind: 'media', media: 'image', objectUrl: bytesToObjectUrl(payload.bytes, payload.mime) },
      stats: [{ label: '渲染', value: kind.toUpperCase() }],
    }
  }

  if (kind === 'font') {
    return {
      status: 'ready',
      content: { kind: 'font', objectUrl: bytesToObjectUrl(payload.bytes, payload.mime) },
      stats: [{ label: '渲染', value: kind.toUpperCase() }],
    }
  }

  throw new Error(`Unsupported binary viewer: ${kind satisfies never}`)
}

async function parsePresentation(bytes: Uint8Array): Promise<PresentationSummary> {
  const { default: JSZip } = await import('jszip')
  const zip = await JSZip.loadAsync(bytesToArrayBuffer(bytes))
  const manifest = await zip.file('ppt/presentation.xml')?.async('text')
  const relations = await presentationRelations(zip, 'ppt/presentation.xml')
  const order = manifest ? Array.from(new DOMParser().parseFromString(manifest, 'application/xml').getElementsByTagNameNS('*', 'sldId'))
    .map((element) => relations.find((relation) => relation.id === element.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id'))?.path)
    .filter((path): path is string => !!path) : []
  const slideNames = order.length ? order : Object.keys(zip.files).filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name)).sort(naturalSort)
  const slides = await Promise.all(slideNames.map(async (name, index) => {
    const xml = await zip.files[name].async('text')
    const slideNumber = Number.parseInt(name.match(/slide(\d+)\.xml$/)?.[1] ?? String(index + 1), 10)
    const notesRelation = (await presentationRelations(zip, name)).find((relation) => relation.type.endsWith('/notesSlide'))
    const notes = await zip.file(notesRelation?.path ?? `ppt/notesSlides/notesSlide${slideNumber}.xml`)?.async('text') ?? ''
    const text = extractXmlText(xml)
    const lines = text.split(/\s{2,}|\n/).map((line) => line.trim()).filter(Boolean)
    return {
      index: index + 1,
      title: lines[0] ?? `Slide ${index + 1}`,
      text,
      notes: extractXmlText(notes),
    }
  }))
  return { slides }
}

async function presentationRelations(zip: JSZip, part: string): Promise<Array<{ id: string; type: string; path: string }>> {
  const split = part.lastIndexOf('/')
  const xml = await zip.file(`${part.slice(0, split)}/_rels/${part.slice(split + 1)}.rels`)?.async('text')
  if (!xml) return []
  return Array.from(new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('*', 'Relationship'))
    .filter((element) => element.getAttribute('TargetMode') !== 'External')
    .map((element) => ({ id: element.getAttribute('Id') ?? '', type: element.getAttribute('Type') ?? '', path: new URL(element.getAttribute('Target') ?? '', `https://preview.invalid/${part}`).pathname.slice(1) }))
}

async function parsePdf(source: Uint8Array | string, signal?: AbortSignal): Promise<PdfSummary> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs')
  if (typeof Worker !== 'undefined') pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
  signal?.throwIfAborted()
  const task = pdfjs.getDocument(typeof source === 'string'
    ? { url: source, disableAutoFetch: true, disableStream: true }
    : { data: new Uint8Array(source) })
  const abort = () => { void task.destroy().catch(() => {}) }
  signal?.addEventListener('abort', abort, { once: true })
  try {
    const document = await task.promise
    const pages: string[] = []
    for (let pageNumber = 1; pageNumber <= Math.min(document.numPages, 10); pageNumber += 1) {
      signal?.throwIfAborted()
      const page = await document.getPage(pageNumber)
      const content = await page.getTextContent()
      const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ')
      if (text.trim()) pages.push(text.trim())
    }
    return { pages: document.numPages, text: pages.join('\n\n').slice(0, 20000) }
  } finally {
    signal?.removeEventListener('abort', abort)
    await task.destroy()
  }
}

async function renderSpreadsheet(payload: FilePayload): Promise<LoadState> {
  if (payload.extension === 'csv' || payload.extension === 'tsv') {
    const { default: Papa } = await import('papaparse')
    const parsed = Papa.parse<string[]>(bytesToText(payload.bytes), {
      delimiter: payload.extension === 'tsv' ? '\t' : ',',
      skipEmptyLines: 'greedy',
    })
    if (parsed.errors.length > 0 && parsed.data.length === 0) throw new Error(parsed.errors[0].message)
    const rows = parsed.data.slice(0, 1000)
    const name = payload.extension.toUpperCase()
    return {
      status: 'ready',
      content: { kind: 'sheet', tables: [{ name, rows }] },
      stats: [
        { label: '行数', value: String(rows.length) },
        { label: '列数', value: String(maxColumns(rows)) },
      ],
    }
  }

  if (['ods', 'ots', 'fods'].includes(payload.extension ?? '')) return renderOpenDocument(payload, 'spreadsheet')

  if (payload.extension === 'xls') {
    const workbook = await parseLegacyXls(payload.bytes)
    if (workbook.rows.length > 0) {
      return {
        status: 'ready',
        content: { kind: 'sheet', tables: [{ name: workbook.sheets[0] ?? 'Sheet 1', rows: workbook.rows }] },
        stats: [
          { label: 'Sheet', value: String(workbook.sheets.length) },
          { label: '首表行数', value: String(workbook.rows.length) },
          { label: '首表列数', value: String(maxColumns(workbook.rows)) },
        ],
      }
    }
    return { status: 'ready', content: { kind: 'unsupported' } }
  }

  const { default: ExcelJS } = await import('exceljs')
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytesToArrayBuffer(payload.bytes))
  const tables = workbook.worksheets.map((sheet) => ({ name: sheet.name, rows: worksheetRows(sheet) }))
  const first = tables[0]
  return {
    status: 'ready',
    content: { kind: 'sheet', tables },
    stats: [
      { label: 'Sheet', value: String(tables.length) },
      { label: '首表行数', value: String(first?.rows.length ?? 0) },
      { label: '首表列数', value: String(maxColumns(first?.rows ?? [])) },
    ],
  }
}

function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true })
}

function extractXmlText(xml: string): string {
  return Array.from(xml.matchAll(/<a:t\b[^>]*>([\s\S]*?)<\/a:t>/g))
    .map((match) => decodeXml(stripXml(match[1])).trim())
    .filter(Boolean)
    .join('\n')
}

async function parseLegacyXls(bytes: Uint8Array): Promise<{ sheets: string[]; rows: string[][] }> {
  const CFB = await import('cfb')
  const cfb = CFB.read(bytes, { type: 'array' })
  const workbookEntry = cfb.FileIndex.find((entry) => /(^|\/)(Workbook|Book)$/.test(entry.name) && entry.content)
  if (!workbookEntry?.content) return { sheets: [], rows: [] }

  const workbookBytes = new Uint8Array(workbookEntry.content)
  const globals = parseBiffGlobals(workbookBytes)
  const firstSheet = globals.sheets[0]
  if (!firstSheet) return { sheets: globals.sheets.map((sheet) => sheet.name), rows: [] }

  return {
    sheets: globals.sheets.map((sheet) => sheet.name),
    rows: parseBiffSheet(workbookBytes, firstSheet.offset, globals.sharedStrings),
  }
}

function parseBiffGlobals(bytes: Uint8Array): { sheets: Array<{ name: string; offset: number }>; sharedStrings: string[] } {
  const sheets: Array<{ name: string; offset: number }> = []
  const sharedStrings: string[] = []
  for (const record of biffRecords(bytes, 0)) {
    if (record.id === 0x0085 && record.data.length >= 8) {
      const offset = readLeU32(record.data, 0)
      const length = record.data[6]
      const flags = record.data[7] ?? 0
      const name = readBiffString(record.data, 8, length, flags)
      sheets.push({ name: name || `Sheet ${sheets.length + 1}`, offset })
    }
    if (record.id === 0x00fc && record.data.length >= 8) {
      let cursor = 8
      while (cursor + 3 <= record.data.length) {
        const length = readLeU16(record.data, cursor)
        const flags = record.data[cursor + 2] ?? 0
        cursor += 3
        const byteLength = length * ((flags & 1) ? 2 : 1)
        if (cursor + byteLength > record.data.length) break
        sharedStrings.push(readBiffString(record.data, cursor, length, flags))
        cursor += byteLength
      }
    }
    if (record.id === 0x000a && sheets.length > 0) break
  }
  return { sheets, sharedStrings }
}

function parseBiffSheet(bytes: Uint8Array, start: number, sharedStrings: string[]): string[][] {
  const rows = new Map<number, Map<number, string>>()
  for (const record of biffRecords(bytes, start)) {
    if (record.id === 0x00fd && record.data.length >= 10) {
      setCell(rows, readLeU16(record.data, 0), readLeU16(record.data, 2), sharedStrings[readLeU32(record.data, 6)] ?? '')
    }
    if (record.id === 0x0203 && record.data.length >= 14) {
      setCell(rows, readLeU16(record.data, 0), readLeU16(record.data, 2), String(new DataView(record.data.buffer, record.data.byteOffset + 6, 8).getFloat64(0, true)))
    }
    if (record.id === 0x000a) break
  }
  return mapRows(rows)
}

function biffRecords(bytes: Uint8Array, start: number): Array<{ id: number; data: Uint8Array }> {
  const records: Array<{ id: number; data: Uint8Array }> = []
  let offset = start
  while (offset + 4 <= bytes.length && records.length < 20000) {
    const id = readLeU16(bytes, offset)
    const length = readLeU16(bytes, offset + 2)
    if (offset + 4 + length > bytes.length) break
    records.push({ id, data: bytes.slice(offset + 4, offset + 4 + length) })
    offset += 4 + length
  }
  return records
}

function readBiffString(bytes: Uint8Array, offset: number, length: number, flags: number): string {
  if (length <= 0) return ''
  const byteLength = length * ((flags & 1) ? 2 : 1)
  const slice = bytes.slice(offset, offset + byteLength)
  if (flags & 1) return new TextDecoder('utf-16le').decode(slice)
  return new TextDecoder('latin1').decode(slice)
}

function setCell(rows: Map<number, Map<number, string>>, row: number, column: number, value: string): void {
  if (row >= 500 || column >= 100) return
  const target = rows.get(row) ?? new Map<number, string>()
  target.set(column, value)
  rows.set(row, target)
}

function mapRows(rows: Map<number, Map<number, string>>): string[][] {
  const rowIndexes = Array.from(rows.keys()).sort((a, b) => a - b)
  return rowIndexes.map((rowIndex) => {
    const row = rows.get(rowIndex) ?? new Map<number, string>()
    const width = Math.max(...Array.from(row.keys()), 0) + 1
    return Array.from({ length: width }, (_, column) => row.get(column) ?? '')
  })
}

function readLeU16(bytes: Uint8Array, offset: number): number {
  return bytes[offset] | (bytes[offset + 1] << 8)
}

function readLeU32(bytes: Uint8Array, offset: number): number {
  return (bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24)) >>> 0
}

async function decodeTiff(source: Uint8Array): Promise<{ objectUrl: string; width: number; height: number; pages: number }> {
  const { default: UTIF } = await import('utif')
  const bytes = bytesToArrayBuffer(source)
  const ifds = UTIF.decode(bytes)
  if (ifds.length === 0) {
    throw new Error('TIFF 文件没有可解码页面')
  }

  const first = ifds[0]
  UTIF.decodeImage(bytes, first)
  const rgba = UTIF.toRGBA8(first)
  const width = first.width
  const height = first.height
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d')
  if (!context) throw new Error('无法创建 TIFF 渲染上下文')
  context.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0)
  return {
    objectUrl: canvas.toDataURL('image/png'),
    width,
    height,
    pages: ifds.length,
  }
}

function decodeIcns(bytes: Uint8Array): { objectUrl: string; type: string; size: number; entries: number } {
  if (ascii(bytes, 0, 4) !== 'icns') {
    throw new Error('不是有效的 ICNS 文件')
  }

  let offset = 8
  const candidates: Array<{ type: string; data: Uint8Array }> = []
  let entries = 0

  while (offset + 8 <= bytes.length) {
    const type = ascii(bytes, offset, 4)
    const length = readU32(bytes, offset + 4)
    if (length < 8 || offset + length > bytes.length) break
    const data = bytes.slice(offset + 8, offset + length)
    entries += 1
    if (isPng(data) || isJpeg(data)) candidates.push({ type, data })
    offset += length
  }

  const selected = candidates.sort((a, b) => b.data.length - a.data.length)[0]
  if (!selected) {
    throw new Error('ICNS 中没有可直接预览的 PNG/JPEG 图标块')
  }

  const mime = isPng(selected.data) ? 'image/png' : 'image/jpeg'
  const imageBuffer = new ArrayBuffer(selected.data.byteLength)
  new Uint8Array(imageBuffer).set(selected.data)
  const objectUrl = URL.createObjectURL(new Blob([imageBuffer], { type: mime }))
  return { objectUrl, type: selected.type, size: selected.data.length, entries }
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.slice(offset, offset + length))
}

function readU32(bytes: Uint8Array, offset: number): number {
  return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) | (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0
}

function isPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes[0] === 0x89 && ascii(bytes, 1, 3) === 'PNG'
}

function isJpeg(bytes: Uint8Array): boolean {
  return bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
}

function maxColumns(rows: string[][]): number {
  return rows.reduce((max, row) => Math.max(max, row.length), 0)
}

function worksheetRows(sheet: ExcelJS.Worksheet): string[][] {
  const rows: string[][] = []
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= 500) return
    const values = Array.isArray(row.values) ? row.values.slice(1) : []
    rows.push(values.map((value) => cellToString(value)))
  })
  return rows
}

function cellToString(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toLocaleString()
  if (typeof value === 'object') {
    if ('text' in value && typeof value.text === 'string') return value.text
    if ('result' in value) return cellToString(value.result as ExcelJS.CellValue)
    if ('richText' in value && Array.isArray(value.richText)) {
      return value.richText.map((part) => part.text).join('')
    }
    return JSON.stringify(value)
  }
  return String(value)
}
