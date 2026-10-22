import { renderOpenDocument } from './openDocumentRenderer'
import JSZip from 'jszip'
import mammoth from 'mammoth'
import { bytesToArrayBuffer, bytesToText } from '../lib/bytes'
import { decodeXml, stripXml } from '../lib/xml'
import type { FilePayload } from '../types'
import { sanitizeHtml } from './html'
import type { LoadState, WordSummary } from './previewTypes'

export { sanitizeHtml } from './html'

export async function renderWordPayload(payload: FilePayload): Promise<LoadState> {
  if (['odt', 'ott', 'fodt'].includes(payload.extension ?? '')) return renderOpenDocument(payload, 'text')

  if (payload.extension === 'rtf') {
    const rtf = parseRtf(bytesToText(payload.bytes))
    return {
      status: 'ready',
      content: { kind: 'word', html: sanitizeHtml(rtf.html), outline: rtf.outline },
      stats: [
        { label: '段落', value: String(rtf.paragraphs) },
        { label: '标题', value: String(rtf.outline.length) },
      ],
    }
  }

  const source = typeof Buffer === 'undefined'
    ? { arrayBuffer: bytesToArrayBuffer(payload.bytes) }
    : { buffer: Buffer.from(payload.bytes) }
  const result = await mammoth.convertToHtml(source)
  const word = await parseWordSummary(payload.bytes)
  return {
    status: 'ready',
    content: { kind: 'word', html: sanitizeHtml(result.value), outline: word.outline },
    stats: [
      { label: '段落', value: String(countMatches(result.value, /<p[\s>]/g)) },
      { label: '图片', value: String(countMatches(result.value, /<img[\s>]/g)) },
      { label: '标题', value: String(word.outline.length) },
    ],
  }
}

function parseRtf(source: string): { html: string; outline: WordSummary['outline']; paragraphs: number } {
  const blocks = rtfBlocks(source)
  const outline = blocks.flatMap((block) => block.level ? [{ level: block.level, text: block.text }] : [])
  const html = blocks.map((block) => {
    const tag = block.level ? `h${block.level}` : 'p'
    return `<${tag}>${escapeText(block.text)}</${tag}>`
  }).join('')
  return { html: html || '<p>没有找到 RTF 正文。</p>', outline, paragraphs: blocks.filter((block) => !block.level).length }
}

function rtfBlocks(source: string): Array<{ text: string; level?: number }> {
  const tokens = source.match(/\\'[0-9a-fA-F]{2}|\\u-?\d+\??|\\[a-zA-Z]+-?\d* ?|\\.|[{}]|[^\\{}]+/g) ?? []
  const blocks: Array<{ text: string; level?: number }> = []
  let text = ''
  let level: number | undefined
  const push = () => {
    const clean = text.replace(/\s+/g, ' ').trim()
    if (clean) blocks.push({ text: clean, level })
    text = ''
    level = undefined
  }

  for (const token of tokens) {
    if (token === '{' || token === '}') continue
    if (token.startsWith("\\'")) {
      text += String.fromCharCode(Number.parseInt(token.slice(2), 16))
      continue
    }
    const unicode = token.match(/^\\u(-?\d+)/)
    if (unicode) {
      const value = Number.parseInt(unicode[1], 10)
      text += String.fromCharCode(value < 0 ? value + 65536 : value)
      continue
    }
    const style = token.match(/^\\s([1-6])\b/)
    if (style) {
      level = Number.parseInt(style[1], 10)
      continue
    }
    if (/^\\par\b/.test(token)) {
      push()
      continue
    }
    if (token === '\\{' || token === '\\}' || token === '\\\\') {
      text += token.slice(1)
      continue
    }
    if (token.startsWith('\\')) continue
    text += token
  }
  push()
  return blocks.slice(0, 1000)
}

async function parseWordSummary(bytes: Uint8Array): Promise<WordSummary> {
  const zip = await JSZip.loadAsync(bytesToArrayBuffer(bytes))
  const xml = await zip.file('word/document.xml')?.async('text')
  if (!xml) return { outline: [] }

  const paragraphs = Array.from(xml.matchAll(/<w:p\b[^>]*>([\s\S]*?)<\/w:p>/g))
  const outline = paragraphs.flatMap((paragraph) => {
    const text = Array.from(paragraph[1].matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>/g)).map((match) => decodeXml(stripXml(match[1]))).join('')
    const style = paragraph[1].match(/<w:pStyle\b[^>]*w:val="([^"]+)"/)?.[1] ?? ''
    const level = headingLevel(style)
    return level && text.trim() ? [{ level, text: text.trim() }] : []
  })
  return { outline: outline.slice(0, 200) }
}

function headingLevel(style: string): number | undefined {
  const match = style.match(/Heading([1-6])|heading\s*([1-6])/i)
  const value = Number.parseInt(match?.[1] ?? match?.[2] ?? '', 10)
  return Number.isFinite(value) ? value : undefined
}

function escapeText(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function countMatches(value: string, pattern: RegExp): number {
  return Array.from(value.matchAll(pattern)).length
}
