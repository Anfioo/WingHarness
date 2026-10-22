import { invokeCommand } from "../../base";

/** Spawn a local shell (cmd.exe on Windows) and return its session id. */
export function localShellStart(cols: number, rows: number): Promise<string> {
  return invokeCommand<{ cols: number; rows: number }, string>("local_shell_start", { cols, rows });
}

/** Send user-typed input bytes to the shell. */
export function localShellWrite(sessionId: string, data: string): Promise<void> {
  return invokeCommand<{ sessionId: string; data: string }, void>("local_shell_write", {
    sessionId,
    data,
  });
}

/** Resize the PTY window. */
export function localShellResize(sessionId: string, cols: number, rows: number): Promise<void> {
  return invokeCommand<{ sessionId: string; cols: number; rows: number }, void>(
    "local_shell_resize",
    { sessionId, cols, rows }
  );
}

/** Kill the shell process and release its PTY. */
export function localShellKill(sessionId: string): Promise<void> {
  return invokeCommand<{ sessionId: string }, void>("local_shell_kill", { sessionId });
}

/** List system-installed font family names. */
export function listLocalShellFonts(): Promise<string[]> {
  return invokeCommand<Record<string, never>, string[]>("local_shell_list_fonts", {});
}
