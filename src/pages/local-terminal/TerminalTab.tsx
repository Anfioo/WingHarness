import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { localShellKill, localShellResize, localShellStart, localShellWrite } from "@/commands";
import { terminalThemeFromTokens } from "@/lib/terminal/theme";
import type { TerminalPrefs } from "./prefs";

type OutputPayload = { sessionId: string; data: string };

function decodeBase64(input: string): Uint8Array {
  const binary = atob(input);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type Props = {
  sessionId: string; // stable per tab; used as React key
  active: boolean;
  prefs: TerminalPrefs;
  onExit?: (sessionId: string, code: number | null) => void;
};

export function TerminalTab({ sessionId, active, prefs, onExit }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const highlightRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);

  // Mount: create terminal + PTY once.
  useEffect(() => {
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;
    let disposed = false;
    let resizeHandler: (() => void) | undefined;
    let term: Terminal | null = null;

    async function boot() {
      if (!containerRef.current) return;

      term = new Terminal({
        fontFamily: prefs.fontFamily,
        fontSize: prefs.fontSize,
        tabStopWidth: prefs.tabStopWidth,
        cursorBlink: true,
        scrollback: 5000,
        theme: terminalThemeFromTokens(),
      });
      const t = term;
      const fit = new FitAddon();
      t.loadAddon(fit);
      t.open(containerRef.current!);
      fit.fit();
      termRef.current = t;
      fitRef.current = fit;

      ptyIdRef.current = await localShellStart(t.cols, t.rows);

      unlistenOutput = await listen<OutputPayload>("local-shell-output", (event) => {
        if (disposed || event.payload.sessionId !== ptyIdRef.current) return;
        t.write(decodeBase64(event.payload.data));
      });

      unlistenExit = await listen<{ sessionId: string; code: number | null }>(
        "local-shell-exit",
        (event) => {
          if (event.payload.sessionId === ptyIdRef.current) {
            t.write(
              `\r\n[进程已退出${event.payload.code === null ? "" : `，退出码 ${event.payload.code}`}]\r\n`
            );
            onExit?.(sessionId, event.payload.code);
          }
        }
      );

      t.onData((data) => {
        if (ptyIdRef.current) void localShellWrite(ptyIdRef.current, data);
      });

      // Cursor tracking for current-line highlight. The overlay sits in the
      // wrapper's coordinate space, but the terminal is inset by the
      // container's padding, so anchor to the first visible row instead of
      // assuming a zero origin (and follow the viewport as it scrolls).
      const place = () => {
        const el = highlightRef.current;
        const host = el?.offsetParent as HTMLElement | null;
        const firstRow = t.element?.querySelector(".xterm-rows")
          ?.firstElementChild as HTMLElement | null;
        if (!el || !host || !firstRow) return;
        const cellHeight = firstRow.offsetHeight || 18;
        const top = firstRow.getBoundingClientRect().top - host.getBoundingClientRect().top;
        el.style.top = `${top + t.buffer.active.cursorY * cellHeight}px`;
        el.style.height = `${cellHeight}px`;
      };
      t.onCursorMove(place);
      t.onScroll(place);

      resizeHandler = () => {
        if (!ptyIdRef.current) return;
        fit.fit();
        void localShellResize(ptyIdRef.current, t.cols, t.rows);
      };
      window.addEventListener("resize", resizeHandler);

      // Apply auto-wrap on the shell side (DECAWM).
      if (prefs.autoWrap) {
        void localShellWrite(ptyIdRef.current, "\x1b[?7h");
      }
    }

    void boot();

    return () => {
      disposed = true;
      if (resizeHandler) window.removeEventListener("resize", resizeHandler);
      void unlistenOutput?.();
      void unlistenExit?.();
      if (ptyIdRef.current) void localShellKill(ptyIdRef.current);
      term?.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Follow the app's light/dark theme, like the git terminal: the theme class on
  // <html> is the signal, so re-derive the xterm theme whenever it flips.
  useEffect(() => {
    const apply = () => {
      const term = termRef.current;
      if (term) term.options.theme = terminalThemeFromTokens();
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  // When the tab becomes visible, refit (xterm can't measure a hidden container).
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term || !fit || !ptyIdRef.current) return;
    // Wait a frame so the container's display is already applied.
    const id = requestAnimationFrame(() => {
      fit.fit();
      void localShellResize(ptyIdRef.current!, term.cols, term.rows);
    });
    return () => cancelAnimationFrame(id);
  }, [active]);

  // Live-apply preference changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    term.options.fontFamily = prefs.fontFamily;
    term.options.fontSize = prefs.fontSize;
    term.options.tabStopWidth = prefs.tabStopWidth;
    if (highlightRef.current) {
      highlightRef.current.style.display = prefs.highlightCurrentLine ? "block" : "none";
    }
    // Re-fit after font change, and propagate auto-wrap mode to the shell.
    const fit = fitRef.current;
    if (fit) {
      fit.fit();
      if (ptyIdRef.current) void localShellResize(ptyIdRef.current, term.cols, term.rows);
    }
    if (ptyIdRef.current) {
      void localShellWrite(ptyIdRef.current, prefs.autoWrap ? "\x1b[?7h" : "\x1b[?7l");
    }
  }, [prefs]);

  return (
    <div className="relative h-full w-full">
      <div ref={containerRef} className="h-full w-full p-2" />
      <div
        ref={highlightRef}
        className="bg-primary/10 pointer-events-none absolute right-2 left-2"
        style={{ display: prefs.highlightCurrentLine ? "block" : "none", top: 0, height: 0 }}
      />
    </div>
  );
}
