import { marked } from 'marked'
import { detectText } from '../lib/bytes'
import type { FilePayload } from '../types'
import { sanitizeHtml } from './html'
import type { LoadState } from './previewTypes'

export type BasicViewerId = 'markdown' | 'html' | 'svg' | 'json' | 'text' | 'fallback'

export async function renderBasicPayload(payload: FilePayload, viewerId: BasicViewerId): Promise<LoadState> {
  try {
    const bytes = payload.extension === 'svgz' ? (await import('fflate')).gunzipSync(payload.bytes) : payload.bytes
    const text = detectText(bytes)
    if (text === null) return { status: 'ready', content: { kind: 'unsupported' } }
    if (viewerId === 'fallback') return { status: 'ready', content: { kind: 'text', text } }
    if (viewerId === 'markdown') {
      const html = await marked.parse(text, { async: false })
      return {
        status: 'ready',
        content: { kind: 'html', html: sanitizeHtml(html) },
        stats: [
          { label: '行数', value: String(text.split(/\r?\n/).length) },
          { label: '标题', value: String(Array.from(text.matchAll(/^#{1,6}\s/gm)).length) },
        ],
      }
    }
    if (viewerId === 'html') {
      return {
        status: 'ready',
        content: { kind: 'html', html: sanitizeHtml(text, { ADD_ATTR: ['target'] }) },
        stats: [{ label: '元素', value: String(Array.from(text.matchAll(/<[^/!][^>]*>/g)).length) }],
      }
    }
    if (viewerId === 'svg') {
      return {
        status: 'ready',
        content: { kind: 'html', html: `<div class="svg-wrap">${sanitizeHtml(text)}</div>` },
        stats: [{ label: '节点', value: String(Array.from(text.matchAll(/<[^/!][^>]*>/g)).length) }],
      }
    }
    const rendered = viewerId === 'json' && payload.extension === 'json' ? JSON.stringify(JSON.parse(text), null, 2) : text
    return {
      status: 'ready',
      content: { kind: 'text', text: rendered },
      stats: [
        { label: '行数', value: String(rendered.split(/\r?\n/).length) },
        { label: '字符', value: String(rendered.length) },
      ],
    }
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : String(error) }
  }
}
