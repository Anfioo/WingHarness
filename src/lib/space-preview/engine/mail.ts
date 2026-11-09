// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import PostalMime, { type Address } from 'postal-mime';
import { extension } from './files';
import { decodeHtml } from './html';

export interface MailContent {
  subject: string;
  from: string;
  to: string;
  date: string;
  html?: string;
  text?: string;
  attachments: { name: string; mime: string; data: Uint8Array }[];
}
const address = (item: Address): string =>
  item.group
    ? item.group.map(address).join(', ')
    : [item.name, item.address && `<${item.address}>`].filter(Boolean).join(' ');

export async function readMail(bytes: Uint8Array, name: string): Promise<MailContent> {
  if (extension(name) === 'eml') {
    const mail = await PostalMime.parse(bytes);
    return {
      subject: mail.subject ?? '(No subject)',
      from: mail.from ? address(mail.from) : '',
      to: (mail.to ?? []).map(address).join(', '),
      date: mail.date ?? '',
      html: mail.html,
      text: mail.text,
      attachments: mail.attachments.map((item, i) => ({
        name: item.filename ?? `Attachment ${i + 1}`,
        mime: item.mimeType,
        data:
          typeof item.content === 'string'
            ? new TextEncoder().encode(item.content)
            : new Uint8Array(item.content),
      })),
    };
  }
  const { default: MsgReader } = await import('@kenjiuno/msgreader');
  const reader = new MsgReader(new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const mail = reader.getFileData();
  if (mail.error) throw new Error(mail.error);
  return {
    subject: mail.subject ?? '(No subject)',
    from: [mail.senderName, mail.senderEmail].filter(Boolean).join(' '),
    to: (mail.recipients ?? [])
      .map((item) => [item.name, item.email].filter(Boolean).join(' '))
      .join(', '),
    date: mail.messageDeliveryTime ?? mail.creationTime ?? '',
    html: mail.bodyHtml || (mail.html ? decodeHtml(mail.html).text : undefined),
    text: mail.body,
    attachments: (mail.attachments ?? []).map((item) => {
      const attachment = reader.getAttachment(item);
      return {
        name: attachment.fileName,
        mime: 'application/octet-stream',
        data: attachment.content,
      };
    }),
  };
}
