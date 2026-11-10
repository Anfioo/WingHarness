import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import {
  FileQuestion,
  RotateCw,
  Minus,
  Plus,
  Maximize2,
  ChevronLeft,
  ChevronRight,
  Music2,
  Search,
  List,
  Info,
} from 'lucide-react';
import type { PPTXViewer } from 'pptxviewjs';
import type { PDFDocumentLoadingTask, PDFDocumentProxy } from 'pdfjs-dist';
import pdfWorker from './pdf.worker.ts?worker&url';
import { probePresentation } from '@/commands';
import type { TextEncoding } from '@/commands';
import { TEXT_ENCODINGS } from '@/components/code-editor';
import { CompactSelect } from '@/components/compact-select';
import { useAppTranslation } from '@/hooks/use-app-translation';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import {
  fileUrl,
  readBytes,
  readFullBytes,
  readRange,
  renderPresentation,
} from '@/lib/space-preview/bridge';
import { wholeFileLimit } from '@/lib/space-preview/limits';
import {
  detectKind,
  unsupportedFormatHint,
  type PreviewKind,
} from '@/lib/space-preview/registry';
import {
  decodeText,
  extension,
  formatSize,
  hasBinarySignature,
  sniffKind,
  sniffMagic,
} from '@/lib/space-preview/engine/files';
import { readInStages } from '@/lib/space-preview/engine/progressive-read';
import { readStructuredInStages } from '@/lib/space-preview/engine/progressive-office';
import { readOfficeXmlPackage } from '@/lib/space-preview/engine/office-range';
import { renderMetafile } from '@/lib/space-preview/engine/metafile';
import { previewText } from '@/lib/space-preview/text-preview';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import type { WorkerRequest, WorkerResult } from '@/lib/space-preview/worker/worker-types';
import { presentationEngine } from '@/lib/preview/viewers/presentationEngine';
import { documentError } from './document-error';
import { errorText } from './errors';
import { useViewerPreferences } from './preferences';
import { usePreviewLoading } from './PreviewLoading';
import PreviewToolbar, { PreviewMenu } from './PreviewToolbar';
import {
  PreviewAdjustmentIndicator,
  TextAppearanceControls,
  usePreviewGestures,
} from './TextAppearance';
import OfficePreview from './OfficePreview';
import DocumentReader, { ReadingLayout } from './DocumentReader';
import WordPreview from './WordPreview';
import FoldableCode from './FoldableCode';
import PdfPage from './PdfPage';
import OfdPage, { OFD_PX_PER_MM } from './OfdPage';
import type { OfdDocument } from '@/lib/space-preview/engine/ofd';
import { trackReadingPosition } from './reading-position';
import ArchivePreview from './ArchivePreview';
import HtmlPreview from './HtmlPreview';
import FileIcon, { fileTypeLabel } from './FileIcon';
import FontPreview from './FontPreview';
import DatabasePreview from './DatabasePreview';
import MailPreview from './MailPreview';
import DiagramPreview from './DiagramPreview';
import AnimationPreview from './AnimationPreview';
import PsdPreview from './PsdPreview';
import XmindPreview from './XmindPreview';
import WebArchivePreview from './WebArchivePreview';
import UnsupportedPreview from './UnsupportedPreview';

const MiB = 1024 * 1024;

type ParseKind = Exclude<
  WorkerRequest['kind'],
  'archive-entry' | 'archive-directory' | 'archive-data' | 'docx-layout'
>;

/** A blob URL for the file, revoked when the viewer unmounts or the file changes. */
function useFileUrl(file: PreviewFile) {
  const [resource, setResource] = useState({ url: '', error: '' });
  useEffect(() => {
    let active = true;
    let dispose: (() => void) | undefined;
    setResource({ url: '', error: '' });
    void fileUrl(file)
      .then((value) => {
        if (!active) {
          value.dispose();
          return;
        }
        dispose = value.dispose;
        setResource({ url: value.url, error: '' });
      })
      .catch((reason: unknown) => {
        if (active)
          setResource({ url: '', error: errorText(reason) });
      });
    return () => {
      active = false;
      dispose?.();
    };
  }, [file]);
  return resource;
}

export default function Preview({
  file,
  mode,
  onOpen,
}: {
  file: PreviewFile;
  mode: 'auto' | 'text';
  onOpen: (file: PreviewFile) => void;
}) {
  const { t } = useAppTranslation();
  const { preferences } = useViewerPreferences();
  const registered = detectKind(file.name);
  const textContainer = [
    'docx',
    'legacy-doc',
    'xlsx',
    'legacy-xlsx',
    'pptx',
    'legacy-ppt',
    'odt',
    'ods',
    'odp',
    'epub',
  ].includes(registered);
  const ambiguous = extension(file.name) === 'mdc';
  const shortcut = extension(file.name) === 'lnk';
  const [detected, setDetected] = useState<PreviewKind | null>(null);
  const [wordText, setWordText] = useState(false);
  const tooLarge = !file.blob && file.size > wholeFileLimit();
  useEffect(() => {
    setDetected(null);
    if (
      tooLarge ||
      shortcut ||
      file.directory ||
      mode !== 'auto' ||
      (registered !== 'binary' && !ambiguous)
    )
      return;
    let active = true;
    readBytes(file, 16384)
      .then((bytes) => {
        if (active) setDetected(sniffKind(bytes));
      })
      .catch(() => {
        if (active) setDetected('binary');
      });
    return () => {
      active = false;
    };
  }, [file, mode, registered, ambiguous, tooLarge, shortcut]);
  const kind: PreviewKind | null =
    mode === 'text'
      ? textContainer
        ? registered
        : 'text'
      : registered === 'binary' || ambiguous
        ? shortcut
          ? 'binary'
          : detected
        : registered;
  usePreviewLoading(
    !kind && !file.directory && !tooLarge,
    t('spacePreview.viewer.identifyingFileType', { defaultValue: 'Identifying the file type' }),
  );
  if (file.directory)
    return (
      <UnsupportedPreview
        file={file}
        message={t('spacePreview.viewer.folderNotPreviewed', {
          defaultValue: 'Folders are explored in the project file tree, not in the preview.',
        })}
      />
    );
  if (tooLarge && registered === 'binary') return <BinaryPreview file={file} />;
  if (tooLarge)
    return (
      <UnsupportedPreview
        file={file}
        title={t('spacePreview.viewer.tooLargeTitle', { defaultValue: 'The file is too large to preview' })}
        message={t('spacePreview.viewer.tooLargeBody', {
          defaultValue:
            'The file is {{size}}; whole-file previews are limited to {{limit}}.',
          size: formatSize(file.size),
          limit: formatSize(wholeFileLimit()),
        })}
      />
    );
  if (!kind) return <Loading />;
  if (kind === 'html')
    return preferences.html === 'source' ? (
      <TextPreview file={file} />
    ) : (
      <HtmlPreview file={file} />
    );
  if (kind === 'tiff') return <TiffPreview file={file} />;
  if (kind === 'metafile') return <MetafilePreview file={file} />;
  if (kind === 'psd') return <PsdPreview key={file.id} file={file} />;
  if (kind === 'xmind') return <XmindPreview key={file.id} file={file} />;
  if (kind === 'font') return <FontPreview key={file.id} file={file} />;
  if (kind === 'database') return <DatabasePreview key={file.id} file={file} />;
  if (kind === 'mail') return <MailPreview key={file.id} file={file} onOpen={onOpen} />;
  if (kind === 'diagram') return <DiagramPreview key={file.id} file={file} />;
  if (kind === 'animation') return <AnimationPreview key={file.id} file={file} />;
  if (kind === 'web-archive') return <WebArchivePreview key={file.id} file={file} />;
  if (kind === 'rtf')
    return wordText ? (
      <TextPreview file={file} onLayout={() => setWordText(false)} />
    ) : (
      <WordPreview key={file.id} file={file} format="rtf" onText={() => setWordText(true)} />
    );
  if (kind === 'docx' && !wordText && mode !== 'text')
    return <WordPreview key={file.id} file={file} onText={() => setWordText(true)} />;
  if (kind === 'image') return <ImagePreview file={file} />;
  if (kind === 'pdf') return <PdfPreview file={file} />;
  if (kind === 'ofd') return <OfdPreview key={file.id} file={file} />;
  if (kind === 'pptx' || kind === 'legacy-ppt')
    return mode === 'text' ? (
      <ParsedPreview file={file} kind={kind} />
    ) : (
      <PresentationPreview key={file.id} file={file} />
    );
  if (kind === 'video' || kind === 'audio')
    return <MediaPreview file={file} audio={kind === 'audio'} />;
  if (kind === 'binary') return <BinaryPreview file={file} />;
  if (kind === 'archive') return <ArchivePreview key={file.id} file={file} />;
  if (kind === 'text') return <TextPreview key={file.id} file={file} />;
  return (
    <ParsedPreview
      file={file}
      kind={kind as ParseKind}
      onLayout={kind === 'docx' && mode !== 'text' ? () => setWordText(false) : undefined}
    />
  );
}

function MetafilePreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [image, setImage] = useState<PreviewFile>();
  const [error, setError] = useState('');
  usePreviewLoading(
    !image && !error,
    t('spacePreview.viewer.parsingVectorImage', { defaultValue: 'Parsing the vector image' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    if (file.size > 16 * MiB) {
      setError(
        t('spacePreview.viewer.metafileTooLarge', {
          defaultValue: 'WMF/EMF previews are limited to 16 MB.',
        }),
      );
      return;
    }
    void readFullBytes(file, controller.signal)
      .then((bytes) =>
        parseInWorker({ kind: 'metafile', name: file.name, bytes }, controller.signal),
      )
      .then(async (result) => {
        if (controller.signal.aborted) return;
        const svg = await renderMetafile(
          result.data!,
          extension(file.name) === 'emf',
          result.metafile!,
        );
        if (controller.signal.aborted) return;
        const blob = new Blob(
          [DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })],
          { type: 'image/svg+xml' },
        );
        setImage({
          ...file,
          id: `${file.id}:vector`,
          path: undefined,
          blob,
          size: blob.size,
          mime: 'image/svg+xml',
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [file, t]);
  return (
    <div className="tiff-preview metafile-preview">
      <PreviewToolbar className="content-toolbar">
        <span>
          {extension(file.name).toUpperCase()} ·{' '}
          {t('spacePreview.viewer.vectorPreview', { defaultValue: 'GDI vector preview' })}
        </span>
      </PreviewToolbar>
      {error ? (
        <ErrorNotice message={error} />
      ) : image ? (
        <ImagePreview file={image} />
      ) : (
        <Loading />
      )}
    </div>
  );
}

function ImagePreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const { url, error: urlError } = useFileUrl(file);
  const [zoom, setZoom] = useState(1);
  const [rotation, setRotation] = useState(0);
  const [size, setSize] = useState('');
  const [error, setError] = useState(false);
  usePreviewLoading(
    !size && !error && !urlError,
    t('spacePreview.viewer.loadingImage', { defaultValue: 'Loading the image' }),
  );
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [fit, setFit] = useState(1);
  const drag = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const reset = () => {
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setRotation(0);
  };
  return (
    <div
      className="image-preview checkerboard"
      onWheel={(event) =>
        setZoom((z) => Math.max(0.1, Math.min(8, z * (event.deltaY < 0 ? 1.1 : 0.9))))
      }
      onPointerDown={(event) => {
        if ((event.target as HTMLElement).closest('button')) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { x: event.clientX, y: event.clientY, px: pan.x, py: pan.y };
      }}
      onPointerMove={(event) => {
        if (drag.current)
          setPan({
            x: drag.current.px + event.clientX - drag.current.x,
            y: drag.current.py + event.clientY - drag.current.y,
          });
      }}
      onPointerUp={() => {
        drag.current = null;
      }}
      onPointerCancel={() => {
        drag.current = null;
      }}
      onDoubleClick={() => {
        setZoom(1);
        setPan({ x: 0, y: 0 });
      }}
    >
      {error || urlError ? (
        <ErrorNotice
          message={
            urlError ||
            t('spacePreview.viewer.imageDecodeFailed', {
              defaultValue:
                'The system cannot decode this image. Use the file information or the default app.',
            })
          }
        />
      ) : (
        url && (
          <img
            draggable={false}
            className="preview-image"
            src={url}
            alt={file.name}
            style={{
              transform: `translate(${pan.x}px, ${pan.y}px) rotate(${rotation}deg) scale(${zoom})`,
            }}
            onLoad={(event) => {
              setFit(event.currentTarget.clientWidth / event.currentTarget.naturalWidth || 1);
              setSize(`${event.currentTarget.naturalWidth} × ${event.currentTarget.naturalHeight}`);
            }}
            onError={() => setError(true)}
          />
        )
      )}
      <PreviewToolbar className="floating-tools">
        <span>{size}</span>
        <i />
        <button
          title={t('spacePreview.viewer.zoomOut', { defaultValue: 'Zoom out' })}
          onClick={() => setZoom((z) => Math.max(0.1, z - 0.25))}
        >
          <Minus size={16} />
        </button>
        <button title={t('spacePreview.viewer.resetView', { defaultValue: 'Reset the view' })} onClick={reset}>
          {Math.round(zoom * fit * 100)}%
        </button>
        <button
          title={t('spacePreview.viewer.zoomIn', { defaultValue: 'Zoom in' })}
          onClick={() => setZoom((z) => Math.min(8, z + 0.25))}
        >
          <Plus size={16} />
        </button>
        <i />
        <button
          title={t('spacePreview.viewer.rotate', { defaultValue: 'Rotate' })}
          onClick={() => setRotation((r) => r + 90)}
        >
          <RotateCw size={16} />
        </button>
      </PreviewToolbar>
    </div>
  );
}

function TiffPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(0);
  const [image, setImage] = useState<PreviewFile>();
  const [error, setError] = useState('');
  usePreviewLoading(
    !image && !error,
    t('spacePreview.viewer.parsingTiff', { defaultValue: 'Parsing the TIFF image' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    setImage(undefined);
    setError('');
    if (file.size > 32 * MiB) {
      setError(
        t('spacePreview.viewer.tiffTooLarge', {
          defaultValue: 'TIFF previews are limited to 32 MB.',
        }),
      );
      return;
    }
    void readBytes(file, 32 * MiB)
      .then((bytes) =>
        parseInWorker({ kind: 'tiff', bytes, name: file.name, page }, controller.signal),
      )
      .then(async (result) => {
        const raster = result.raster!;
        const canvas = document.createElement('canvas');
        canvas.width = raster.width;
        canvas.height = raster.height;
        canvas
          .getContext('2d')!
          .putImageData(
            new ImageData(new Uint8ClampedArray(raster.pixels), raster.width, raster.height),
            0,
            0,
          );
        const blob = await new Promise<Blob>((resolve, reject) =>
          canvas.toBlob(
            (value) =>
              value
                ? resolve(value)
                : reject(
                    new Error(
                      t('spacePreview.viewer.tiffConvertFailed', {
                        defaultValue: 'The TIFF image could not be converted.',
                      }),
                    ),
                  ),
            'image/png',
          ),
        );
        if (!controller.signal.aborted) {
          setPages(raster.pages);
          setImage({
            ...file,
            id: `${file.id}:${page}`,
            path: undefined,
            blob,
            mime: 'image/png',
            size: blob.size,
          });
        }
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => controller.abort();
  }, [file, page, t]);
  return (
    <div className="tiff-preview">
      <PreviewToolbar className="content-toolbar">
        <span>
          {t('spacePreview.viewer.tiffPage', {
            defaultValue: 'TIFF · page {{page}} / {{total}}',
            page: page + 1,
            total: pages || '…',
          })}
        </span>
        <div className="toolbar-right">
          <button
            disabled={!image || page === 0}
            onClick={() => setPage((p) => p - 1)}
          >
            {t('spacePreview.viewer.previousPage', { defaultValue: 'Previous page' })}
          </button>
          <button
            disabled={!image || page >= pages - 1}
            onClick={() => setPage((p) => p + 1)}
          >
            {t('spacePreview.viewer.nextPage', { defaultValue: 'Next page' })}
          </button>
        </div>
      </PreviewToolbar>
      {error ? (
        <ErrorNotice message={error} />
      ) : image ? (
        <ImagePreview key={image.id} file={image} />
      ) : (
        <Loading />
      )}
    </div>
  );
}

function PresentationPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [mode, setMode] = useState<'pages' | 'text'>('pages');
  const [pdf, setPdf] = useState<PreviewFile | null>(null);
  const [note, setNote] = useState('');
  const [checked, setChecked] = useState(false);
  usePreviewLoading(
    !checked && mode === 'pages',
    t('spacePreview.viewer.convertingSlides', { defaultValue: 'Converting the slide pages' }),
  );
  useEffect(() => {
    let active = true;
    setPdf(null);
    setNote('');
    setChecked(false);
    void (async () => {
      if (!file.path) {
        if (active) setChecked(true);
        return;
      }
      let available = false;
      try {
        available = await probePresentation();
      } catch {
        available = false;
      }
      if (!active) return;
      if (!available) {
        setChecked(true);
        return;
      }
      try {
        const rendered = await renderPresentation(file);
        if (!active) return;
        setPdf(rendered);
      } catch (reason) {
        if (!active) return;
        setNote(errorText(reason));
      }
      if (active) setChecked(true);
    })();
    return () => {
      active = false;
    };
  }, [file]);
  return (
    <>
      <PreviewMenu>
        <label className="preview-menu-option">
          <span>{t('spacePreview.viewer.slidesView', { defaultValue: 'Slide view' })}</span>
          <CompactSelect
            ariaLabel={t('spacePreview.viewer.slidesView', { defaultValue: 'Slide view' })}
            value={mode}
            onChange={(value) => setMode(value === 'text' ? 'text' : 'pages')}
            options={[
              {
                value: 'pages',
                label: t('spacePreview.viewer.originalPages', { defaultValue: 'Original pages' }),
              },
              {
                value: 'text',
                label: t('spacePreview.viewer.textOverview', { defaultValue: 'Text overview' }),
              },
            ]}
          />
        </label>
        {note && (
          <p className="toolbar-summary" role="status">
            {t('spacePreview.viewer.slidesFallback', {
              defaultValue: 'Falling back to the built-in renderer: {{error}}',
              error: note,
            })}
          </p>
        )}
      </PreviewMenu>
      {mode === 'text' ? (
        <ParsedPreview
          file={file}
          kind={detectKind(file.name) === 'legacy-ppt' ? 'legacy-ppt' : 'pptx'}
        />
      ) : pdf ? (
        <PdfPreview file={pdf} presentation />
      ) : (
        <SlideCanvasPreview file={file} />
      )}
    </>
  );
}

/** The in-webview PowerPoint renderer, used when no local PowerPoint is available. */
function SlideCanvasPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const viewer = useRef<PPTXViewer | null>(null);
  const queue = useRef(Promise.resolve());
  const [width, setWidth] = useState(1280);
  const [page, setPage] = useState(0);
  const [count, setCount] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  usePreviewLoading(
    busy,
    t('spacePreview.viewer.renderingSlides', { defaultValue: 'Rendering the slides' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    let next: PPTXViewer | undefined;
    void readFullBytes(file, controller.signal)
      .then(async (bytes) => {
        const { PPTXViewer } = await presentationEngine();
        if (!active || !canvas.current) return;
        const instance = new PPTXViewer({
          canvas: canvas.current,
          slideSizeMode: 'fit',
          backgroundColor: '#ffffff',
          autoChartRerenderDelayMs: 0,
        });
        next = instance;
        await instance.loadFile(bytes);
        if (!active) return;
        if (!instance.getSlideCount())
          throw new Error(
            t('spacePreview.viewer.noSlides', {
              defaultValue: 'No renderable slide was found in this file.',
            }),
          );
        setCount(instance.getSlideCount());
        viewer.current = instance;
        setBusy(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(errorText(reason));
          setBusy(false);
        }
      });
    return () => {
      active = false;
      controller.abort();
      next?.destroy();
    };
  }, [file, t]);
  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const resize = () => setWidth(Math.max(320, element.clientWidth - 40));
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    resize();
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const instance = viewer.current;
    if (!instance || !canvas.current) return;
    let active = true;
    setBusy(true);
    queue.current = queue.current
      .then(async () => {
        if (active && canvas.current) await instance.goToSlide(page, canvas.current);
      })
      .catch((reason: unknown) => {
        if (active) setError(errorText(reason));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [page, width, zoom, count]);
  return (
    <div className="slides-preview">
      <PreviewToolbar className="content-toolbar">
        <button disabled={busy || page === 0} onClick={() => setPage(page - 1)}>
          {t('spacePreview.viewer.previousSlide', { defaultValue: 'Previous slide' })}
        </button>
        <span>
          {count ? `${page + 1} / ${count}` : t('spacePreview.viewer.readingSlides', { defaultValue: 'Reading…' })}
        </span>
        <button disabled={busy || page + 1 >= count} onClick={() => setPage(page + 1)}>
          {t('spacePreview.viewer.nextSlide', { defaultValue: 'Next slide' })}
        </button>
        <button
          disabled={zoom <= 0.5}
          onClick={() => setZoom(Math.max(0.5, zoom - 0.25))}
        >
          {t('spacePreview.viewer.zoomOut', { defaultValue: 'Zoom out' })}
        </button>
        <button onClick={() => setZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button disabled={zoom >= 3} onClick={() => setZoom(Math.min(3, zoom + 0.25))}>
          {t('spacePreview.viewer.zoomIn', { defaultValue: 'Zoom in' })}
        </button>
      </PreviewToolbar>
      {error && (
        <div className="preview-message" role="alert">
          {error}
        </div>
      )}
      <div ref={stage} className="slide-stage">
        <canvas
          ref={canvas}
          width={1280}
          height={720}
          style={{ width: width * zoom, height: (width * zoom * 9) / 16 }}
          aria-label={t('spacePreview.viewer.slideNumber', {
            defaultValue: 'Slide {{number}}',
            number: page + 1,
          })}
        />
      </div>
    </div>
  );
}

function PdfPreview({ file, presentation = false }: { file: PreviewFile; presentation?: boolean }) {
  const { t } = useAppTranslation();
  const macos = /Mac/i.test(navigator.platform);
  const { url, error: urlError } = useFileUrl(file);
  const [retry, setRetry] = useState(0);
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const adjusting = usePreviewGestures(
    useCallback(
      (direction: number) =>
        setZoom((current) =>
          Math.max(0.1, Math.min(4, Number((current + direction * 0.1).toFixed(2)))),
        ),
      [],
    ),
  );
  const [error, setError] = useState('');
  usePreviewLoading(
    !doc && !error && !urlError,
    t('spacePreview.viewer.readingPdf', { defaultValue: 'Reading the PDF document' }),
  );
  const scroll = useRef<HTMLDivElement>(null);
  const currentPage = useRef(1);
  const [pageSize, setPageSize] = useState({ width: 684, height: 910 });
  const [fitZoom, setFitZoom] = useState(1);
  const navigate = (number: number) => {
    scroll.current
      ?.querySelector(`[data-pdf-page="${number}"]`)
      ?.scrollIntoView({ block: 'start' });
    currentPage.current = number;
    setPage(number);
  };
  const [panel, setPanel] = useState<'search' | 'outline' | null>(null);
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [hits, setHits] = useState<{ page: number; snippet: string }[]>([]);
  const [searchNote, setSearchNote] = useState('');
  const [outline, setOutline] = useState<{ title: string; dest: unknown; depth: number }[]>([]);
  useEffect(() => {
    if (!doc || !scroll.current) return;
    // Preserve Windows' normal PDF reading scale; Quick Look fits the full page.
    if (!presentation && !macos) return;
    const scroller = scroll.current;
    const resize = new ResizeObserver(() =>
      setFitZoom(
        Math.max(
          0.1,
          Math.min(
            (scroller.clientWidth - (macos ? 16 : 48)) / pageSize.width,
            (scroller.clientHeight - (macos ? 16 : 48)) / pageSize.height,
          ),
        ),
      ),
    );
    resize.observe(scroller);
    return () => resize.disconnect();
  }, [presentation, doc, pageSize, macos]);
  useEffect(() => {
    let cancelled = false;
    if (!doc) return;
    void doc
      .getOutline()
      .then((items) => {
        const flat: { title: string; dest: unknown; depth: number }[] = [];
        const collect = (nodes: NonNullable<typeof items>, depth: number) => {
          for (const node of nodes) {
            if (flat.length >= 1000 || depth > 20) break;
            flat.push({ title: node.title, dest: node.dest, depth });
            collect(node.items, depth + 1);
          }
        };
        if (items) collect(items, 0);
        if (!cancelled) setOutline(flat);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [doc]);
  useEffect(() => {
    let cancelled = false;
    setHits([]);
    setSearchNote('');
    setSearching(false);
    if (!doc || !query.trim()) return;
    const timer = setTimeout(async () => {
      setSearching(true);
      const found: { page: number; snippet: string }[] = [];
      const deadline = performance.now() + 10_000;
      try {
        for (let number = 1; number <= doc.numPages && number <= 1000; number++) {
          if (cancelled) return;
          if (performance.now() > deadline) {
            setSearchNote(
              t('spacePreview.viewer.searchLimitReached', {
                defaultValue:
                  'Search reached its 10-second limit; the matches found so far were kept.',
              }),
            );
            break;
          }
          const pdfPage = await doc.getPage(number);
          const content = await pdfPage.getTextContent();
          const text = content.items.map((item) => ('str' in item ? item.str : '')).join(' ');
          const position = text.toLowerCase().indexOf(query.trim().toLowerCase());
          if (position >= 0) {
            found.push({
              page: number,
              snippet: text.slice(Math.max(0, position - 22), position + query.length + 55),
            });
            if (!cancelled) setHits([...found]);
          }
        }
        if (!cancelled && doc.numPages > 1000)
          setSearchNote(
            t('spacePreview.viewer.searchFirstPages', {
              defaultValue: 'Only the first 1,000 pages were searched.',
            }),
          );
      } catch {
        if (!cancelled)
          setSearchNote(
            t('spacePreview.viewer.searchExtractFailed', {
              defaultValue: 'Some pages could not be read as text.',
            }),
          );
      } finally {
        if (!cancelled) setSearching(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [doc, query, t]);
  const goToDestination = async (destination: unknown) => {
    if (!doc) return;
    try {
      const resolved =
        typeof destination === 'string' ? await doc.getDestination(destination) : destination;
      if (Array.isArray(resolved) && resolved.length) {
        const ref = resolved[0];
        const number = typeof ref === 'number' ? ref : await doc.getPageIndex(ref);
        navigate(Math.max(1, Math.min(doc.numPages, number + 1)));
      }
    } catch {
      setSearchNote(
        t('spacePreview.viewer.outlineNavigateFailed', {
          defaultValue: 'Could not jump to this outline entry.',
        }),
      );
    }
  };
  useEffect(() => {
    setError('');
    setDoc(null);
    setOutline([]);
    setPage(1);
    currentPage.current = 1;
    if (!url) return;
    let task: PDFDocumentLoadingTask | undefined;
    let cancelled = false;
    void import('./pdf-compat')
      .then(() => import('pdfjs-dist/legacy/build/pdf.mjs'))
      .then((pdf) => {
        if (cancelled) return;
        pdf.GlobalWorkerOptions.workerSrc = pdfWorker;
        task = pdf.getDocument({
          url,
          disableAutoFetch: true,
          disableStream: true,
          cMapUrl: `${import.meta.env.BASE_URL}pdfjs/cmaps/`,
          cMapPacked: true,
          standardFontDataUrl: `${import.meta.env.BASE_URL}pdfjs/standard_fonts/`,
          wasmUrl: `${import.meta.env.BASE_URL}pdfjs/wasm/`,
          iccUrl: `${import.meta.env.BASE_URL}pdfjs/iccs/`,
        });
        return task.promise.then(async (document) => {
          const first = await document.getPage(1);
          const size = first.getViewport({ scale: 1.15 });
          if (!cancelled) {
            setPageSize({ width: size.width, height: size.height });
            setDoc(document);
          }
        });
      })
      .catch((reason) => {
        if (!cancelled) setError(documentError('PDF', reason, t));
      });
    return () => {
      cancelled = true;
      void task?.destroy();
    };
  }, [url, retry, t]);
  useEffect(() => {
    if (!doc || !scroll.current) return;
    const scroller = scroll.current;
    return trackReadingPosition(
      scroller,
      Array.from(scroller.querySelectorAll('[data-pdf-page]')).map((element) => ({
        id: element.getAttribute('data-pdf-page')!,
        element,
      })),
      (id) => {
        currentPage.current = Number(id) || 1;
        setPage(currentPage.current);
      },
    );
  }, [doc]);
  useEffect(() => {
    scroll.current
      ?.querySelector(`[data-pdf-page="${currentPage.current}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [zoom, fitZoom]);
  return (
    <div
      className="pdf-preview"
      data-page-width={doc ? pageSize.width : undefined}
      data-page-height={doc ? pageSize.height : undefined}
    >
      <PreviewAdjustmentIndicator
        visible={adjusting}
        label={t('spacePreview.viewer.zoom', { defaultValue: 'Zoom' })}
        value={`${Math.round(zoom * 100)}%`}
      />
      {error || urlError ? (
        <ErrorNotice
          message={error || urlError}
          onRetry={() => setRetry((value) => value + 1)}
        />
      ) : (
        <>
          <PreviewToolbar className="content-toolbar pdf-toolbar">
            <span className="toolbar-summary">
              {presentation
                ? t('spacePreview.viewer.slidePages', {
                    defaultValue: 'Original slide pages · {{total}} pages',
                    total: doc?.numPages ?? '…',
                  })
                : t('spacePreview.viewer.pdfPages', {
                    defaultValue: 'PDF · {{total}} pages',
                    total: doc?.numPages ?? '…',
                  })}
            </span>
            <div className="toolbar-right">
              <button
                title={t('spacePreview.viewer.searchPdf', { defaultValue: 'Search the PDF' })}
                onClick={() => setPanel((p) => (p === 'search' ? null : 'search'))}
              >
                <Search size={15} /> {t('spacePreview.viewer.search', { defaultValue: 'Search' })}
              </button>
              <button
                title={t('spacePreview.viewer.pdfOutline', { defaultValue: 'PDF outline' })}
                onClick={() => setPanel((p) => (p === 'outline' ? null : 'outline'))}
              >
                <List size={15} /> {t('spacePreview.viewer.outline', { defaultValue: 'Outline' })}
              </button>
            </div>
          </PreviewToolbar>
          <div className="pdf-body">
            {panel && (
              <aside className="pdf-sidebar">
                {panel === 'search' ? (
                  <>
                    <label className="search">
                      <Search size={14} />
                      <input
                        autoFocus
                        aria-label={t('spacePreview.viewer.searchPdfContents', {
                          defaultValue: 'Search the PDF contents',
                        })}
                        placeholder={t('spacePreview.viewer.searchPlaceholder', {
                          defaultValue: 'Enter a keyword',
                        })}
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                    <p>
                      {searching
                        ? t('spacePreview.viewer.searchingPages', {
                            defaultValue: 'Searching page by page…',
                          })
                        : query
                          ? t('spacePreview.viewer.matchingPages', {
                              defaultValue: '{{count}} matching pages',
                              count: hits.length,
                            })
                          : t('spacePreview.viewer.searchDocumentText', {
                              defaultValue: 'Search the text in the document',
                            })}
                    </p>
                    {hits.map((hit) => (
                      <button key={hit.page} onClick={() => navigate(hit.page)}>
                        <strong>
                          {t('spacePreview.viewer.pageLabel', {
                            defaultValue: 'Page {{page}}',
                            page: hit.page,
                          })}
                        </strong>
                        <span>{hit.snippet}</span>
                      </button>
                    ))}
                    {searchNote && <p>{searchNote}</p>}
                  </>
                ) : (
                  <>
                    {!outline.length && (
                      <p>
                        {t('spacePreview.viewer.noOutline', {
                          defaultValue: 'This PDF has no built-in outline.',
                        })}
                      </p>
                    )}
                    {outline.map((item, index) => (
                      <button
                        key={index}
                        style={{ paddingLeft: 12 + item.depth * 12 }}
                        disabled={!item.dest}
                        onClick={() => void goToDestination(item.dest)}
                      >
                        {item.title}
                      </button>
                    ))}
                  </>
                )}
              </aside>
            )}
            <div className="pdf-scroll" ref={scroll}>
              {!doc ? (
                <Loading />
              ) : (
                Array.from({ length: doc.numPages }, (_, index) => (
                  <PdfPage
                    key={index + 1}
                    doc={doc}
                    number={index + 1}
                    zoom={zoom * fitZoom}
                    initialSize={pageSize}
                  />
                ))
              )}
            </div>
          </div>
          <PreviewToolbar className="floating-tools">
            <button
              title={t('spacePreview.viewer.previousPage', { defaultValue: 'Previous page' })}
              disabled={page <= 1}
              onClick={() => navigate(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span
              aria-label={t('spacePreview.viewer.pdfCurrentPage', {
                defaultValue: 'Current PDF page',
              })}
            >
              {page} / {doc?.numPages ?? '…'}
            </span>
            <button
              title={t('spacePreview.viewer.nextPage', { defaultValue: 'Next page' })}
              disabled={!doc || page >= doc.numPages}
              onClick={() => navigate(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <i />
            <button
              title={t('spacePreview.viewer.zoomOut', { defaultValue: 'Zoom out' })}
              onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            >
              <Minus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            {presentation && (
              <button
                title={t('spacePreview.viewer.fitWindow', { defaultValue: 'Fit the window' })}
                onClick={() => setZoom(1)}
              >
                <Maximize2 size={16} />
              </button>
            )}
            <button
              title={t('spacePreview.viewer.zoomIn', { defaultValue: 'Zoom in' })}
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            >
              <Plus size={16} />
            </button>
          </PreviewToolbar>
        </>
      )}
    </div>
  );
}

function OfdPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const [doc, setDoc] = useState<OfdDocument | null>(null);
  const [error, setError] = useState('');
  usePreviewLoading(
    !doc && !error,
    t('spacePreview.viewer.readingOfd', { defaultValue: 'Reading the OFD document' }),
  );
  const [retry, setRetry] = useState(0);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [fitZoom, setFitZoom] = useState(1);
  const scroll = useRef<HTMLDivElement>(null);
  const currentPage = useRef(1);
  const adjusting = usePreviewGestures(
    useCallback(
      (direction: number) =>
        setZoom((current) =>
          Math.max(0.1, Math.min(4, Number((current + direction * 0.1).toFixed(2)))),
        ),
      [],
    ),
  );
  const navigate = (number: number) => {
    scroll.current
      ?.querySelector(`[data-pdf-page="${number}"]`)
      ?.scrollIntoView({ block: 'start' });
    currentPage.current = number;
    setPage(number);
  };
  useEffect(() => {
    const controller = new AbortController();
    let opened: OfdDocument | undefined;
    setDoc(null);
    setError('');
    setPage(1);
    currentPage.current = 1;
    void import('@/lib/space-preview/engine/ofd')
      .then(({ openOfd }) =>
        openOfd({
          size: file.size,
          read: async (offset, length) => {
            controller.signal.throwIfAborted();
            return readRange(file, offset, length);
          },
          signal: controller.signal,
          worker: true,
        }),
      )
      .then((document) => {
        if (controller.signal.aborted) return document.close();
        opened = document;
        setDoc(document);
      })
      .catch((reason) => {
        if (!controller.signal.aborted) setError(documentError('OFD', reason, t));
      });
    return () => {
      controller.abort();
      opened?.close();
    };
  }, [file, retry, t]);
  useEffect(() => {
    if (!doc || !scroll.current || !/Mac/i.test(navigator.platform)) return;
    // Quick Look on macOS fits the whole page, matching the PDF reader.
    const scroller = scroll.current;
    const resize = new ResizeObserver(() =>
      setFitZoom(
        Math.max(
          0.1,
          Math.min(
            (scroller.clientWidth - 16) / (doc.box[2] * OFD_PX_PER_MM),
            (scroller.clientHeight - 16) / (doc.box[3] * OFD_PX_PER_MM),
          ),
        ),
      ),
    );
    resize.observe(scroller);
    return () => resize.disconnect();
  }, [doc]);
  useEffect(() => {
    if (!doc || !scroll.current) return;
    const scroller = scroll.current;
    return trackReadingPosition(
      scroller,
      Array.from(scroller.querySelectorAll('[data-pdf-page]')).map((element) => ({
        id: element.getAttribute('data-pdf-page')!,
        element,
      })),
      (id) => {
        currentPage.current = Number(id) || 1;
        setPage(currentPage.current);
      },
    );
  }, [doc]);
  useEffect(() => {
    scroll.current
      ?.querySelector(`[data-pdf-page="${currentPage.current}"]`)
      ?.scrollIntoView({ block: 'start' });
  }, [zoom, fitZoom]);
  const count = doc?.pages.length;
  return (
    <div
      className="pdf-preview ofd-preview"
      data-page-width={doc ? doc.box[2] * OFD_PX_PER_MM : undefined}
      data-page-height={doc ? doc.box[3] * OFD_PX_PER_MM : undefined}
    >
      <PreviewAdjustmentIndicator
        visible={adjusting}
        label={t('spacePreview.viewer.zoom', { defaultValue: 'Zoom' })}
        value={`${Math.round(zoom * 100)}%`}
      />
      {error ? (
        <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />
      ) : (
        <>
          <PreviewToolbar className="content-toolbar pdf-toolbar">
            <span className="toolbar-summary">
              {doc && doc.documents > 1
                ? t('spacePreview.viewer.ofdDocuments', {
                    defaultValue: 'OFD layout document · {{documents}} documents · {{pages}} pages',
                    documents: doc.documents,
                    pages: count ?? '…',
                  })
                : t('spacePreview.viewer.ofdPages', {
                    defaultValue: 'OFD layout document · {{pages}} pages',
                    pages: count ?? '…',
                  })}
            </span>
          </PreviewToolbar>
          <div className="pdf-body">
            <div className="pdf-scroll" ref={scroll}>
              {!doc ? (
                <Loading />
              ) : (
                doc.pages.map((item, index) => (
                  <OfdPage key={item.path} doc={doc} index={index} zoom={zoom * fitZoom} />
                ))
              )}
            </div>
          </div>
          <PreviewToolbar className="floating-tools">
            <button
              title={t('spacePreview.viewer.previousPage', { defaultValue: 'Previous page' })}
              disabled={page <= 1}
              onClick={() => navigate(page - 1)}
            >
              <ChevronLeft size={16} />
            </button>
            <span
              aria-label={t('spacePreview.viewer.ofdCurrentPage', {
                defaultValue: 'Current OFD page',
              })}
            >
              {page} / {count ?? '…'}
            </span>
            <button
              title={t('spacePreview.viewer.nextPage', { defaultValue: 'Next page' })}
              disabled={!count || page >= count}
              onClick={() => navigate(page + 1)}
            >
              <ChevronRight size={16} />
            </button>
            <i />
            <button
              title={t('spacePreview.viewer.zoomOut', { defaultValue: 'Zoom out' })}
              onClick={() => setZoom((z) => Math.max(0.25, z - 0.25))}
            >
              <Minus size={16} />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              title={t('spacePreview.viewer.zoomIn', { defaultValue: 'Zoom in' })}
              onClick={() => setZoom((z) => Math.min(3, z + 0.25))}
            >
              <Plus size={16} />
            </button>
          </PreviewToolbar>
        </>
      )}
    </div>
  );
}

function MediaPreview({ file, audio }: { file: PreviewFile; audio: boolean }) {
  const { t } = useAppTranslation();
  const { url, error: urlError } = useFileUrl(file);
  const player = useRef<HTMLMediaElement>(null);
  useEffect(() => {
    const media = player.current;
    return () => {
      if (!media) return;
      media.pause();
      media.removeAttribute('src');
      media.load();
    };
  }, [url]);
  const [error, setError] = useState(false);
  const [ready, setReady] = useState(false);
  usePreviewLoading(
    !ready && !error && !urlError,
    audio
      ? t('spacePreview.viewer.loadingAudio', { defaultValue: 'Loading the audio' })
      : t('spacePreview.viewer.loadingVideo', { defaultValue: 'Loading the video' }),
  );
  useEffect(() => {
    setReady(false);
    setError(false);
  }, [url]);
  return (
    <div className={`media-preview ${audio ? 'audio-preview' : ''}`}>
      {error || urlError ? (
        <ErrorNotice
          message={
            urlError ||
            t('spacePreview.viewer.mediaUnsupported', {
              defaultValue:
                'The system does not support this audio or video codec. Use the default app instead.',
            })
          }
        />
      ) : audio ? (
        <>
          <div className="record">
            <Music2 size={44} />
          </div>
          <h2>{file.name}</h2>
          <p>{t('spacePreview.viewer.audioPause', { defaultValue: 'Stop for a moment and listen.' })}</p>
          {url && (
            <audio
              ref={(element) => {
                player.current = element;
              }}
              autoPlay
              controls
              src={url}
              onLoadedData={() => setReady(true)}
              onError={() => setError(true)}
            />
          )}
        </>
      ) : (
        url && (
          <video
            ref={(element) => {
              player.current = element;
            }}
            autoPlay
            controls
            playsInline
            src={url}
            onLoadedData={() => setReady(true)}
            onError={() => setError(true)}
          />
        )
      )}
    </div>
  );
}

function ParsedPreview({
  file,
  kind,
  onLayout,
}: {
  file: PreviewFile;
  kind: ParseKind;
  onLayout?: () => void;
}) {
  const { t } = useAppTranslation();
  const { preferences } = useViewerPreferences();
  const [result, setResult] = useState<WorkerResult | null>(null);
  const [progress, setProgress] = useState(0);
  const [backgroundLoading, setBackgroundLoading] = useState(false);
  const [retry, setRetry] = useState(0);
  const [error, setError] = useState('');
  usePreviewLoading(
    (!result || backgroundLoading) && !error,
    progress >= 100
      ? t('spacePreview.viewer.parsingContents', { defaultValue: 'Parsing the file contents' })
      : result
        ? t('spacePreview.viewer.loadingLaterContent', { defaultValue: 'Loading later content' })
        : t('spacePreview.viewer.readingFile', { defaultValue: 'Reading the file' }),
    progress > 0 && progress < 100 ? progress : undefined,
  );
  const [encodingOverride, setEncoding] = useState<TextEncoding | null>(null);
  const encoding = encodingOverride ?? preferences.defaultEncoding;
  const container = [
    'archive',
    'docx',
    'xlsx',
    'pptx',
    'odt',
    'ods',
    'odp',
    'epub',
    'fb2',
    'notebook',
  ].includes(kind);
  const limit = ['fb2', 'notebook'].includes(kind) ? 8 * MiB : container ? 32 * MiB : 512 * 1024;
  useEffect(() => {
    const controller = new AbortController();
    setError('');
    setResult(null);
    setProgress(0);
    setBackgroundLoading(false);
    const stagedText =
      file.size > 512 * 1024 && ['markdown', 'csv', 'asciidoc'].includes(kind);
    const stagedOffice = file.size > MiB && ['xlsx', 'pptx', 'epub'].includes(kind);
    const largeOffice =
      file.size > limit && ['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(kind);
    if (file.size > limit && container && !largeOffice && !stagedOffice) {
      setError(
        t('spacePreview.viewer.quickPreviewLimit', {
          defaultValue:
            'The quick preview for this format is limited to {{limit}} MB; use the file information or the default app.',
          limit: limit / MiB,
        }),
      );
      return;
    }
    const load = async () => {
      if (stagedText) {
        setBackgroundLoading(true);
        await readInStages(
          file.size,
          (offset, length) => readRange(file, offset, length),
          controller.signal,
          async (bytes, complete) => {
            const value = await parseInWorker(
              { kind, name: file.name, bytes, encoding, partial: !complete },
              controller.signal,
            );
            if (!controller.signal.aborted) setResult(value);
          },
          setProgress,
        );
        return;
      }
      if (stagedOffice) {
        setBackgroundLoading(true);
        await readStructuredInStages(
          file,
          kind as 'xlsx' | 'pptx' | 'epub',
          controller.signal,
          setResult,
          setProgress,
        );
        return;
      }
      const bytes = await (largeOffice
        ? readOfficeXmlPackage(file, controller.signal)
        : [
              'markdown',
              'html',
              'csv',
              'asciidoc',
              'legacy-xlsx',
              'legacy-doc',
              'legacy-ppt',
            ].includes(kind)
          ? readFullBytes(file, controller.signal, setProgress)
          : readBytes(file, limit));
      const value = await parseInWorker(
        { kind, name: file.name, bytes, encoding, progressive: file.size > 512 * 1024 },
        controller.signal,
        (value) => {
          setBackgroundLoading(true);
          setResult(value);
        },
      );
      if (!controller.signal.aborted) setResult(value);
    };
    void load()
      .catch((e) => {
        if (!controller.signal.aborted) setError(errorText(e));
      })
      .finally(() => {
        if (!controller.signal.aborted) setBackgroundLoading(false);
      });
    return () => controller.abort();
  }, [file, kind, limit, container, encoding, retry, t]);
  if (error && !result) return <ErrorNotice message={error} />;
  if (!result)
    return [
      'markdown',
      'docx',
      'odt',
      'html',
      'fb2',
      'notebook',
      'asciidoc',
      'legacy-doc',
    ].includes(kind) ? (
      <ReadingLayout outline={[]} loading onNavigate={() => {}}>
        <Loading progress={progress} />
      </ReadingLayout>
    ) : (
      <Loading progress={progress} />
    );
  const loadingStatus = error && (
    <div className="progressive-status" role="alert">
      <span>
        {t('spacePreview.viewer.laterContentFailed', {
          defaultValue: 'Loading the rest of the content failed: {{error}}',
          error,
        })}
      </span>
      <button onClick={() => setRetry((value) => value + 1)}>
        {t('spacePreview.viewer.reload', { defaultValue: 'Reload' })}
      </button>
    </div>
  );
  if (result.sheets || result.slides)
    return (
      <>
        {loadingStatus}
        <OfficePreview result={result} />
      </>
    );
  if (result.chapters)
    return (
      <>
        {loadingStatus}
        <BookPreview chapters={result.chapters} />
      </>
    );
  const encodingControl = (
    <PreviewMenu>
      <label className="preview-menu-option">
        <span>{t('spacePreview.viewer.fileEncoding', { defaultValue: 'File encoding' })}</span>
        <CompactSelect
          ariaLabel={t('spacePreview.viewer.textEncoding', { defaultValue: 'Text encoding' })}
          title={t('spacePreview.viewer.fileEncoding', { defaultValue: 'File encoding' })}
          value={encoding}
          onChange={(value) => setEncoding(value as TextEncoding)}
          options={(
            [
              'auto',
              'utf-8',
              'utf-16le',
              'utf-16be',
              'gb18030',
              'big5',
              'windows-1252',
              'shift_jis',
            ] as const
          ).map((value) => ({
            value,
            label:
              value === 'auto'
                ? t('spacePreview.encoding.auto', { defaultValue: 'Detect automatically' })
                : value === 'gb18030'
                  ? 'GB18030 / GBK'
                  : value.toUpperCase(),
          }))}
        />
      </label>
    </PreviewMenu>
  );
  if (
    ['markdown', 'docx', 'odt', 'html', 'fb2', 'notebook', 'asciidoc', 'legacy-doc'].includes(kind)
  ) {
    // Active content is stripped by the shared reader. Markdown keeps public image links.
    return (
      <>
        {loadingStatus}
        <DocumentReader
          loading={backgroundLoading}
          html={result.html ?? ''}
          remoteImages={kind === 'markdown'}
          imagePath={kind === 'markdown' ? file.path : undefined}
          toolbar={
            <>
              <span className="reading-label">
                {kind === 'legacy-doc'
                  ? result.note
                  : kind === 'markdown'
                    ? 'Markdown'
                    : kind === 'html'
                      ? t('spacePreview.viewer.htmlSafeReading', {
                          defaultValue: 'HTML · safe reading',
                        })
                      : kind === 'fb2'
                        ? t('spacePreview.viewer.fb2Ebook', { defaultValue: 'FB2 · e-book' })
                        : kind === 'notebook'
                          ? 'Jupyter Notebook'
                          : t('spacePreview.viewer.documentTextPreview', {
                              defaultValue: 'Document · text overview',
                            })}
              </span>
              {!container && encodingControl}
              {onLayout && (
                <button onClick={onLayout}>
                  {t('spacePreview.viewer.pagePreview', { defaultValue: 'Page preview' })}
                </button>
              )}
            </>
          }
          note={
            result.note ||
            (container && file.size > limit
              ? t('spacePreview.viewer.largeDocumentNote', {
                  defaultValue:
                    'Large document text overview · reads the XML on demand and skips images',
                })
              : undefined)
          }
        />
      </>
    );
  }
  return null;
}

/** JSON is shown indented, as the other viewers show it; invalid JSON stays as written. */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/**
 * The read-only text view. Below the configured size it keeps the foldable
 * line view — line numbers, folding and the app's own highlighter. Above the
 * threshold it switches to a single `<pre>`, so a long file costs one text
 * node instead of one per line. The file is still edited by the host's
 * `CodeEditor`; this viewer only ever reads.
 */
function TextPreview({ file, onLayout }: { file: PreviewFile; onLayout?: () => void }) {
  const { t } = useAppTranslation();
  const { preferences } = useViewerPreferences();
  const [encodingOverride, setEncodingOverride] = useState<TextEncoding | null>(null);
  const encoding = encodingOverride ?? preferences.defaultEncoding;
  const [text, setText] = useState<{ text: string; encoding: string } | null>(null);
  const [binary, setBinary] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState(0);
  const [retry, setRetry] = useState(0);
  usePreviewLoading(
    !text && !binary && !error,
    progress > 0 && progress < 100
      ? t('spacePreview.viewer.loadingWholeFile', {
          defaultValue: 'Loading the whole file… {{percent}}%',
          percent: progress,
        })
      : t('spacePreview.viewer.readingFile', { defaultValue: 'Reading the file' }),
    progress > 0 && progress < 100 ? progress : undefined,
  );
  useEffect(() => {
    const controller = new AbortController();
    setText(null);
    setBinary(false);
    setError('');
    setProgress(0);
    const load = async () => {
      const prefix = await readBytes(file, 16384);
      controller.signal.throwIfAborted();
      if (hasBinarySignature(prefix) || !['text', 'html', 'rtf'].includes(sniffKind(prefix))) {
        setBinary(true);
        return;
      }
      const bytes = await readFullBytes(file, controller.signal, setProgress);
      controller.signal.throwIfAborted();
      const decoded = decodeText(bytes, encoding);
      setText(
        extension(file.name) === 'json'
          ? { ...decoded, text: prettyJson(decoded.text) }
          : decoded,
      );
    };
    void load().catch((e) => {
      if (!controller.signal.aborted) setError(errorText(e));
    });
    return () => controller.abort();
  }, [file, encoding, retry]);
  const fast = file.size > preferences.textPreviewThresholdKb * 1024;
  const rendered = useMemo(
    () => (text && fast ? previewText(text.text, file.name) : null),
    [text, fast, file.name],
  );
  const lines = useMemo(() => {
    if (!text) return 0;
    let count = 1;
    for (let i = text.text.indexOf('\n'); i >= 0; i = text.text.indexOf('\n', i + 1)) count += 1;
    return count;
  }, [text]);
  if (error) return <ErrorNotice message={error} onRetry={() => setRetry((value) => value + 1)} />;
  if (binary) return <BinaryPreview file={file} textFallback />;
  if (!text) return <Loading progress={progress} />;
  return (
    <div className="text-preview">
      <PreviewToolbar className="content-toolbar">
        <span className="toolbar-summary">
          {text.encoding}
          <b>·</b>
          {t('spacePreview.viewer.lineCount', {
            defaultValue: '{{count}} lines',
            count: lines,
          })}
        </span>
        <div className="toolbar-right">
          {onLayout && (
            <button onClick={onLayout}>
              {t('spacePreview.viewer.pagePreview', { defaultValue: 'Page preview' })}
            </button>
          )}
          <label className="preview-menu-option">
            <span>{t('spacePreview.viewer.fileEncoding', { defaultValue: 'File encoding' })}</span>
            <CompactSelect
              ariaLabel={t('spacePreview.viewer.textEncoding', { defaultValue: 'Text encoding' })}
              title={t('spacePreview.viewer.fileEncoding', { defaultValue: 'File encoding' })}
              value={encoding}
              onChange={(value) => setEncodingOverride(value as TextEncoding)}
              options={TEXT_ENCODINGS.map((item) => ({
                value: item.value,
                label: t(item.key, { defaultValue: item.fallback }),
              }))}
            />
          </label>
        </div>
      </PreviewToolbar>
      {fast ? (
        <pre
          className={`bg-background text-foreground m-0 min-h-0 flex-1 overflow-auto p-4 font-mono text-sm leading-6 ${
            preferences.wrap ? 'whitespace-pre-wrap' : 'whitespace-pre'
          }`}
        >
          {rendered?.html ? (
            <code className="hljs" dangerouslySetInnerHTML={{ __html: rendered.html }} />
          ) : (
            text.text
          )}
        </pre>
      ) : (
        <FoldableCode name={file.name} text={text.text} />
      )}
    </div>
  );
}

function BookPreview({ chapters }: { chapters: NonNullable<WorkerResult['chapters']> }) {
  const { t } = useAppTranslation();
  const [index, setIndex] = useState(0);
  const chapter = chapters[index];
  return (
    <div className="book-preview">
      <TextAppearanceControls />
      <PreviewToolbar className="content-toolbar">
        <CompactSelect
          ariaLabel={t('spacePreview.viewer.selectChapter', {
            defaultValue: 'Choose an e-book chapter',
          })}
          value={String(index)}
          onChange={(value) => setIndex(Number(value))}
          className="max-w-80"
          options={chapters.map((item, i) => ({
            value: String(i),
            label: `${i + 1}. ${item.title}`,
          }))}
        />
        <span>
          {t('spacePreview.viewer.chapterOf', {
            defaultValue: '{{index}} / {{count}} chapters · text overview',
            index: index + 1,
            count: chapters.length,
          })}
        </span>
      </PreviewToolbar>
      <div className="document-scroll" key={index}>
        <article
          className="document-paper prose"
          dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(chapter?.html ?? '') }}
        />
      </div>
    </div>
  );
}

function BinaryPreview({
  file,
  textFallback = false,
}: {
  file: PreviewFile;
  textFallback?: boolean;
}) {
  const { t } = useAppTranslation();
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [error, setError] = useState('');
  usePreviewLoading(
    !bytes && !error,
    t('spacePreview.viewer.readingFileInfo', { defaultValue: 'Reading the file information' }),
  );
  const [shown, setShown] = useState(128);
  useEffect(() => {
    let active = true;
    readBytes(file, 512)
      .then((b) => {
        if (active) setBytes(b);
      })
      .catch((e) => {
        if (active) setError(errorText(e));
      });
    return () => {
      active = false;
    };
  }, [file]);
  if (error) return <ErrorNotice message={error} />;
  return (
    <div className="binary-preview">
      <div className="binary-summary">
        <FileIcon name={file.name} path={file.path} size={72} />
        <div className="binary-heading">
          <span className="binary-type-badge">{fileTypeLabel(file.name, false, t)}</span>
          <h2>{file.name}</h2>
          <p>
            {bytes
              ? sniffMagic(bytes)
              : t('spacePreview.viewer.readingFileInformation', {
                  defaultValue: 'Reading the file information…',
                })}
          </p>
        </div>
      </div>
      <dl className="metadata">
        <div>
          <dt>{t('spacePreview.viewer.fileSize', { defaultValue: 'File size' })}</dt>
          <dd>{formatSize(file.size)}</dd>
        </div>
        <div>
          <dt>MIME</dt>
          <dd>{file.mime || 'application/octet-stream'}</dd>
        </div>
        <div>
          <dt>{t('spacePreview.viewer.modifiedTime', { defaultValue: 'Modified' })}</dt>
          <dd>{new Date(file.modified).toLocaleString()}</dd>
        </div>
        <div>
          <dt>{t('spacePreview.viewer.fileSignature', { defaultValue: 'File signature' })}</dt>
          <dd className="mono">
            {bytes
              ? Array.from(bytes.slice(0, 8), (b) =>
                  b.toString(16).padStart(2, '0').toUpperCase(),
                ).join(' ') ||
                t('spacePreview.viewer.emptyFile', { defaultValue: 'Empty file' })
              : '…'}
          </dd>
        </div>
      </dl>
      <div className="hex-title">
        <strong>{t('spacePreview.viewer.byteContent', { defaultValue: 'Byte content' })}</strong>
        <div className="hex-options">
          {[128, 512].map((count) => (
            <button
              key={count}
              className={shown === count ? 'selected' : ''}
              aria-pressed={shown === count}
              onClick={() => setShown(count)}
            >
              {t('spacePreview.viewer.byteCount', {
                defaultValue: '{{count}} bytes',
                count,
              })}
            </button>
          ))}
        </div>
      </div>
      <div className="hex-legend">
        <span className="hex-signature">
          {t('spacePreview.viewer.hexSignature', { defaultValue: 'File signature' })}
        </span>
        <span className="hex-printable">
          {t('spacePreview.viewer.hexPrintable', { defaultValue: 'Readable text' })}
        </span>
        <span className="hex-zero">
          {t('spacePreview.viewer.hexZero', { defaultValue: 'Zero bytes' })}
        </span>
        <span>
          {t('spacePreview.viewer.hexShown', {
            defaultValue: 'First {{count}} bytes · read-only',
            count: bytes ? Math.min(shown, bytes.length) : shown,
          })}
        </span>
      </div>
      <div
        className="hex hex-grid"
        aria-label={t('spacePreview.viewer.hexContent', { defaultValue: 'Hexadecimal file content' })}
      >
        <div className="hex-row hex-column-heading">
          <span>{t('spacePreview.viewer.hexOffset', { defaultValue: 'Offset' })}</span>
          <span>
            {Array.from({ length: 16 }, (_, i) => (
              <b key={i}>{i.toString(16).toUpperCase().padStart(2, '0')}</b>
            ))}
          </span>
          <span>ASCII</span>
        </div>
        {bytes ? (
          bytes.length ? (
            Array.from({ length: Math.ceil(Math.min(bytes.length, shown) / 16) }, (_, row) => {
              const part = bytes.slice(row * 16, Math.min(row * 16 + 16, shown));
              return (
                <div className="hex-row" key={row}>
                  <span className="hex-offset">
                    {(row * 16).toString(16).toUpperCase().padStart(8, '0')}
                  </span>
                  <span className="hex-bytes">
                    {Array.from({ length: 16 }, (_, col) => {
                      const value = part[col],
                        offset = row * 16 + col;
                      return (
                        <span
                          key={col}
                          className={
                            value === undefined
                              ? ''
                              : offset < 8
                                ? 'hex-signature'
                                : value === 0
                                  ? 'hex-zero'
                                  : value >= 32 && value <= 126
                                    ? 'hex-printable'
                                    : 'hex-control'
                          }
                          title={
                            value === undefined
                              ? undefined
                              : t('spacePreview.viewer.hexByteTitle', {
                                  defaultValue: 'Offset {{offset}} · decimal {{value}}',
                                  offset,
                                  value,
                                })
                          }
                        >
                          {value === undefined
                            ? '  '
                            : value.toString(16).toUpperCase().padStart(2, '0')}
                        </span>
                      );
                    })}
                  </span>
                  <span className="hex-ascii">
                    {Array.from(part, (value) =>
                      value >= 32 && value <= 126 ? String.fromCharCode(value) : '·',
                    ).join('')}
                  </span>
                </div>
              );
            })
          ) : (
            <p>{t('spacePreview.viewer.emptyFileContent', { defaultValue: 'This file is empty.' })}</p>
          )
        ) : (
          <p>{t('spacePreview.viewer.reading', { defaultValue: 'Reading…' })}</p>
        )}
      </div>
      <p className="binary-hint">
        <Info size={16} />
        {textFallback
          ? t('spacePreview.viewer.binaryDetected', {
              defaultValue:
                'Binary content was detected, so the file information and a byte preview are shown; this file cannot be read as plain text.',
            })
          : unsupportedFormatHint(file.name) ||
            t('spacePreview.viewer.noEngineHint', {
              defaultValue:
                'This format has no content preview yet. If it is known to be text, hold Shift while using the preview shortcut.',
            })}
      </p>
    </div>
  );
}

function Loading({ progress, label }: { progress?: number; label?: string } = {}) {
  const { t } = useAppTranslation();
  return (
    <div className="preview-message" role="status" aria-live="polite">
      <span className="spinner" />
      <p>
        {label ??
          (progress === undefined
            ? t('spacePreview.viewer.preparingPreview', { defaultValue: 'Preparing the preview…' })
            : progress < 100
              ? t('spacePreview.viewer.loadingWholeFile', {
                  defaultValue: 'Loading the whole file… {{percent}}%',
                  percent: progress,
                })
              : t('spacePreview.viewer.parsingWholeContent', {
                  defaultValue: 'Parsing the whole content…',
                }))}
      </p>
    </div>
  );
}

function ErrorNotice({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="preview-message">
      <FileQuestion size={36} />
      <h3>{t('spacePreview.viewer.renderFailed', { defaultValue: 'This file cannot be rendered' })}</h3>
      <p>{message}</p>
      {onRetry && (
        <button onClick={onRetry}>{t('spacePreview.viewer.reload', { defaultValue: 'Reload' })}</button>
      )}
    </div>
  );
}
