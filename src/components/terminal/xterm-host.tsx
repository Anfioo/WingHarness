import { useEffect, useRef, useState } from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { terminalThemeFromTokens } from "@/lib/terminal/theme";
import { cn } from "@/lib/utils";

export type TerminalSize = { cols: number; rows: number };

/** What a caller can drive on the terminal once it is open. */
export type XtermHostHandle = {
  /** The xterm instance, for anything the helpers below do not cover. */
  term: Terminal;
  /** Re-measure the container and resize the terminal to fit it. */
  fit: () => void;
  /** Wipe the terminal's buffer. */
  clear: () => void;
  focus: () => void;
  write: (data: string | Uint8Array) => void;
  selectAll: () => void;
  getSelection: () => string;
  hasSelection: () => boolean;
  paste: (text: string) => void;
};

export type XtermHostProps = {
  /** Terminal colours. Derive with {@link useTerminalTheme}. */
  theme: ITheme;
  fontFamily: string;
  fontSize: number;
  tabStopWidth?: number;
  scrollback?: number;
  /** Focus the terminal once it is open and visible. */
  autoFocus?: boolean;
  /** Hidden while false; a `display:none` container cannot be measured. */
  active?: boolean;
  /** Paint the current-line highlight band behind the cursor row. */
  highlightCurrentLine?: boolean;
  className?: string;
  onData?: (data: string) => void;
  /** Fires whenever the terminal's cell grid changes size, fit included. */
  onResize?: (size: TerminalSize) => void;
  /** Called with the handle once open, and with `null` right before unmount. */
  expose?: (handle: XtermHostHandle | null) => void;
};

/**
 * The app's light/dark terminal theme, re-derived whenever the theme class on
 * `<html>` flips. xterm takes a plain object, so a fresh value on every flip is
 * all it needs.
 */
export function useTerminalTheme(): ITheme {
  const [theme, setTheme] = useState<ITheme>(() => terminalThemeFromTokens());

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(terminalThemeFromTokens()));
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  return theme;
}

/**
 * The shared xterm surface: creation, fitting, the theme/font props and the
 * cursor highlight live here so the local shell and the SSH shells behave the
 * same. Protocol work (PTY, SSH session, event routing) stays with the caller.
 */
export function XtermHost({
  theme,
  fontFamily,
  fontSize,
  tabStopWidth = 8,
  scrollback = 5000,
  autoFocus = false,
  active = true,
  highlightCurrentLine = false,
  className,
  onData,
  onResize,
  expose,
}: XtermHostProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const handleRef = useRef<XtermHostHandle | null>(null);

  // Every callback reads through a ref so re-renders never rebuild the terminal.
  const onDataRef = useRef(onData);
  const onResizeRef = useRef(onResize);
  const exposeRef = useRef(expose);
  const autoFocusRef = useRef(autoFocus);
  useEffect(() => {
    onDataRef.current = onData;
  }, [onData]);
  useEffect(() => {
    onResizeRef.current = onResize;
  }, [onResize]);
  useEffect(() => {
    exposeRef.current = expose;
  }, [expose]);
  useEffect(() => {
    autoFocusRef.current = autoFocus;
  }, [autoFocus]);

  // Mount: create the terminal once. Everything mutable is applied by the
  // effects below, so the empty dependency list is deliberate.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const term = new Terminal({
      fontFamily,
      fontSize,
      tabStopWidth,
      cursorBlink: true,
      scrollback,
      theme,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(container);
    fit.fit();
    termRef.current = term;
    fitRef.current = fit;

    const handle: XtermHostHandle = {
      term,
      fit: () => fit.fit(),
      clear: () => term.clear(),
      focus: () => term.focus(),
      write: (data) => term.write(data),
      selectAll: () => term.selectAll(),
      getSelection: () => term.getSelection(),
      hasSelection: () => term.hasSelection(),
      paste: (text) => term.paste(text),
    };
    handleRef.current = handle;
    exposeRef.current?.(handle);

    const dataDisposable = term.onData((data) => onDataRef.current?.(data));
    const resizeDisposable = term.onResize(({ cols, rows }) =>
      onResizeRef.current?.({ cols, rows })
    );

    // Cursor tracking for current-line highlight. The overlay sits in the
    // wrapper's coordinate space, but the terminal is inset by the container's
    // padding, so anchor to the first visible row instead of assuming a zero
    // origin (and follow the viewport as it scrolls).
    const place = () => {
      const el = highlightRef.current;
      const host = el?.offsetParent as HTMLElement | null;
      const firstRow = term.element?.querySelector(".xterm-rows")
        ?.firstElementChild as HTMLElement | null;
      if (!el || !host || !firstRow) return;
      const cellHeight = firstRow.offsetHeight || 18;
      const top = firstRow.getBoundingClientRect().top - host.getBoundingClientRect().top;
      el.style.top = `${top + term.buffer.active.cursorY * cellHeight}px`;
      el.style.height = `${cellHeight}px`;
    };
    const cursorDisposable = term.onCursorMove(place);
    const scrollDisposable = term.onScroll(place);

    // A ResizeObserver covers window resizes, tab switches and split panes;
    // a hidden container reports zero and would make `fit` produce nonsense.
    const observer = new ResizeObserver(() => {
      if (container.clientWidth === 0 || container.clientHeight === 0) return;
      fit.fit();
    });
    observer.observe(container);

    if (autoFocusRef.current && active) term.focus();

    return () => {
      observer.disconnect();
      cursorDisposable.dispose();
      scrollDisposable.dispose();
      dataDisposable.dispose();
      resizeDisposable.dispose();
      exposeRef.current?.(null);
      handleRef.current = null;
      termRef.current = null;
      fitRef.current = null;
      term.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.theme = theme;
  }, [theme]);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = fontFamily;
    term.options.fontSize = fontSize;
    // Cell metrics changed, so the grid has to be recomputed; `onResize`
    // reports the new size to the caller.
    fitRef.current?.fit();
  }, [fontFamily, fontSize]);

  useEffect(() => {
    const term = termRef.current;
    if (term) term.options.tabStopWidth = tabStopWidth;
  }, [tabStopWidth]);

  useEffect(() => {
    const el = highlightRef.current;
    if (el) el.style.display = highlightCurrentLine ? "block" : "none";
  }, [highlightCurrentLine]);

  // Becoming visible changes the measurable size; wait a frame so the
  // container's display is already applied.
  useEffect(() => {
    if (!active) return;
    const id = requestAnimationFrame(() => {
      fitRef.current?.fit();
      if (autoFocusRef.current) termRef.current?.focus();
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  return (
    <div className={cn("relative h-full w-full", className)}>
      <div ref={containerRef} className="h-full w-full p-2" />
      <div
        ref={highlightRef}
        className="bg-primary/10 pointer-events-none absolute right-2 left-2"
        style={{ display: highlightCurrentLine ? "block" : "none", top: 0, height: 0 }}
      />
    </div>
  );
}
