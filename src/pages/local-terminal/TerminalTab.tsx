import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { localShellKill, localShellResize, localShellStart, localShellWrite } from "@/commands";
import { base64ToBytes } from "@/commands/services/servers";
import {
  useTerminalTheme,
  XtermHost,
  type TerminalSize,
  type XtermHostHandle,
} from "@/components/terminal/xterm-host";
import type { TerminalPrefs } from "./prefs";

type OutputPayload = { sessionId: string; data: string };
type ExitPayload = { sessionId: string; code: number | null };

type Props = {
  sessionId: string; // stable per tab; used as React key
  active: boolean;
  prefs: TerminalPrefs;
  onExit?: (sessionId: string, code: number | null) => void;
};

/**
 * One local shell tab. The terminal surface lives in `xterm-host`; this keeps
 * the PTY lifecycle, the output/exit events and the auto-wrap preference.
 */
export function TerminalTab({ sessionId, active, prefs, onExit }: Props) {
  const handleRef = useRef<XtermHostHandle | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  // Bumped on every (re)attach so a shell started by a superseded generation
  // is killed instead of adopted. Also covers StrictMode's double mount.
  const bootRef = useRef(0);
  const theme = useTerminalTheme();

  const onExitRef = useRef(onExit);
  const autoWrapRef = useRef(prefs.autoWrap);
  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    let disposed = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    void listen<OutputPayload>("local-shell-output", (event) => {
      if (event.payload.sessionId !== ptyIdRef.current) return;
      handleRef.current?.write(base64ToBytes(event.payload.data));
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutput = fn;
    });

    void listen<ExitPayload>("local-shell-exit", (event) => {
      if (event.payload.sessionId !== ptyIdRef.current) return;
      handleRef.current?.write(
        `\r\n[进程已退出${event.payload.code === null ? "" : `，退出码 ${event.payload.code}`}]\r\n`
      );
      onExitRef.current?.(sessionId, event.payload.code);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    return () => {
      disposed = true;
      bootRef.current += 1;
      unlistenOutput?.();
      unlistenExit?.();
      if (ptyIdRef.current) {
        void localShellKill(ptyIdRef.current);
        ptyIdRef.current = null;
      }
    };
  }, [sessionId]);

  useEffect(() => {
    autoWrapRef.current = prefs.autoWrap;
    if (!ptyIdRef.current) return;
    void localShellWrite(ptyIdRef.current, prefs.autoWrap ? "\x1b[?7h" : "\x1b[?7l");
  }, [prefs.autoWrap]);

  const startShell = async (generation: number, cols: number, rows: number) => {
    const id = await localShellStart(cols, rows);
    if (generation !== bootRef.current) {
      void localShellKill(id);
      return;
    }
    ptyIdRef.current = id;
    // Apply auto-wrap on the shell side (DECAWM).
    if (autoWrapRef.current) void localShellWrite(id, "\x1b[?7h");
  };

  const attach = (handle: XtermHostHandle | null) => {
    handleRef.current = handle;
    if (!handle) return;
    const generation = (bootRef.current += 1);
    if (ptyIdRef.current) {
      void localShellKill(ptyIdRef.current);
      ptyIdRef.current = null;
    }
    void startShell(generation, handle.term.cols, handle.term.rows);
  };

  const handleData = (data: string) => {
    if (ptyIdRef.current) void localShellWrite(ptyIdRef.current, data);
  };

  const handleResize = ({ cols, rows }: TerminalSize) => {
    if (ptyIdRef.current) void localShellResize(ptyIdRef.current, cols, rows);
  };

  return (
    <XtermHost
      theme={theme}
      fontFamily={prefs.fontFamily}
      fontSize={prefs.fontSize}
      tabStopWidth={prefs.tabStopWidth}
      highlightCurrentLine={prefs.highlightCurrentLine}
      active={active}
      autoFocus
      expose={attach}
      onData={handleData}
      onResize={handleResize}
    />
  );
}
