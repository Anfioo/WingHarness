import { useEffect, useRef, useState } from "react";
import { ClipboardPaste, Copy, Eraser, TextSelect, X } from "lucide-react";
import { listen } from "@tauri-apps/api/event";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { termCreate, termKill, termResize, termWrite } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint } from "@/features/git/diff/diff-ui";
import { useRepo } from "@/features/git/repository-store";
import { monoFontStack } from "@/lib/fonts/stack";
import { useGitSettings } from "@/features/git/settings";
import { useUi } from "@/features/git/ui-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import i18n from "@/i18n";
import { terminalThemeFromTokens } from "@/lib/terminal/theme";
import { altArrowSequence } from "./keys";
import { killTerminalSession, sessions, type TerminalSession } from "./sessions";

const TERMINAL_FONT_SIZE = 12;

function newSession(fontFamily: string | null): TerminalSession {
  const container = document.createElement("div");
  container.style.width = "100%";
  container.style.height = "100%";
  const terminal = new Terminal({
    fontFamily: monoFontStack(fontFamily),
    fontSize: TERMINAL_FONT_SIZE,
    cursorBlink: true,
    scrollback: 5000,
    theme: terminalThemeFromTokens(),
  });
  const fit = new FitAddon();
  terminal.loadAddon(fit);
  return {
    terminal,
    fit,
    container,
    termId: null,
    unlisteners: [],
    killed: false,
    exited: false,
  };
}

function altArrowHandler(send: (data: string) => void): (event: KeyboardEvent) => boolean {
  return (event) => {
    const sequence = altArrowSequence(event);
    if (sequence === null) return true;
    send(sequence);
    return false;
  };
}

function spawnShell(session: TerminalSession, repoPath: string): void {
  const { terminal } = session;
  void (async () => {
    try {
      const id = await termCreate(repoPath, terminal.cols, terminal.rows);
      if (session.killed) {
        void termKill(id);
        return;
      }
      session.termId = id;
      const dataUnlisten = await listen<{ data: string }>(`term-data-${id}`, (payload) => {
        terminal.write(payload.payload.data);
      });
      if (session.killed) {
        dataUnlisten();
        return;
      }
      session.unlisteners.push(dataUnlisten);
      const exitUnlisten = await listen(`term-exit-${id}`, () => {
        session.exited = true;
        terminal.writeln(`\r\n[${i18n.t("gitRepo.shell.terminal.exited")}]`);
      });
      if (session.killed) {
        exitUnlisten();
        return;
      }
      session.unlisteners.push(exitUnlisten);
      const send = (data: string) => void termWrite(id, data);
      terminal.onData(send);
      terminal.attachCustomKeyEventHandler(altArrowHandler(send));
      terminal.onResize(({ cols, rows }) => void termResize(id, cols, rows));
    } catch (error) {
      if (session.killed) return;
      session.exited = true;
      const message = (error as { message?: string }).message ?? String(error);
      terminal.writeln(`\r\n[${i18n.t("gitRepo.shell.terminal.startFailed", { error: message })}]`);
    }
  })();
}

export function TerminalPanel() {
  const { t } = useAppTranslation();
  const repoPath = useRepo((s) => s.repo?.path ?? null);
  const toggleTerminal = useUi((s) => s.toggleTerminal);
  const codeFontFamily = useGitSettings((s) => s.codeFontFamily);
  const hostRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; hasSelection: boolean } | null>(null);

  const current = () => (repoPath ? sessions.get(repoPath) : undefined);
  const copySelection = () => {
    const text = current()?.terminal.getSelection() ?? "";
    if (text) void navigator.clipboard.writeText(text);
  };
  const paste = async () => {
    const session = current();
    if (!session) return;
    try {
      const text = await navigator.clipboard.readText();
      if (text) session.terminal.paste(text);
    } finally {
      session.terminal.focus();
    }
  };
  const selectAll = () => current()?.terminal.selectAll();
  const clear = () => {
    const session = current();
    if (!session) return;
    session.terminal.clear();
    session.terminal.focus();
  };

  useEffect(() => {
    const apply = () => {
      const next = terminalThemeFromTokens();
      for (const session of sessions.values()) session.terminal.options.theme = next;
    };
    const observer = new MutationObserver(apply);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const family = monoFontStack(codeFontFamily);
    for (const session of sessions.values()) {
      session.terminal.options.fontFamily = family;
      session.terminal.options.fontSize = TERMINAL_FONT_SIZE;
    }
    if (repoPath) sessions.get(repoPath)?.fit.fit();
  }, [codeFontFamily, repoPath]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host || !repoPath) return;

    let session = sessions.get(repoPath);
    if (session?.exited) {
      killTerminalSession(repoPath);
      session = undefined;
    }
    const fresh = !session;
    if (!session) {
      session = newSession(codeFontFamily);
      sessions.set(repoPath, session);
    }
    host.appendChild(session.container);
    if (fresh) {
      session.terminal.open(session.container);
      session.fit.fit();
      spawnShell(session, repoPath);
    } else {
      session.terminal.options.theme = terminalThemeFromTokens();
      session.fit.fit();
    }
    session.terminal.focus();

    const attached = session;
    const observer = new ResizeObserver(() => attached.fit.fit());
    observer.observe(host);

    return () => {
      observer.disconnect();
      attached.container.remove();
    };
  }, [repoPath, codeFontFamily]);

  return (
    <div className="bg-card flex h-full flex-col">
      <div className="border-border flex h-7 shrink-0 items-center border-b px-3">
        <span className="text-muted-foreground text-[10px] font-semibold tracking-wide uppercase">
          {t("gitRepo.shell.terminal.title")}
        </span>
        <span className="text-muted-foreground/70 ml-2 min-w-0 flex-1 truncate font-mono text-[10px]">
          {repoPath}
        </span>
        <Hint label={t("gitRepo.shell.terminal.close")}>
          <Button
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0"
            aria-label={t("gitRepo.shell.terminal.close")}
            onClick={toggleTerminal}
          >
            <X className="size-3" />
          </Button>
        </Hint>
      </div>
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden"
        onContextMenu={(event) => {
          event.preventDefault();
          setMenu({
            x: event.clientX,
            y: event.clientY,
            hasSelection: current()?.terminal.hasSelection() ?? false,
          });
        }}
      />
      {menu && (
        <DropdownMenu open onOpenChange={(open) => !open && setMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: menu.x, top: menu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            side="bottom"
            onCloseAutoFocus={(event) => event.preventDefault()}
          >
            <DropdownMenuItem disabled={!menu.hasSelection} onSelect={copySelection}>
              <Copy /> {t("gitRepo.shell.terminal.copy")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void paste()}>
              <ClipboardPaste /> {t("gitRepo.shell.terminal.paste")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={selectAll}>
              <TextSelect /> {t("gitRepo.shell.terminal.selectAll")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={clear}>
              <Eraser /> {t("gitRepo.shell.terminal.clear")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
