import { usePreviewLoading } from './PreviewLoading';
import { useEffect, useState } from 'react';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { formatSize } from '@/lib/space-preview/engine/files';
import { previewMime } from '@/lib/space-preview/registry';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import type { MailContent } from '@/lib/space-preview/engine/mail';
import { useAppTranslation } from '@/hooks/use-app-translation';
import HtmlPreview from './HtmlPreview';
import FileIcon from './FileIcon';
import { TextAppearanceControls } from './TextAppearance';

export default function MailPreview({
  file,
  onOpen,
}: {
  file: PreviewFile;
  onOpen: (file: PreviewFile) => void;
}) {
  const { t } = useAppTranslation();
  const [mail, setMail] = useState<MailContent>();
  const [body, setBody] = useState<PreviewFile>();
  const [error, setError] = useState('');
  usePreviewLoading(
    !mail && !error,
    t('spacePreview.viewer.readingMail', { defaultValue: 'Reading the message' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    void readFullBytes(file, controller.signal)
      .then((bytes) => parseInWorker({ kind: 'mail', name: file.name, bytes }, controller.signal))
      .then((result) => {
        if (controller.signal.aborted) return;
        const content = result.mail!;
        setMail(content);
        if (content.html) {
          const blob = new Blob([content.html], { type: 'text/html' });
          setBody({
            ...file,
            path: undefined,
            blob,
            name: t('spacePreview.viewer.mailBodyName', { defaultValue: 'Message body.html' }),
            size: blob.size,
          });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [file, t]);
  if (error)
    return (
      <p className="preview-message" role="alert">
        {error}
      </p>
    );
  if (!mail)
    return (
      <div className="preview-message" role="status">
        <span className="spinner" />
        {t('spacePreview.viewer.readingMail', { defaultValue: 'Reading the message…' })}
      </div>
    );
  return (
    <div className="mail-preview">
      {!body && <TextAppearanceControls />}
      <header className="mail-header">
        <h1>{mail.subject}</h1>
        <dl>
          <dt>{t('spacePreview.viewer.mailFrom', { defaultValue: 'From' })}</dt>
          <dd>{mail.from || '—'}</dd>
          <dt>{t('spacePreview.viewer.mailTo', { defaultValue: 'To' })}</dt>
          <dd>{mail.to || '—'}</dd>
          <dt>{t('spacePreview.viewer.mailDate', { defaultValue: 'Date' })}</dt>
          <dd>{mail.date || '—'}</dd>
        </dl>
        {!!mail.attachments.length && (
          <div className="mail-attachments">
            {mail.attachments.map((attachment, i) => (
              <button
                key={i}
                title={t('spacePreview.viewer.previewAttachment', {
                  defaultValue: 'Preview the attachment',
                })}
                onClick={() => {
                  const mime = previewMime(attachment.name);
                  const blob = new Blob([attachment.data as Uint8Array<ArrayBuffer>], {
                    type: mime,
                  });
                  onOpen({
                    id: crypto.randomUUID(),
                    name: attachment.name,
                    size: blob.size,
                    modified: file.modified,
                    mime,
                    blob,
                  });
                }}
              >
                <FileIcon name={attachment.name} size={24} />
                <span>
                  {attachment.name}
                  <small>{formatSize(attachment.data.length)}</small>
                </span>
              </button>
            ))}
          </div>
        )}
      </header>
      {body ? (
        <HtmlPreview file={body} />
      ) : (
        <pre className="mail-text">
          {mail.text || t('spacePreview.viewer.mailNoBody', { defaultValue: 'This message has no body.' })}
        </pre>
      )}
    </div>
  );
}
