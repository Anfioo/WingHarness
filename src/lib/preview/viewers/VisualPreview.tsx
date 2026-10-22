import { lazy } from 'react'
import './visualPreview.css'
import type { PreviewContent } from './previewTypes'

const Slides = lazy(() => import('./SlidesPreview'))
const MindMap = lazy(() => import('./MindMapPreview'))

type VisualContent = Extract<PreviewContent, { kind: 'presentation' | 'psd' | 'xmind' }>

export default function VisualPreview({ content }: { content: VisualContent }) {
  if (content.kind === 'presentation') return <Slides content={content} />
  if (content.kind === 'xmind') return <MindMap content={content} />
  return <div className="psd-layout">
    <div className="psd-image"><img src={content.objectUrl} alt="PSD 合成图" /></div>
    <aside><p>{content.summary.width} × {content.summary.height} px</p><h2>图层（{content.summary.layerCount}）</h2>
      <ul>{content.summary.layers.map((name, index) => <li key={index}>{name}</li>)}</ul>
    </aside>
  </div>
}
