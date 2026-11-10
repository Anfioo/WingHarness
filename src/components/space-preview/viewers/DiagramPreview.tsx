import { usePreviewLoading } from './PreviewLoading';
import { useEffect, useState } from 'react';
import DOMPurify from 'dompurify';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { decodeText, extension } from '@/lib/space-preview/engine/files';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import { useAppTranslation } from '@/hooks/use-app-translation';
import DocumentReader from './DocumentReader';
import PreviewToolbar from './PreviewToolbar';
import { errorText } from './errors';

export default function DiagramPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [svg, setSvg] = useState('');
  const [markdown, setMarkdown] = useState<string>();
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  usePreviewLoading(
    !svg && markdown === undefined && !error,
    t('spacePreview.viewer.drawingDiagram', { defaultValue: 'Drawing the diagram' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    void readFullBytes(file, controller.signal)
      .then(async (bytes) => {
        const source = decodeText(bytes).text;
        // A .mmd file may hold plain Markdown; render it as a document in that case.
        if (
          extension(file.name) === 'mmd' &&
          !/^\s*(?:%%[^\n]*\n\s*)*(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|erDiagram|journey|gantt|pie|mindmap|timeline|quadrantChart|xychart|sankey|block|packet|architecture|kanban|gitGraph)\b/m.test(
            source,
          )
        ) {
          const result = await parseInWorker(
            { kind: 'markdown', bytes, name: file.name },
            controller.signal,
          );
          if (!controller.signal.aborted) setMarkdown(result.html);
          return;
        }
        const { default: mermaid } = await import('mermaid');
        if (controller.signal.aborted) return;
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'strict',
          suppressErrorRendering: true,
          htmlLabels: false,
          maxTextSize: 200_000,
          maxEdges: 2500,
        });
        const diagram = await mermaid.render(
          `diagram-${crypto.randomUUID()}`,
          source.replace(/%%\{[\s\S]*?\}%%/g, ''),
        );
        if (!controller.signal.aborted)
          setSvg(
            DOMPurify.sanitize(diagram.svg, {
              USE_PROFILES: { svg: true, svgFilters: true },
              FORBID_TAGS: ['script', 'foreignObject', 'image', 'a'],
            }),
          );
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      });
    return () => controller.abort();
  }, [file]);
  if (markdown !== undefined) return <DocumentReader html={markdown} />;
  const label = t('spacePreview.viewer.mermaidDiagram', { defaultValue: 'Mermaid diagram' });
  return (
    <div className="diagram-preview">
      <PreviewToolbar className="content-toolbar">
        <span>{label}</span>
        <button onClick={() => setZoom((value) => Math.max(0.2, value - 0.2))}>
          {t('spacePreview.viewer.zoomOut', { defaultValue: 'Zoom out' })}
        </button>
        <button onClick={() => setZoom(1)}>
          {t('spacePreview.viewer.fitDiagram', { defaultValue: 'Fit the diagram' })}
        </button>
        <button onClick={() => setZoom((value) => Math.min(5, value + 0.2))}>
          {t('spacePreview.viewer.zoomIn', { defaultValue: 'Zoom in' })}
        </button>
      </PreviewToolbar>
      {error ? (
        <div className="preview-message" role="alert">
          {error}
        </div>
      ) : !svg ? (
        <div className="preview-message" role="status">
          <span className="spinner" />
          {t('spacePreview.viewer.drawingDiagram', { defaultValue: 'Drawing the diagram…' })}
        </div>
      ) : (
        <div className="diagram-scroll">
          <div
            aria-label={t('spacePreview.viewer.diagramPreview', {
              defaultValue: '{{label}} preview',
              label,
            })}
            style={{ zoom }}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </div>
  );
}
