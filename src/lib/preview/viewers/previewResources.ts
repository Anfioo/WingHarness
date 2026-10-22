import type { LoadState } from './previewTypes'

export function objectUrlsFrom(state: LoadState): string[] {
  if (state.status !== 'ready') return []
  const urls = new Set<string>()
  const content = state.content
  if ((content.kind === 'media' || content.kind === 'pdf' || content.kind === 'font' || content.kind === 'psd') && content.objectUrl.startsWith('blob:')) {
    urls.add(content.objectUrl)
  }
  if (content.kind !== 'archive') return [...urls]
  for (const item of content.items) {
    if (item.preview?.kind === 'image' && item.preview.objectUrl.startsWith('blob:')) {
      urls.add(item.preview.objectUrl)
    }
  }
  return [...urls]
}
