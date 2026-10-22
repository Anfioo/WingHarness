import { useEffect, useRef, useState } from 'react'
import type { PPTXViewer } from 'pptxviewjs'
import { presentationEngine } from './presentationEngine'
import type { PreviewContent } from './previewTypes'

export default function SlidesPreview({ content }: { content: Extract<PreviewContent, { kind: 'presentation' }> }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const stage = useRef<HTMLDivElement>(null)
  const renderQueue = useRef(Promise.resolve())
  const [width, setWidth] = useState(1280)
  const [viewer, setViewer] = useState<PPTXViewer>()
  const [page, setPage] = useState(0)
  const [count, setCount] = useState(0)
  const [zoom, setZoom] = useState(1)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(true)
  useEffect(() => {
    let active = true
    let next: PPTXViewer | undefined
    presentationEngine().then(async ({ PPTXViewer }) => {
      if (!active) return
      const instance = new PPTXViewer({ canvas: canvas.current, slideSizeMode: 'fit', backgroundColor: '#ffffff', autoChartRerenderDelayMs: 0 })
      next = instance
      await instance.loadFile(content.source!)
      if (!active) return
      if (!instance.getSlideCount()) throw new Error('此文件中未找到可渲染的幻灯片')
      setCount(instance.getSlideCount())
      setViewer(instance)
    }).catch((reason: unknown) => { if (active) { setError(String(reason)); setBusy(false) } })
    return () => { active = false; next?.destroy() }
  }, [content.source])
  useEffect(() => {
    const element = stage.current!
    const resize = () => setWidth(Math.max(320, element.clientWidth - 40))
    const observer = new ResizeObserver(resize)
    observer.observe(element)
    resize()
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!viewer || !canvas.current) return
    let active = true
    setBusy(true)
    renderQueue.current = renderQueue.current.then(async () => {
      if (active && canvas.current) await viewer.goToSlide(page, canvas.current)
    }).catch((reason: unknown) => { if (active) setError(String(reason)) }).finally(() => { if (active) setBusy(false) })
    return () => { active = false }
  }, [viewer, page, width, zoom])
  return <div className="visual-slides" data-preview-ready={!busy}>
    <div className="preview-toolbar">
      <button disabled={busy || page === 0} onClick={() => setPage(page - 1)}>上一页</button>
      <span>{count ? `${page + 1} / ${count}` : '正在读取...'}</span>
      <button disabled={busy || page + 1 >= count} onClick={() => setPage(page + 1)}>下一页</button>
      <button disabled={zoom <= 0.5} onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}>缩小</button>
      <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
      <button disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}>放大</button>
    </div>
    {error && <div className="error-view">{error}</div>}
    <div ref={stage} className="slide-stage"><canvas ref={canvas} width={1280} height={720} style={{ width: width * zoom, height: width * zoom * 9 / 16 }} aria-label={`第 ${page + 1} 页幻灯片`} /></div>
    {content.slides[page]?.notes && <details><summary>备注</summary><pre>{content.slides[page].notes}</pre></details>}
  </div>
}
