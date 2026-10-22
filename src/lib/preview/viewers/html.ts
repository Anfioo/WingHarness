import createDOMPurify, { type Config } from 'dompurify'

const htmlSanitizer = typeof window === 'undefined' ? undefined : createDOMPurify(window)

export function sanitizeHtml(value: string, options?: Config): string {
  if (!htmlSanitizer) throw new Error('HTML sanitizer is unavailable')
  return htmlSanitizer.sanitize(value, options)
}

export function sanitizeOfflineHtml(value: string): string {
  const template = document.createElement('template')
  template.innerHTML = sanitizeHtml(value, {
    FORBID_TAGS: ['style', 'link', 'iframe', 'object', 'embed', 'audio', 'video', 'svg', 'math'],
    FORBID_ATTR: ['srcset', 'style', 'href', 'xlink:href'],
  })
  for (const element of template.content.querySelectorAll('[src]')) {
    if (element.tagName !== 'IMG' || !/^data:image\/(png|jpeg|gif|webp|avif);base64,/i.test(element.getAttribute('src') ?? '')) element.removeAttribute('src')
  }
  return template.innerHTML
}
