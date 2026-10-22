import PostalMime, { type Address } from 'postal-mime'
import { escapeHtml } from '../lib/xml'
import type { FilePayload } from '../types'
import { sanitizeOfflineHtml } from './html'
import type { LoadState } from './previewTypes'

function addressText(address: Address): string {
  return address.group ? `${address.name}: ${address.group.map(addressText).join(', ')}` : `${address.name}${address.name ? ' ' : ''}<${address.address}>`
}

export async function renderEmail(payload: FilePayload): Promise<LoadState> {
  const email = await PostalMime.parse(payload.bytes)
  if (!email.headers.some(header => ['from', 'to', 'subject', 'date', 'mime-version'].includes(header.key))) return { status: 'ready', content: { kind: 'unsupported' } }
  return {
    status: 'ready', content: {
      kind: 'email', subject: email.subject || '(无主题)', from: email.from ? addressText(email.from) : '',
      to: (email.to ?? []).map(addressText).join(', '), date: email.date || '',
      html: sanitizeOfflineHtml(email.html || `<pre>${escapeHtml(email.text ?? '')}</pre>`),
      attachments: email.attachments.map(attachment => ({ name: attachment.filename || '(未命名附件)', mime: attachment.mimeType })),
    },
  }
}
