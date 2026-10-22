export function xmlRepeat(attributes: string, attribute: string): number {
  const value = Number.parseInt(xmlAttribute(attributes, attribute) || '1', 10)
  return Number.isFinite(value) && value > 0 ? value : 1
}

export function xmlAttribute(value: string, attribute: string): string {
  const escaped = attribute.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = value.match(new RegExp(`${escaped}="([^"]+)"`))
  return match ? decodeXml(match[1]) : ''
}

export function stripXml(value: string): string {
  return value.replace(/<[^>]+>/g, '')
}

export function decodeXml(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}

export function parseXmlDocument(value: string): Document {
  if (/<!ENTITY\s/i.test(value)) throw new Error('文档 XML 无效')
  const document = new DOMParser().parseFromString(value, 'application/xml')
  if (document.querySelector('parsererror')) throw new Error('文档 XML 无效')
  return document
}

export function escapeHtml(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}
