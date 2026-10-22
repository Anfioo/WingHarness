import { useState } from 'react'
import type { BookContent, PreviewContent } from './previewTypes'

export function MediaPreview({ content, name }: { content: Extract<PreviewContent, { kind: 'media' }>; name: string }) {
  const [failed, setFailed] = useState(false)
  if (failed) return <div className="empty-view">不支持预览此文件</div>
  const onError = () => setFailed(true)
  return <div className="media-view">
    {content.media === 'audio' ? <audio controls preload="metadata" src={content.objectUrl} aria-label={name} onError={onError} />
      : content.media === 'video' ? <video controls playsInline preload="metadata" src={content.objectUrl} aria-label={name} onError={onError} />
        : <img src={content.objectUrl} alt={name} onError={onError} />}
  </div>
}

export function BookPreview({ content }: { content: BookContent }) {
  const [selected, setSelected] = useState(0)
  const chapter = content.chapters[selected] ?? content.chapters[0]
  return <div className="book-layout">
    <aside className="book-chapters">
      <h2>{content.title}</h2>
      {content.creator && <p>{content.creator}</p>}
      {content.chapters.map((item, index) => <button key={index} type="button" aria-current={index === selected ? 'page' : undefined} onClick={() => setSelected(index)}>{item.title}</button>)}
    </aside>
    <article className="document-view" dangerouslySetInnerHTML={{ __html: chapter?.html ?? '' }} />
  </div>
}

export function EmailPreview({ content }: { content: Extract<PreviewContent, { kind: 'email' }> }) {
  return <div className="email-view">
    <header>
      <h1>{content.subject}</h1>
      {content.from && <p>发件人：{content.from}</p>}
      {content.to && <p>收件人：{content.to}</p>}
      {content.date && <p>日期：{content.date}</p>}
      {content.attachments.length > 0 && <details><summary>附件（{content.attachments.length}）</summary><ul>{content.attachments.map((attachment, index) => <li key={index}>{attachment.name}</li>)}</ul></details>}
    </header>
    <article className="document-view" dangerouslySetInnerHTML={{ __html: content.html }} />
  </div>
}
