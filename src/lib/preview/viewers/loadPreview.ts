import { resolveViewer } from './registry'
import { extensionOf } from '../lib/format'
import type { FileMetadata } from '../types'
import type { LoadState } from './previewTypes'

export async function loadPreview(metadata: FileMetadata, url: string, signal: AbortSignal, fetchFile: typeof fetch = fetch): Promise<LoadState> {
  signal.throwIfAborted()
  const payload = { ...metadata, extension: extensionOf(metadata.name) }
  const viewer = resolveViewer(payload.name)
  if (viewer.loadUrl) return viewer.loadUrl({ ...payload, url, signal })
  const response = await fetchFile(url, { signal })
  if (!response.ok) throw new Error('文件读取失败，请关闭预览后重试。')
  const bytes = new Uint8Array(await response.arrayBuffer())
  signal.throwIfAborted()
  return viewer.load({ ...payload, bytes })
}
