import { useState } from 'react';
import { FileQuestion, ExternalLink } from 'lucide-react';
import { openPath } from '@/commands';
import { useAppTranslation } from '@/hooks/use-app-translation';
import type { PreviewFile } from '@/lib/space-preview/bridge';

export default function UnsupportedPreview({
  file,
  title,
  message,
  onInfo,
}: {
  file?: PreviewFile;
  title?: string;
  message: string;
  onInfo?: () => void;
}) {
  const { t } = useAppTranslation();
  const [error, setError] = useState('');
  return (
    <div className="preview-message unsupported-preview" role="alert">
      <FileQuestion size={52} strokeWidth={1.3} />
      <h2>{title ?? t('spacePreview.unsupported.title', { defaultValue: 'No preview available' })}</h2>
      {file && (
        <strong className="unsupported-name" title={file.path ?? file.name}>
          {file.name}
        </strong>
      )}
      <p>{message}</p>
      <div className="unsupported-actions">
        {file?.path && (
          <button onClick={() => void openPath(file.path!).catch((reason) => setError(String(reason)))}>
            <ExternalLink size={16} />
            {t('spacePreview.viewer.openWithDefault', { defaultValue: 'Open with the default app' })}
          </button>
        )}
        {onInfo && (
          <button onClick={onInfo}>
            {t('spacePreview.viewer.fileInformation', { defaultValue: 'File information' })}
          </button>
        )}
      </div>
      {error && <p>{error}</p>}
    </div>
  );
}
