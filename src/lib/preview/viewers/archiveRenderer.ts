import unrarWasmUrl from 'node-unrar-js/esm/js/unrar.wasm?url'
import sevenZipWasmUrl from '7z-wasm/7zz.wasm?url'
import { bytesToArrayBuffer } from '../lib/bytes'
import type { FilePayload } from '../types'
import type { ArchiveItem, LoadState } from './previewTypes'

export async function renderArchivePayload(payload: FilePayload): Promise<LoadState> {
  const items = await parseArchive(payload)
  return {
    status: 'ready',
    content: { kind: 'archive', items: items.slice(0, 1000) },
    stats: [
      { label: '文件', value: String(items.filter((item) => !item.directory).length) },
      { label: '目录', value: String(items.filter((item) => item.directory).length) },
    ],
  }
}

async function parseArchive(payload: FilePayload): Promise<ArchiveItem[]> {
  if (payload.extension === 'tar' || payload.extension === 'tgz' || payload.extension === 'tar.gz') {
    return parseTarArchive(payload.bytes, payload.extension !== 'tar')
  }
  if (payload.extension === '7z') return parse7zArchive(payload.bytes)
  if (payload.extension === 'rar') return parseRarArchive(payload.bytes)
  return parseZipArchive(payload.extension === 'crx' ? crxZip(payload.bytes) : payload.bytes)
}

function crxZip(bytes: Uint8Array): Uint8Array {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 4)) !== 'Cr24') throw new Error('无效的 CRX 文件头')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const version = view.getUint32(4, true)
  if (version !== 2 && version !== 3) throw new Error('不支持此 CRX 版本')
  if (version === 2 && bytes.length < 16) throw new Error('CRX 文件头不完整')
  const offset = version === 2 ? 16 + view.getUint32(8, true) + view.getUint32(12, true) : 12 + view.getUint32(8, true)
  if (offset + 4 > bytes.length || view.getUint32(offset, true) !== 0x04034b50) throw new Error('CRX 中未找到 ZIP 内容')
  return bytes.subarray(offset)
}

async function parseZipArchive(bytes: Uint8Array): Promise<ArchiveItem[]> {
  const { unzipSync } = await import('fflate')
  const items: ArchiveItem[] = []
  const extracted = unzipSync(bytes, {
    filter: (file) => {
      const directory = file.name.endsWith('/')
      items.push({ name: file.name, directory, size: directory ? undefined : file.originalSize })
      return !directory && canPreviewArchiveEntry(file.name, file.originalSize)
    },
  })
  return items.map((item) => {
    const content = extracted[item.name]
    return content ? { ...item, preview: archiveEntryPreview(item.name, content) } : item
  })
}

async function parse7zArchive(bytes: Uint8Array): Promise<ArchiveItem[]> {
  const { default: SevenZip } = await import('7z-wasm')
  const output: string[] = []
  const errors: string[] = []
  const sevenZip = await SevenZip({
    locateFile: () => sevenZipWasmUrl,
    print: (value) => output.push(value),
    printErr: (value) => errors.push(value),
  })
  sevenZip.FS.writeFile('archive.7z', bytes)
  sevenZip.callMain(['l', 'archive.7z'])
  const items = parse7zListing(output.join('\n'))
  if (items.length === 0 && errors.length > 0) throw new Error(errors.join('\n'))
  return items
}

function parse7zListing(listing: string): ArchiveItem[] {
  const items: ArchiveItem[] = []
  let inRows = false
  for (const line of listing.split(/\r?\n/)) {
    if (/^-{10,}/.test(line.trim())) {
      inRows = !inRows
      continue
    }
    if (!inRows || !/^\d{4}-\d{2}-\d{2}/.test(line)) continue
    const match = line.match(/^\S+\s+\S+\s+([D.][^\s]*)\s+(\d+)?\s+(\d+)?\s+(.+)$/)
    if (!match) continue
    const directory = match[1].startsWith('D')
    const size = match[2] ? Number.parseInt(match[2], 10) : undefined
    const name = match[4].trim()
    if (name) items.push({ name, directory, size: directory ? undefined : size })
  }
  return items
}

async function parseRarArchive(bytes: Uint8Array): Promise<ArchiveItem[]> {
  const { createExtractorFromData } = await import('node-unrar-js/esm/index.esm.js')
  const wasmBinary = await fetch(unrarWasmUrl).then((response) => response.arrayBuffer())
  const extractor = await createExtractorFromData({ wasmBinary, data: bytesToArrayBuffer(bytes) })
  const list = extractor.getFileList()
  return Array.from(list.fileHeaders).map((header) => ({
    name: header.name,
    directory: header.flags.directory,
    size: header.flags.directory ? undefined : header.unpSize,
  }))
}

async function parseTarArchive(source: Uint8Array, gzipped: boolean): Promise<ArchiveItem[]> {
  const bytes = gzipped ? (await import('fflate')).gunzipSync(source) : source
  const items: ArchiveItem[] = []
  let offset = 0
  while (offset + 512 <= bytes.length) {
    const header = bytes.slice(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const rawName = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const name = prefix ? `${prefix}/${rawName}` : rawName
    const size = Number.parseInt(readTarString(header, 124, 12).trim() || '0', 8)
    const directory = String.fromCharCode(header[156] || 48) === '5' || name.endsWith('/')
    if (name) {
      const content = !directory && canPreviewArchiveEntry(name, size) ? bytes.slice(offset + 512, offset + 512 + size) : undefined
      items.push({ name, directory, size: directory ? undefined : size, preview: content ? archiveEntryPreview(name, content) : undefined })
    }
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return items
}

function archiveEntryPreview(name: string, bytes: Uint8Array): ArchiveItem['preview'] {
  if (!canPreviewArchiveEntry(name, bytes.length)) return undefined
  const mime = archiveEntryMime(name)
  if (mime.startsWith('image/')) {
    const buffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(buffer).set(bytes)
    return { kind: 'image', objectUrl: URL.createObjectURL(new Blob([buffer], { type: mime })), mime }
  }
  if (isTextArchiveEntry(name)) return { kind: 'text', text: new TextDecoder().decode(bytes).slice(0, 20000), mime }
  return { kind: 'unsupported', message: '该条目暂不支持内嵌预览，可使用系统压缩包工具打开。' }
}

function canPreviewArchiveEntry(name: string, size: number): boolean {
  return size <= 1024 * 1024 && (isTextArchiveEntry(name) || archiveEntryMime(name).startsWith('image/'))
}

function isTextArchiveEntry(name: string): boolean {
  return matchesArchiveExtension(name, ['txt', 'md', 'markdown', 'json', 'csv', 'tsv', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'tsx', 'jsx', 'yaml', 'yml', 'toml', 'log'])
}

function archiveEntryMime(name: string): string {
  if (matchesArchiveExtension(name, ['png'])) return 'image/png'
  if (matchesArchiveExtension(name, ['jpg', 'jpeg'])) return 'image/jpeg'
  if (matchesArchiveExtension(name, ['gif'])) return 'image/gif'
  if (matchesArchiveExtension(name, ['webp'])) return 'image/webp'
  if (matchesArchiveExtension(name, ['bmp'])) return 'image/bmp'
  if (matchesArchiveExtension(name, ['json'])) return 'application/json'
  if (matchesArchiveExtension(name, ['md', 'markdown'])) return 'text/markdown'
  if (matchesArchiveExtension(name, ['html', 'htm'])) return 'text/html'
  if (matchesArchiveExtension(name, ['csv'])) return 'text/csv'
  if (matchesArchiveExtension(name, ['tsv'])) return 'text/tab-separated-values'
  return 'text/plain'
}

function matchesArchiveExtension(name: string, extensions: string[]): boolean {
  const lower = name.toLowerCase()
  return extensions.some((extension) => lower.endsWith(`.${extension}`))
}

function readTarString(bytes: Uint8Array, offset: number, length: number): string {
  const slice = bytes.slice(offset, offset + length)
  const end = slice.indexOf(0)
  return new TextDecoder().decode(end >= 0 ? slice.slice(0, end) : slice).trim()
}
