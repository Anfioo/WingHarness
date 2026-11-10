import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { CompactSelect } from '@/components/compact-select';
import { useViewerPreferences } from './preferences';
import { PreviewMenu } from './PreviewToolbar';

const widths = [640, 860, 1080, 1440, 2400];

export default function ReadingWidth({
  children,
  kind = 'document',
  gutterWidth = 0,
}: {
  children: ReactNode;
  kind?: 'document' | 'code';
  gutterWidth?: number;
}) {
  const { t } = useAppTranslation();
  const { preferences, update } = useViewerPreferences();
  const root = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; width: number; side: number } | null>(null);
  const [codeWidth, setCodeWidth] = useState(2400);
  const width = kind === 'code' ? codeWidth : preferences.readingWidth;
  useLayoutEffect(() => {
    if (kind !== 'code') return;
    const element = root.current!;
    const updateInset = () => {
      const inset =
        width === 2400 ? 20 : Math.max(20, (element.clientWidth - gutterWidth - width) / 2);
      element.style.setProperty('--code-inset', `${inset}px`);
    };
    updateInset();
    const observer = new ResizeObserver(updateInset);
    observer.observe(element);
    return () => observer.disconnect();
  }, [kind, width, gutterWidth]);
  const setWidth = (next: number) => {
    const value = Math.round(Math.max(360, Math.min(2400, next)));
    if (kind === 'code') setCodeWidth(value);
    else update({ readingWidth: value });
  };
  const choices: { value: number; label: string }[] = [
    {
      value: 640,
      label: t('spacePreview.viewer.widthCompact', { defaultValue: 'Compact · 640 px' }),
    },
    {
      value: 860,
      label: t('spacePreview.viewer.widthDefault', { defaultValue: 'Default · 860 px' }),
    },
    {
      value: 1080,
      label: t('spacePreview.viewer.widthWide', { defaultValue: 'Roomy · 1080 px' }),
    },
    {
      value: 1440,
      label: t('spacePreview.viewer.widthWider', { defaultValue: 'Wide · 1440 px' }),
    },
    {
      value: 2400,
      label: t('spacePreview.viewer.widthFit', { defaultValue: 'Fit to window' }),
    },
  ];
  return (
    <div
      ref={root}
      className={`reading-width reading-width-${kind}${width === 2400 ? ' reading-width-fit' : ''}${kind === 'code' && gutterWidth > 0 ? ' has-gutter' : ''}`}
      style={
        {
          '--reading-width': width === 2400 ? '100%' : `${width}px`,
          '--reading-gutter-width': `${gutterWidth}px`,
          '--line-number-width': `${gutterWidth || 36}px`,
        } as CSSProperties
      }
    >
      {kind === 'document' && (
        <PreviewMenu>
          <label className="preview-menu-option">
            <span>{t('spacePreview.viewer.readingWidth', { defaultValue: 'Reading width' })}</span>
            <CompactSelect
              ariaLabel={t('spacePreview.viewer.readingWidth', { defaultValue: 'Reading width' })}
              value={String(width)}
              onChange={(value) => setWidth(Number(value))}
              options={[
                ...(widths.includes(width)
                  ? []
                  : [{ value: String(width), label: `${width} px` }]),
                ...choices.map((choice) => ({
                  value: String(choice.value),
                  label: choice.label,
                })),
              ]}
            />
          </label>
          <button onClick={() => setWidth(860)}>
            {t('spacePreview.viewer.resetReadingWidth', {
              defaultValue: 'Restore the default reading width',
            })}
          </button>
        </PreviewMenu>
      )}
      {children}
      {[-1, 1].map((side) => (
        <div
          key={side}
          className={`reading-width-handle ${side < 0 ? 'left' : 'right'}`}
          role="separator"
          aria-label={
            side < 0
              ? t('spacePreview.viewer.resizeLeft', { defaultValue: 'Resize the text on the left' })
              : t('spacePreview.viewer.resizeRight', {
                  defaultValue: 'Resize the text on the right',
                })
          }
          aria-orientation="vertical"
          aria-valuemin={360}
          aria-valuemax={2400}
          aria-valuenow={width}
          tabIndex={0}
          onPointerDown={(event) => {
            drag.current = {
              x: event.clientX,
              width: Math.min(width, Math.max(360, root.current!.clientWidth - gutterWidth - 32)),
              side,
            };
            event.currentTarget.setPointerCapture(event.pointerId);
            event.preventDefault();
          }}
          onPointerMove={(event) => {
            if (drag.current)
              setWidth(drag.current.width + (event.clientX - drag.current.x) * drag.current.side * 2);
          }}
          onPointerUp={() => {
            drag.current = null;
          }}
          onPointerCancel={() => {
            drag.current = null;
          }}
          onKeyDown={(event) => {
            if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            event.stopPropagation();
            const currentWidth = Math.min(
              width,
              Math.max(360, root.current!.clientWidth - gutterWidth - 32),
            );
            setWidth(
              event.key === 'Home'
                ? 360
                : event.key === 'End'
                  ? 2400
                  : currentWidth + (event.key === 'ArrowRight' ? 32 : -32) * side,
            );
          }}
        />
      ))}
    </div>
  );
}
