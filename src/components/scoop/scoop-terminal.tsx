import { useEffect, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { localShellKill, localShellResize, localShellStart } from "@/commands";
import { base64ToBytes } from "@/commands/services/servers";
import {
  useTerminalTheme,
  XtermHost,
  type TerminalSize,
  type XtermHostHandle,
} from "@/components/terminal/xterm-host";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopRun } from "@/lib/scoop/page";

type OutputPayload = { sessionId: string; data: string };
type ExitPayload = { sessionId: string; code: number | null };

type Props = {
  /** A new `id` starts a new process; `null` leaves the surface idle. */
  run: ScoopRun | null;
  onExit: (code: number | null) => void;
};

/**
 * The visible side of a prepared Scoop run: one PTY session streamed into the
 * shared xterm surface. There is no input path — the commands are
 * non-interactive, so keystrokes have nowhere to go.
 */
export function ScoopTerminal({ run, onExit }: Props) {
  const { t } = useAppTranslation();
  const theme = useTerminalTheme();
  const [handle, setHandle] = useState<XtermHostHandle | null>(null);
  const handleRef = useRef<XtermHostHandle | null>(null);
  const sessionRef = useRef<string | null>(null);
  // An exit can arrive before `local_shell_start` resolves; remembering it by
  // session id keeps a fast command from finishing unnoticed.
  const exitsRef = useRef(new Map<string, number | null>());
  const onExitRef = useRef(onExit);

  useEffect(() => {
    onExitRef.current = onExit;
  }, [onExit]);

  useEffect(() => {
    let disposed = false;
    let unlistenOutput: UnlistenFn | undefined;
    let unlistenExit: UnlistenFn | undefined;

    void listen<OutputPayload>("local-shell-output", (event) => {
      if (event.payload.sessionId !== sessionRef.current) return;
      handleRef.current?.write(base64ToBytes(event.payload.data));
    }).then((fn) => {
      if (disposed) fn();
      else unlistenOutput = fn;
    });

    void listen<ExitPayload>("local-shell-exit", (event) => {
      const { sessionId, code } = event.payload;
      exitsRef.current.set(sessionId, code);
      if (sessionRef.current !== sessionId) return;
      sessionRef.current = null;
      onExitRef.current(code);
    }).then((fn) => {
      if (disposed) fn();
      else unlistenExit = fn;
    });

    return () => {
      disposed = true;
      unlistenOutput?.();
      unlistenExit?.();
      if (sessionRef.current) {
        void localShellKill(sessionRef.current);
        sessionRef.current = null;
      }
    };
  }, []);

  const attach = (next: XtermHostHandle | null) => {
    handleRef.current = next;
    setHandle(next);
  };

  useEffect(() => {
    if (!run || !handle) return;
    let cancelled = false;
    const cols = handle.term.cols;
    const rows = handle.term.rows;
    handle.clear();

    void (async () => {
      const previous = sessionRef.current;
      if (previous) {
        await localShellKill(previous);
        sessionRef.current = null;
      }

      try {
        const sessionId = await localShellStart(cols, rows, {
          command: run.command,
          cwd: run.cwd,
          env: run.env,
        });

        if (cancelled) {
          void localShellKill(sessionId);
          return;
        }

        if (exitsRef.current.has(sessionId)) {
          const code = exitsRef.current.get(sessionId) ?? null;
          exitsRef.current.delete(sessionId);
          onExitRef.current(code);
          return;
        }

        sessionRef.current = sessionId;
      } catch (error) {
        handleRef.current?.write(
          `\r\n${error instanceof Error ? error.message : String(error)}\r\n`
        );
        onExitRef.current(-1);
      }
    })();

    return () => {
      cancelled = true;
    };
    // `run.id` is the generation: the same flight restarted starts a new PTY.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [run?.id, handle]);

  const handleResize = ({ cols, rows }: TerminalSize) => {
    if (sessionRef.current) void localShellResize(sessionRef.current, cols, rows);
  };

  return (
    <div className="bg-background relative h-64 overflow-hidden rounded-lg border">
      <XtermHost
        theme={theme}
        fontFamily="Consolas"
        fontSize={12}
        scrollback={5000}
        active
        expose={attach}
        onResize={handleResize}
      />
      {!run && (
        <div className="text-muted-foreground pointer-events-none absolute inset-0 flex items-center justify-center text-xs">
          {t("scoop.run.idle")}
        </div>
      )}
    </div>
  );
}
