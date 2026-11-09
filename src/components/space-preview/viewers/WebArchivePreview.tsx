import { useEffect, useState } from 'react';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import { materializeWebArchive } from '@/lib/space-preview/engine/web-archive';
import { useAppTranslation } from '@/hooks/use-app-translation';
import HtmlPreview from './HtmlPreview';

export default function WebArchivePreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [page, setPage] = useState<PreviewFile>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    void readFullBytes(file, controller.signal)
      .then((bytes) =>
        parseInWorker({ kind: 'web-archive', name: file.name, bytes }, controller.signal),
      )
      .then((result) => {
        if (controller.signal.aborted) return;
        const blob = new Blob([materializeWebArchive(result.webArchive!)], { type: 'text/html' });
        setPage({ ...file, path: undefined, blob, size: blob.size, mime: 'text/html' });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [file]);
  return error ? (
    <p className="preview-message" role="alert">
      {error}
    </p>
  ) : page ? (
    <HtmlPreview file={page} />
  ) : (
    <div className="preview-message" role="status">
      <span className="spinner" />
      {t('spacePreview.viewer.readingWebArchive', {
        defaultValue: 'Reading the web archive…',
      })}
    </div>
  );
}
