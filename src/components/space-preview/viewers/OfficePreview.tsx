import PreviewToolbar from './PreviewToolbar';
import { useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { ChevronLeft, ChevronRight, Table2 } from 'lucide-react';
import type { WorkerResult } from '@/lib/space-preview/worker/worker-types';
import { columnName } from '@/lib/space-preview/engine/office';
import {
  workbookRowOffsets,
  workbookRowAt,
  visibleWorkbookMerges,
} from '@/lib/space-preview/engine/workbook-layout';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { TextAppearanceControls, useTextAppearance } from './TextAppearance';

export default function OfficePreview({ result }: { result: WorkerResult }) {
  const { t } = useAppTranslation();
  const { size } = useTextAppearance();
  const rowHeight = Math.max(32, Math.ceil(size * 1.5 + 8));
  const [selected, setSelected] = useState(0);
  const scale = size / 16;
  const sheet = result.sheets?.[selected];
  const rowOffsets = useMemo(
    () => workbookRowOffsets(sheet, rowHeight, scale),
    [sheet, rowHeight, scale],
  );
  const [start, setStart] = useState(0);
  const scroller = useRef<HTMLDivElement>(null);
  const previousLayout = useRef({ sheet, offsets: rowOffsets });
  const scrollPosition = useRef(0);
  useLayoutEffect(() => {
    const previous = previousLayout.current;
    if (
      scroller.current &&
      sheet?.rows.length &&
      previous.sheet === sheet &&
      previous.offsets !== rowOffsets
    ) {
      const row = workbookRowAt(previous.offsets, scrollPosition.current);
      const height = previous.offsets[row + 1] - previous.offsets[row];
      const fraction = height ? (scrollPosition.current - previous.offsets[row]) / height : 0;
      scroller.current.scrollTop =
        rowOffsets[row] + fraction * (rowOffsets[row + 1] - rowOffsets[row]);
      scrollPosition.current = scroller.current.scrollTop;
      setStart(Math.max(0, workbookRowAt(rowOffsets, scroller.current.scrollTop) - 3));
    }
    previousLayout.current = { sheet, offsets: rowOffsets };
  }, [sheet, rowOffsets]);
  if (result.sheets) {
    if (!sheet)
      return (
        <div className="preview-message">
          {t('spacePreview.viewer.workbookEmpty', {
            defaultValue: 'This workbook has no sheets to show.',
          })}
        </div>
      );
    const columns = Math.max(sheet.columns, 1);
    const first = Math.min(start, Math.max(0, sheet.rows.length - 1));
    const end = Math.min(sheet.rows.length, first + 60);
    const merges = visibleWorkbookMerges(sheet.merges ?? [], first, end, rowOffsets);
    return (
      <div className="workbook-preview">
        <TextAppearanceControls />
        <PreviewToolbar className="content-toolbar">
          <span>
            <Table2 size={14} />
            {t('spacePreview.viewer.workbookSize', {
              defaultValue: '{{rows}} rows · {{columns}} columns',
              rows: sheet.rows.length,
              columns: sheet.columns,
            })}
            {sheet.truncated
              ? ` · ${t('spacePreview.viewer.truncated', { defaultValue: 'truncated' })}`
              : ''}
          </span>
          <span className="toolbar-summary">
            {result.note ??
              t('spacePreview.viewer.workbookReadonly', {
                defaultValue: 'Read-only · shows the saved formula results',
              })}
          </span>
        </PreviewToolbar>
        <div
          className="workbook-scroll"
          ref={scroller}
          style={
            {
              '--workbook-row-height': `${rowHeight}px`,
              overflowAnchor: 'none',
            } as React.CSSProperties
          }
          onScroll={(e) => {
            scrollPosition.current = e.currentTarget.scrollTop;
            setStart(Math.max(0, workbookRowAt(rowOffsets, scrollPosition.current) - 3));
          }}
        >
          <table
            className={`workbook-table${sheet.styles?.length ? ' workbook-styled' : ''}`}
            style={{
              width:
                45 +
                Array.from(
                  { length: columns },
                  (_, col) => (sheet.columnWidths?.[col] ?? 130) * scale,
                ).reduce((sum, width) => sum + width, 0),
            }}
          >
            <colgroup>
              <col style={{ width: 45 }} />
              {Array.from({ length: columns }, (_, col) => (
                <col
                  key={col}
                  style={{
                    width: (sheet.columnWidths?.[col] ?? 130) * scale,
                    visibility: sheet.columnWidths?.[col] === 0 ? 'collapse' : undefined,
                  }}
                />
              ))}
            </colgroup>
            <thead>
              <tr>
                <th />
                <>
                  {Array.from({ length: columns }, (_, col) => (
                    <th key={col}>{columnName(col)}</th>
                  ))}
                </>
              </tr>
            </thead>
            <tbody>
              {first > 0 && (
                <tr aria-hidden="true">
                  <td
                    colSpan={columns + 1}
                    style={{ height: rowOffsets[first], padding: 0, border: 0 }}
                  />
                </tr>
              )}
              {sheet.rows.slice(first, end).map((_row, offset) => {
                const rowIndex = first + offset;
                const height = rowOffsets[rowIndex + 1] - rowOffsets[rowIndex];
                return (
                  <tr key={rowIndex} style={{ height, display: height ? undefined : 'none' }}>
                    <th style={{ height }}>{rowIndex + 1}</th>
                    {Array.from({ length: columns }, (_, col) => {
                      const key = `${rowIndex}:${col}`;
                      const merge = merges.anchors.get(key);
                      if (merges.covered.has(key) && !merge) return null;
                      const sourceRow = merge?.row ?? rowIndex;
                      const sourceColumn = merge?.column ?? col;
                      const value = sheet.rows[sourceRow]?.[sourceColumn] ?? '';
                      const style =
                        sheet.styles?.[sheet.cellStyles?.[sourceRow]?.[sourceColumn] ?? 0];
                      const rowSpan = merge ? Math.min(end, merge.row + merge.rows) - rowIndex : 1;
                      const cellHeight = rowOffsets[rowIndex + rowSpan] - rowOffsets[rowIndex];
                      const cellStyle: CSSProperties = {
                        ...style,
                        fontSize: style?.fontSize ? style.fontSize * scale : undefined,
                        height: cellHeight,
                      };
                      return (
                        <td
                          key={col}
                          title={value}
                          style={cellStyle}
                          rowSpan={rowSpan}
                          colSpan={merge?.columns ?? 1}
                        >
                          <div
                            className="workbook-cell"
                            style={{
                              height: cellHeight - 1,
                              justifyContent:
                                style?.verticalAlign === 'top'
                                  ? 'flex-start'
                                  : style?.verticalAlign === 'middle'
                                    ? 'center'
                                    : 'flex-end',
                            }}
                          >
                            {value}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
              {end < sheet.rows.length && (
                <tr aria-hidden="true">
                  <td
                    colSpan={columns + 1}
                    style={{
                      height: rowOffsets[sheet.rows.length] - rowOffsets[end],
                      padding: 0,
                      border: 0,
                    }}
                  />
                </tr>
              )}
            </tbody>
          </table>
          {!sheet.rows.length && (
            <p className="empty-filter">
              {t('spacePreview.viewer.emptySheet', { defaultValue: 'This sheet is empty.' })}
            </p>
          )}
        </div>
        <div
          className="sheet-tabs"
          role="tablist"
          aria-label={t('spacePreview.viewer.worksheets', { defaultValue: 'Worksheets' })}
        >
          {result.sheets.map((s, i) => (
            <button
              key={i}
              role="tab"
              aria-selected={i === selected}
              className={i === selected ? 'selected' : ''}
              onClick={() => {
                setSelected(i);
                setStart(0);
                scrollPosition.current = 0;
                if (scroller.current) scroller.current.scrollTop = 0;
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      </div>
    );
  }
  const slide = result.slides?.[selected];
  if (!slide)
    return (
      <div className="preview-message">
        {t('spacePreview.viewer.slidesEmpty', {
          defaultValue: 'This presentation has no slides to show.',
        })}
      </div>
    );
  return (
    <div className="slides-preview">
      <TextAppearanceControls />
      <PreviewToolbar className="content-toolbar">
        <span>
          {t('spacePreview.viewer.slidesTextOverview', { defaultValue: 'Slide text overview' })}
        </span>
        <span className="toolbar-summary">
          {t('spacePreview.viewer.slidesSummary', {
            defaultValue:
              'Images, animations and the original layout are available in the default app',
          })}
        </span>
      </PreviewToolbar>
      <div className="slide-scroll">
        <article className="slide-paper">
          <div className="eyebrow">SLIDE {String(selected + 1).padStart(2, '0')}</div>
          <h1>{slide.title}</h1>
          {slide.paragraphs.map((paragraph, i) => (
            <p key={i}>{paragraph}</p>
          ))}
        </article>
      </div>
      <PreviewToolbar className="slide-controls">
        <button
          title={t('spacePreview.viewer.previousSlide', { defaultValue: 'Previous slide' })}
          disabled={selected === 0}
          onClick={() => setSelected((i) => i - 1)}
        >
          <ChevronLeft size={16} />
        </button>
        <span>
          {selected + 1} / {result.slides!.length}
        </span>
        <button
          title={t('spacePreview.viewer.nextSlide', { defaultValue: 'Next slide' })}
          disabled={selected + 1 >= result.slides!.length}
          onClick={() => setSelected((i) => i + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </PreviewToolbar>
    </div>
  );
}
