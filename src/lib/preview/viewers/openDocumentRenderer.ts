import JSZip from 'jszip'
import { bytesToArrayBuffer, bytesToText } from '../lib/bytes'
import { escapeHtml, parseXmlDocument } from '../lib/xml'
import type { FilePayload } from '../types'
import type { LoadState } from './previewTypes'

const ns = {
  office: 'urn:oasis:names:tc:opendocument:xmlns:office:1.0',
  text: 'urn:oasis:names:tc:opendocument:xmlns:text:1.0',
  table: 'urn:oasis:names:tc:opendocument:xmlns:table:1.0',
  draw: 'urn:oasis:names:tc:opendocument:xmlns:drawing:1.0',
  presentation: 'urn:oasis:names:tc:opendocument:xmlns:presentation:1.0',
}

function textContent(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? ''
  if (node instanceof Element && node.namespaceURI === ns.text) {
    if (node.localName === 's') return ' '.repeat(Math.min(Number(node.getAttributeNS(ns.text, 'c')) || 1, 1000))
    if (node.localName === 'tab') return '\t'
    if (node.localName === 'line-break') return '\n'
  }
  return Array.from(node.childNodes).map(textContent).join('')
}

function paragraphs(element: Element): Element[] {
  return Array.from(element.getElementsByTagNameNS(ns.text, '*')).filter(node => node.localName === 'p' || node.localName === 'h')
}

function repeated(element: Element, name: string, limit: number): number {
  const count = Number(element.getAttributeNS(ns.table, name)) || 1
  return Math.max(1, Math.min(Math.floor(count), limit))
}

export async function renderOpenDocument(payload: FilePayload, kind: 'text' | 'spreadsheet' | 'presentation'): Promise<LoadState> {
  const zipped = payload.bytes[0] === 0x50 && payload.bytes[1] === 0x4b
  const xml = zipped ? await (await JSZip.loadAsync(bytesToArrayBuffer(payload.bytes))).file('content.xml')?.async('text') : bytesToText(payload.bytes)
  if (!xml) throw new Error('文档缺少正文')
  const document = parseXmlDocument(xml)
  const body = document.getElementsByTagNameNS(ns.office, 'body')[0]
  const content = body && Array.from(body.children).find(node => node.namespaceURI === ns.office && node.localName === kind)
  if (!content) throw new Error('文档内容与格式不符')

  if (kind === 'text') {
    const outline: Array<{ level: number; text: string }> = []
    const html = paragraphs(content).map(node => {
      const text = textContent(node)
      const level = Math.max(1, Math.min(Number(node.getAttributeNS(ns.text, 'outline-level')) || 1, 6))
      if (node.localName === 'h') outline.push({ level, text })
      const tag = node.localName === 'h' ? `h${level}` : 'p'
      return `<${tag}>${escapeHtml(text)}</${tag}>`
    }).join('')
    return { status: 'ready', content: { kind: 'word', html, outline } }
  }

  if (kind === 'presentation') {
    const pages = Array.from(content.getElementsByTagNameNS(ns.draw, 'page'))
    if (!pages.length) throw new Error('文档没有幻灯片')
    const slides = pages.map((page, index) => {
      const notes = Array.from(page.getElementsByTagNameNS(ns.presentation, 'notes'))
      const noteText = notes.flatMap(note => paragraphs(note).map(textContent)).join('\n')
      notes.forEach(note => note.remove())
      const text = paragraphs(page).map(textContent).join('\n')
      const titleFrame = Array.from(page.getElementsByTagNameNS(ns.draw, 'frame')).find(frame => frame.getAttributeNS(ns.presentation, 'class') === 'title')
      const title = (titleFrame && paragraphs(titleFrame).map(textContent).join(' ')) || page.getAttributeNS(ns.draw, 'name') || `幻灯片 ${index + 1}`
      return { index: index + 1, title, text, notes: noteText }
    })
    return { status: 'ready', content: { kind: 'presentation', slides } }
  }

  const tables = Array.from(content.getElementsByTagNameNS(ns.table, 'table')).map((table, index) => {
    const rows: string[][] = []
    for (const row of Array.from(table.getElementsByTagNameNS(ns.table, 'table-row'))) {
      if (rows.length >= 500) break
      const cells: string[] = []
      for (const cell of Array.from(row.children).filter(node => node.namespaceURI === ns.table && ['table-cell', 'covered-table-cell'].includes(node.localName))) {
        if (cells.length >= 100) break
        const value = paragraphs(cell).map(textContent).join('\n') || cell.getAttributeNS(ns.office, 'value') || cell.getAttributeNS(ns.office, 'date-value') || cell.getAttributeNS(ns.office, 'boolean-value') || ''
        cells.push(...Array<string>(repeated(cell, 'number-columns-repeated', 100 - cells.length)).fill(value))
      }
      rows.push(...Array<string[]>(repeated(row, 'number-rows-repeated', 500 - rows.length)).fill(cells))
    }
    return { name: table.getAttributeNS(ns.table, 'name') || `Sheet ${index + 1}`, rows }
  })
  if (!tables.length) throw new Error('文档没有工作表')
  return { status: 'ready', content: { kind: 'sheet', tables } }
}
