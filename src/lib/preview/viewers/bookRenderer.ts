import JSZip from 'jszip'
import { bytesToArrayBuffer, bytesToText } from '../lib/bytes'
import { escapeHtml, parseXmlDocument } from '../lib/xml'
import type { FilePayload } from '../types'
import { sanitizeOfflineHtml } from './html'
import type { BookContent, LoadState } from './previewTypes'

export async function renderBook(payload: FilePayload): Promise<LoadState> {
  const content = payload.extension === 'fb2' ? parseFictionBook(payload)
    : payload.extension === 'cbz' ? await parseComic(payload) : await parseEpub(payload)
  return { status: 'ready', content }
}

async function parseComic(payload: FilePayload): Promise<BookContent> {
  const zip = await JSZip.loadAsync(bytesToArrayBuffer(payload.bytes))
  const files = Object.values(zip.files).filter(file => !file.dir && /\.(png|jpe?g|gif|webp|avif)$/i.test(file.name)).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
  const chapters = []
  for (const file of files) {
    const extension = file.name.split('.').at(-1)!.toLowerCase()
    const mime = extension === 'jpg' ? 'jpeg' : extension
    chapters.push({ title: file.name, html: `<img alt="${escapeHtml(file.name)}" src="data:image/${mime};base64,${await file.async('base64')}">` })
  }
  if (!chapters.length) throw new Error('漫画没有可预览的页面')
  return { kind: 'book', title: payload.name, creator: '', chapters }
}

function parseFictionBook(payload: FilePayload): BookContent {
  const document = parseXmlDocument(bytesToText(payload.bytes))
  const ns = 'http://www.gribuser.ru/xml/fictionbook/2.0'
  if (document.documentElement.localName !== 'FictionBook') throw new Error('不是有效的 FB2 文档')
  const title = document.getElementsByTagNameNS(ns, 'book-title')[0]?.textContent || payload.name
  const creator = Array.from(document.getElementsByTagNameNS(ns, 'author')).map(author => Array.from(author.children).map(node => node.textContent).join(' ')).join(', ')
  const bodies = Array.from(document.getElementsByTagNameNS(ns, 'body'))
  const chapters = bodies.flatMap(body => {
    const sections = Array.from(body.children).filter(node => node.localName === 'section')
    return (sections.length ? sections : [body]).map((section, index) => ({
      title: section.getElementsByTagNameNS(ns, 'title')[0]?.textContent || `章节 ${index + 1}`,
      html: Array.from(section.getElementsByTagNameNS(ns, '*')).filter(node => ['p', 'v', 'subtitle'].includes(node.localName)).map(node => `<p>${escapeHtml(node.textContent ?? '')}</p>`).join(''),
    }))
  })
  if (!chapters.length) throw new Error('电子书没有可阅读的章节')
  return { kind: 'book', title, creator, chapters }
}

async function parseEpub(payload: FilePayload): Promise<BookContent> {
  const zip = await JSZip.loadAsync(bytesToArrayBuffer(payload.bytes))
  const containerXml = await zip.file('META-INF/container.xml')?.async('text')
  if (!containerXml) throw new Error('电子书缺少目录')
  const container = parseXmlDocument(containerXml)
  const packagePath = container.getElementsByTagNameNS('*', 'rootfile')[0]?.getAttribute('full-path')
  const packageXml = packagePath && await zip.file(packagePath)?.async('text')
  if (!packageXml || !packagePath) throw new Error('电子书缺少章节清单')
  const packageDocument = parseXmlDocument(packageXml)
  const manifest = new Map(Array.from(packageDocument.getElementsByTagNameNS('*', 'item')).map(item => [item.getAttribute('id'), item.getAttribute('href')]))
  const paths = Array.from(packageDocument.getElementsByTagNameNS('*', 'itemref')).map(item => manifest.get(item.getAttribute('idref'))).filter((href): href is string => Boolean(href))
  const chapters = []
  for (const [index, href] of paths.entries()) {
    const url = new URL(href, `https://book.invalid/${packagePath}`)
    if (url.origin !== 'https://book.invalid') throw new Error('电子书包含外部章节')
    const source = await zip.file(decodeURIComponent(url.pathname.slice(1)))?.async('text')
    if (!source) throw new Error('电子书章节缺失')
    const chapter = new DOMParser().parseFromString(source, 'text/html')
    for (const image of chapter.querySelectorAll('img[src]')) {
      const imageUrl = new URL(image.getAttribute('src')!, url)
      if (imageUrl.origin !== url.origin) { image.removeAttribute('src'); continue }
      const extension = imageUrl.pathname.split('.').at(-1)?.toLowerCase()
      const mime = extension === 'jpg' ? 'jpeg' : extension
      if (!mime || !['png', 'jpeg', 'gif', 'webp', 'avif'].includes(mime)) { image.removeAttribute('src'); continue }
      const file = zip.file(decodeURIComponent(imageUrl.pathname.slice(1)))
      if (file) image.setAttribute('src', `data:image/${mime};base64,${await file.async('base64')}`)
    }
    chapters.push({ title: chapter.querySelector('h1,h2,h3,title')?.textContent || `章节 ${index + 1}`, html: sanitizeOfflineHtml(chapter.body.innerHTML) })
  }
  if (!chapters.length) throw new Error('电子书没有可阅读的章节')
  return {
    kind: 'book', title: packageDocument.getElementsByTagNameNS('*', 'title')[0]?.textContent || payload.name,
    creator: packageDocument.getElementsByTagNameNS('*', 'creator')[0]?.textContent || '', chapters,
  }
}
