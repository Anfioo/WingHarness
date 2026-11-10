import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { useAppTranslation } from '@/hooks/use-app-translation';
import { fontKeyDirection, resizeText } from '@/lib/space-preview/engine/preview-gestures';
import { useViewerPreferences } from './preferences';

const families = {
  auto: 'var(--font-reading)',
  sans: '"Segoe UI", "Microsoft YaHei", "PingFang SC", "Noto Sans CJK SC", sans-serif',
  serif: 'Georgia, "Noto Serif CJK SC", "Source Han Serif SC", SimSun, serif',
  mono: 'var(--font-code)',
};
type Font = keyof typeof families;
const Appearance = createContext<{
  active: boolean;
  size: number;
  font: Font;
  setSize: (size: number | ((size: number) => number)) => void;
  setFont: (font: Font) => void;
}>({
  active: true,
  size: 16,
  font: 'auto',
  setSize: () => {},
  setFont: () => {},
});

export function TextAppearanceProvider({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  const { preferences, update } = useViewerPreferences();
  const font = preferences.font;
  const setFont = useCallback((next: Font) => update({ font: next }), [update]);
  const size = preferences.fontSize;
  const setSize = useCallback(
    (value: number | ((size: number) => number)) =>
      update({ fontSize: typeof value === 'function' ? value(size) : value }),
    [update, size],
  );
  return (
    <Appearance.Provider value={{ active, size, font, setSize, setFont }}>
      <div
        className="text-appearance-scope"
        style={
          {
            display: 'contents',
            '--preview-font-size': `${size}px`,
            '--preview-font-family': families[font],
            // Code and plain text stay monospaced whichever reading font is chosen.
            '--preview-code-family': 'var(--font-code)',
          } as CSSProperties
        }
      >
        {children}
      </div>
    </Appearance.Provider>
  );
}

export const useTextAppearance = () => useContext(Appearance);

export function usePreviewGestures(adjust: (direction: number) => void) {
  const { active } = useTextAppearance();
  const [adjusting, setAdjusting] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => {
    if (!active) {
      setAdjusting(false);
      return;
    }
    const show = () => {
      setAdjusting(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setAdjusting(false), 2000);
    };
    const key = (event: KeyboardEvent) => {
      const direction = fontKeyDirection(event);
      if (!direction || event.defaultPrevented) return;
      event.preventDefault();
      adjust(direction);
      show();
    };
    const wheel = (event: WheelEvent) => {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        !event.deltaY ||
        event.defaultPrevented
      )
        return;
      // Iframe gestures are deliberately forwarded to window; ordinary wheel
      // input must originate in the preview, excluding menus and preferences.
      if (
        event.target !== window &&
        !(event.target instanceof Element && event.target.closest('.sp-preview'))
      )
        return;
      event.preventDefault();
      adjust(event.deltaY < 0 ? 1 : -1);
      show();
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('wheel', wheel, { capture: true, passive: false });
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('wheel', wheel, true);
    };
  }, [active, adjust]);
  return active && adjusting;
}

export function PreviewAdjustmentIndicator({
  visible,
  label,
  value,
}: {
  visible: boolean;
  label: string;
  value: string;
}) {
  return visible ? (
    <div className="preview-adjustment" role="status" aria-live="polite" aria-atomic="true">
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  ) : null;
}

export function TextAppearanceControls() {
  const { t } = useAppTranslation();
  const { size, setSize } = useTextAppearance();
  const adjust = useCallback(
    (direction: number) => setSize((current) => resizeText(current, direction)),
    [setSize],
  );
  const adjusting = usePreviewGestures(adjust);
  return (
    <>
      <PreviewAdjustmentIndicator
        visible={adjusting}
        label={t('spacePreview.viewer.fontSize', { defaultValue: 'Font size' })}
        value={`${size} px`}
      />
    </>
  );
}
