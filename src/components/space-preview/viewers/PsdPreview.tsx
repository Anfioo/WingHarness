import { useEffect, useState } from 'react';
import { Layers } from 'lucide-react';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { psdPngBlob, readPsdDocument } from '@/lib/space-preview/engine/psd';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { usePreviewLoading } from './PreviewLoading';
import PreviewToolbar from './PreviewToolbar';

export default function PsdPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [image, setImage] = useState('');
  const [size, setSize] = useState('');
  const [layers, setLayers] = useState<string[]>([]);
  const [error, setError] = useState('');
  usePreviewLoading(
    !image && !error,
    t('spacePreview.viewer.readingPsd', { defaultValue: 'Reading the Photoshop document' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    let url = '';
    setImage('');
    setError('');
    void readFullBytes(file, controller.signal)
      .then(async (bytes) => {
        const document = readPsdDocument(bytes);
        if (controller.signal.aborted) return;
        url = URL.createObjectURL(await psdPngBlob(document.canvas));
        if (controller.signal.aborted) return;
        setSize(`${document.width} × ${document.height}`);
        setLayers(document.layers);
        setImage(url);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(reason?.message ?? String(reason));
      });
    return () => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [file]);
  return (
    <div className="psd-preview">
      <PreviewToolbar className="content-toolbar">
        <span>
          PSD · {size || '…'}
          {layers.length
            ? ` · ${t('spacePreview.viewer.psdLayers', {
                defaultValue: '{{count}} layers',
                count: layers.length,
              })}`
            : ''}
        </span>
        {layers.length > 0 && (
          <details className="psd-layers">
            <summary>
              <Layers size={14} /> {t('spacePreview.viewer.psdLayerList', { defaultValue: 'Layers' })}
            </summary>
            <ul>
              {layers.map((name, index) => (
                <li key={index}>{name}</li>
              ))}
            </ul>
          </details>
        )}
      </PreviewToolbar>
      {error ? (
        <div className="preview-message" role="alert">
          {error}
        </div>
      ) : image ? (
        <div className="image-preview checkerboard">
          <img draggable={false} className="preview-image" src={image} alt={file.name} />
        </div>
      ) : (
        <div className="preview-message" role="status">
          <span className="spinner" />
          {t('spacePreview.viewer.readingPsd', {
            defaultValue: 'Reading the Photoshop document…',
          })}
        </div>
      )}
    </div>
  );
}
