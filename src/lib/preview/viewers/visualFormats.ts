import type { FilePayload } from '../types'
import type { LoadState } from './previewTypes'
import type { NodeObj } from 'mind-elixir'
import type { Layer } from 'ag-psd'
import { bytesToArrayBuffer } from '../lib/bytes'

export async function renderVisual(payload: FilePayload, kind: 'cur' | 'psd' | 'xmind'): Promise<LoadState> {
  if (kind === 'cur') {
    const { decodeIco } = await import('icojs')
    const images = await decodeIco(bytesToArrayBuffer(payload.bytes), 'image/png')
    const selected = images.sort((a, b) => b.width * b.height - a.width * a.height)[0]
    if (!selected) throw new Error('未找到可解码的指针图片')
    return { status: 'ready', content: { kind: 'media', media: 'image', objectUrl: URL.createObjectURL(new Blob([selected.buffer], { type: 'image/png' })) } }
  }
  if (kind === 'psd') {
    const { readPsd } = await import('ag-psd')
    const psd = readPsd(payload.bytes, { skipLayerImageData: true, skipThumbnail: true })
    if (!psd.canvas) throw new Error('此 PSD 未保存合成图，无法显示画面')
    const blob = await new Promise<Blob>((resolve, reject) => psd.canvas!.toBlob((value) => value ? resolve(value) : reject(new Error('无法生成 PSD 预览')), 'image/png'))
    const layers = flattenLayers(psd.children ?? [])
    return { status: 'ready', content: { kind: 'psd', objectUrl: URL.createObjectURL(blob), summary: { width: psd.width, height: psd.height, layerCount: layers.length, layers } } }
  }
  const { importXMindFile, convertXmindToMindElixir } = await import('@mind-elixir/import-xmind')
  const source = await importXMindFile(new File([bytesToArrayBuffer(payload.bytes)], payload.name))
  if (source.length === 0) throw new Error('未找到思维导图')
  const sheets = source.map((sheet) => {
    const converted = convertXmindToMindElixir(sheet)
    return { title: sheet.title, data: { nodeData: plainMindNode(converted.nodeData) } }
  })
  return { status: 'ready', content: { kind: 'xmind', sheets } }
}

function plainMindNode(node: NodeObj): NodeObj {
  return { id: node.id, topic: node.topic, expanded: node.expanded, children: node.children?.map(plainMindNode) }
}

function flattenLayers(layers: Layer[]): string[] {
  return layers.flatMap((layer) => [layer.name ?? '(未命名图层)', ...flattenLayers(layer.children ?? [])])
}
