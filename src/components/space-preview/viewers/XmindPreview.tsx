import { useEffect, useRef, useState } from 'react';
import MindElixir from 'mind-elixir';
import 'mind-elixir/style.css';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { readXMind, type XMindSheet } from '@/lib/space-preview/engine/xmind';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { usePreviewLoading } from './PreviewLoading';
import PreviewToolbar from './PreviewToolbar';
import { errorText } from './errors';

export default function XmindPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const stage = useRef<HTMLDivElement>(null);
  const [sheets, setSheets] = useState<XMindSheet[]>([]);
  const [sheet, setSheet] = useState(0);
  const [error, setError] = useState('');
  const [ready, setReady] = useState(false);
  usePreviewLoading(
    !sheets.length && !error,
    t('spacePreview.viewer.readingMindMap', { defaultValue: 'Reading the mind map' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    setSheets([]);
    setSheet(0);
    setError('');
    void readFullBytes(file, controller.signal)
      .then((bytes) => readXMind(bytes, file.name))
      .then((value) => {
        if (!controller.signal.aborted) setSheets(value);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      });
    return () => controller.abort();
  }, [file]);
  useEffect(() => {
    const element = stage.current;
    const current = sheets[sheet];
    if (!element || !current) return;
    setReady(false);
    const mind = new MindElixir({
      el: element,
      editable: false,
      contextMenu: false,
      toolBar: true,
      keypress: false,
      allowUndo: false,
    });
    element.replaceChildren();
    try {
      mind.init({ nodeData: structuredClone(current.nodeData) });
      mind.scaleFit();
      setReady(true);
    } catch (reason) {
      setError(errorText(reason));
    }
    return () => mind.destroy();
  }, [sheets, sheet]);
  if (error)
    return (
      <div className="preview-message" role="alert">
        {error}
      </div>
    );
  if (!sheets.length)
    return (
      <div className="preview-message" role="status">
        <span className="spinner" />
        {t('spacePreview.viewer.readingMindMap', { defaultValue: 'Reading the mind map…' })}
      </div>
    );
  return (
    <div className="mind-view">
      <PreviewToolbar className="content-toolbar">
        {sheets.map((item, index) => (
          <button
            key={index}
            aria-pressed={sheet === index}
            onClick={() => {
              setError('');
              setSheet(index);
            }}
          >
            {item.title ||
              t('spacePreview.viewer.mindMapNumber', {
                defaultValue: 'Map {{number}}',
                number: index + 1,
              })}
          </button>
        ))}
      </PreviewToolbar>
      <div
        ref={stage}
        className="mind-stage"
        data-preview-ready={ready}
        aria-label={t('spacePreview.viewer.mindMap', { defaultValue: 'Mind map' })}
      />
    </div>
  );
}
