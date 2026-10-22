import { useEffect, useRef, useState } from 'react'
import MindElixir from 'mind-elixir'
import 'mind-elixir/style.css'
import type { PreviewContent } from './previewTypes'

export default function MindMapPreview({ content }: { content: Extract<PreviewContent, { kind: 'xmind' }> }) {
  const element = useRef<HTMLDivElement>(null)
  const [sheet, setSheet] = useState(0)
  const [error, setError] = useState('')
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (!element.current || !content.sheets[sheet]) return
    const mind = new MindElixir({ el: element.current, editable: false, contextMenu: false, toolBar: true, keypress: false, allowUndo: false })
    setReady(false)
    try { mind.init(structuredClone(content.sheets[sheet].data)); mind.scaleFit(); setReady(true) }
    catch (reason) { setError(String(reason)) }
    return () => { mind.destroy() }
  }, [content, sheet])
  return <div className="mind-view">
    <div className="preview-toolbar">{content.sheets.map((item, index) => <button key={index} aria-pressed={sheet === index} onClick={() => { setError(''); setSheet(index) }}>{item.title || `导图 ${index + 1}`}</button>)}</div>
    {error && <div className="error-view">{error}</div>}
    <div ref={element} className="mind-stage" data-preview-ready={ready} aria-label="思维导图" />
  </div>
}
