import { useMemo, useState } from 'react';
import { codeFolds } from '@/lib/space-preview/engine/code-folds';
import { highlightLineState, languageOf } from '@/lib/git-core/highlight';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { useViewerPreferences } from './preferences';

/**
 * The line view for text files below the fast-view threshold: one element per
 * line, line numbers and fold controls. Highlighting is the app's own, so the
 * colours follow the theme instead of the ported editor palette.
 */
export default function FoldableCode({ text, name }: { text: string; name: string }) {
  const { t } = useAppTranslation();
  const { preferences } = useViewerPreferences();
  const language = useMemo(() => languageOf(name), [name]);
  const source = useMemo(() => text.split('\n'), [text]);
  const lines = useMemo(() => {
    let inComment = false;
    return source.map((line) => {
      const result = highlightLineState(line, language, inComment);
      inComment = result.endsInComment;
      return result.html;
    });
  }, [source, language]);
  const ranges = useMemo(() => codeFolds(text, language ?? ''), [text, language]);
  const [collapsed, setCollapsed] = useState<Set<number>>(() => new Set());
  let hiddenUntil = -1;
  return (
    <pre
      className={`foldable-code bg-background text-foreground m-0 min-h-0 flex-1 overflow-auto p-4 font-mono text-sm leading-6 ${
        preferences.wrap ? 'wrap' : ''
      }`}
    >
      {lines.map((line, i) => {
        if (i < hiddenUntil) return null;
        const end = ranges.get(i);
        const folded = collapsed.has(i) && end !== undefined;
        if (folded) hiddenUntil = end;
        return (
          <div className="code-line" key={i}>
            <span className="line-number">{i + 1}</span>
            {ranges.size > 0 && (
              <span className="fold-gutter">
                {end !== undefined && (
                  <button
                    aria-label={
                      folded
                        ? t('spacePreview.viewer.foldExpand', {
                            defaultValue: 'Expand line {{line}}',
                            line: i + 1,
                          })
                        : t('spacePreview.viewer.foldCollapse', {
                            defaultValue: 'Collapse line {{line}}',
                            line: i + 1,
                          })
                    }
                    aria-expanded={!folded}
                    onClick={() =>
                      setCollapsed((previous) => {
                        const next = new Set(previous);
                        if (next.has(i)) next.delete(i);
                        else next.add(i);
                        return next;
                      })
                    }
                  >
                    {folded ? '▸' : '▾'}
                  </button>
                )}
              </span>
            )}
            <code dangerouslySetInnerHTML={{ __html: line || ' ' }} />
            {folded && (
              <span className="fold-summary">
                {' '}
                {t('spacePreview.viewer.foldSummary', {
                  defaultValue: '… {{count}} lines',
                  count: end - i - 1,
                })}
              </span>
            )}
          </div>
        );
      })}
    </pre>
  );
}
