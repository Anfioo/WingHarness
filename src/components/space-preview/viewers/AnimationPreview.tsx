import { usePreviewLoading } from './PreviewLoading';
import { useEffect, useRef, useState } from 'react';
import type { AnimationItem } from 'lottie-web';
import type { PreviewFile } from '@/lib/space-preview/bridge';
import { readFullBytes } from '@/lib/space-preview/bridge';
import { parseInWorker } from '@/lib/space-preview/worker/worker-client';
import { useAppTranslation } from '@/hooks/use-app-translation';
import PreviewToolbar from './PreviewToolbar';

export default function AnimationPreview({ file }: { file: PreviewFile }) {
  const { t } = useAppTranslation();
  const host = useRef<HTMLDivElement>(null);
  const player = useRef<AnimationItem | null>(null);
  const [names, setNames] = useState<string[]>([]);
  const [page, setPage] = useState(0);
  const [playing, setPlaying] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  usePreviewLoading(
    !loaded && !error,
    t('spacePreview.viewer.preparingAnimation', { defaultValue: 'Preparing the animation' }),
  );
  useEffect(() => {
    const controller = new AbortController();
    setLoaded(false);
    setError('');
    setPlaying(true);
    void readFullBytes(file, controller.signal)
      .then((bytes) =>
        parseInWorker({ kind: 'animation', name: file.name, bytes, page }, controller.signal),
      )
      .then(async (result) => {
        const { default: lottie } = await import('lottie-web/build/player/lottie_light');
        if (controller.signal.aborted || !host.current) return;
        setNames(result.animation!.names);
        const animation = lottie.loadAnimation({
          container: host.current,
          renderer: 'svg',
          animationData: result.animation!.data,
          loop: true,
          autoplay: true,
        });
        player.current = animation;
        animation.addEventListener('DOMLoaded', () => {
          if (!controller.signal.aborted) setLoaded(true);
        });
        animation.addEventListener('data_failed', () => {
          if (!controller.signal.aborted)
            setError(
              t('spacePreview.viewer.animationDataFailed', {
                defaultValue: 'The animation data cannot be rendered.',
              }),
            );
        });
      })
      .catch((e) => {
        if (!controller.signal.aborted) setError(e.message);
      });
    return () => {
      controller.abort();
      player.current?.destroy();
      player.current = null;
    };
  }, [file, page, t]);
  return (
    <div className="animation-preview checkerboard">
      <PreviewToolbar className="content-toolbar">
        <span>{t('spacePreview.viewer.lottieAnimation', { defaultValue: 'Lottie animation' })}</span>
        <button
          disabled={!loaded}
          onClick={() => {
            player.current?.togglePause();
            setPlaying((value) => !value);
          }}
        >
          {playing
            ? t('spacePreview.viewer.pause', { defaultValue: 'Pause' })
            : t('spacePreview.viewer.play', { defaultValue: 'Play' })}
        </button>
        {names.length > 1 && (
          <select
            aria-label={t('spacePreview.viewer.animation', { defaultValue: 'Animation' })}
            value={page}
            onChange={(event) => setPage(Number(event.target.value))}
          >
            {names.map((name, i) => (
              <option key={name} value={i}>
                {name}
              </option>
            ))}
          </select>
        )}
      </PreviewToolbar>
      <div
        className="animation-canvas"
        ref={host}
        aria-label={t('spacePreview.viewer.animationPreview', {
          defaultValue: 'Lottie animation preview',
        })}
      />
      {(error || !loaded) && (
        <div className="preview-message" role={error ? 'alert' : 'status'}>
          {error || (
            <>
              <span className="spinner" />
              {t('spacePreview.viewer.loadingAnimation', {
                defaultValue: 'Loading the animation…',
              })}
            </>
          )}
        </div>
      )}
    </div>
  );
}
