import { useCallback, useEffect, useState } from "react";
import { Eraser, Send, Square } from "lucide-react";
import { projectActive } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useClaudeCode } from "@/lib/use-claude";
import { AskDialog } from "./ask-dialog";
import { CliLogSheet } from "./cli-log-sheet";
import { HistorySheet, type RestoredSession } from "./history-sheet";
import { ModelPicker } from "./model-picker";
import { TranscriptPane } from "./transcript-pane";

/** Empty means "whatever the CLI and its provider config decide". */
const MODEL_KEY = "claude-chat-model";

/** Mirrors the CLI's Shift+Tab selector, forwarded as `--permission-mode`. */
const PERMISSION_KEY = "claude-chat-permission";
const PERMISSION_DEFAULT = "manual";
const PERMISSIONS = [
  "manual",
  "acceptEdits",
  "auto",
  "plan",
  "dontAsk",
  "bypassPermissions",
] as const;

type Permission = (typeof PERMISSIONS)[number];

function isPermission(value: string): value is Permission {
  return (PERMISSIONS as readonly string[]).includes(value);
}

/**
 * A stored value can predate this list — `default` was renamed to `manual` and
 * has no effect any more — so anything unrecognised falls back to the default
 * instead of leaving the selector on a mode the CLI never receives.
 */
function readPermission(): Permission {
  const stored = readSetting(PERMISSION_KEY, PERMISSION_DEFAULT);
  return isPermission(stored) ? stored : PERMISSION_DEFAULT;
}

function readSetting(key: string, fallback: string): string {
  try {
    return localStorage.getItem(key) || fallback;
  } catch {
    return fallback;
  }
}

function writeSetting(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // A failed write only means the choice is not remembered next time.
  }
}

/**
 * The chat page.
 *
 * Only the working directory and an explicit clear start a *new* conversation:
 * both mean "another project" or "start over". The model and the permission mode
 * are per-turn — `useClaudeCode` forwards them to the next message, the way the
 * CLI's own `/model` and Shift+Tab do — so the transcript survives the change.
 */
export default function ClaudeChatPage() {
  const [cwd, setCwd] = useState<string | null>(null);
  const [model, setModel] = useState(() => readSetting(MODEL_KEY, ""));
  const [permission, setPermission] = useState<Permission>(readPermission);
  const [sessionKey, setSessionKey] = useState(0);
  // The history session to open with, if the user picked one from the drawer.
  const [restored, setRestored] = useState<RestoredSession | null>(null);

  // The chat runs in whichever project was opened last; with none open there is
  // no working directory to speak of, and the CLI's own cwd is the fallback.
  useEffect(() => {
    projectActive()
      .then((root) => setCwd(root || "."))
      .catch((err) => {
        console.error("Failed to read the active project:", err);
        setCwd(".");
      });
  }, []);

  // A new conversation always drops the restored history: it would otherwise be
  // re-seeded into the fresh session by the remount.
  const startNewConversation = useCallback(() => {
    setRestored(null);
    setSessionKey((key) => key + 1);
  }, []);

  // Another directory is another conversation — the CLI cannot resume a session
  // from a different working copy anyway.
  const handleCwdChange = useCallback(
    (value: string) => {
      setCwd(value);
      startNewConversation();
    },
    [startNewConversation]
  );

  const handleModelChange = useCallback((value: string) => {
    setModel(value);
    writeSetting(MODEL_KEY, value);
  }, []);

  const handlePermissionChange = useCallback((value: Permission) => {
    setPermission(value);
    writeSetting(PERMISSION_KEY, value);
  }, []);

  const handleRestore = useCallback((session: RestoredSession) => {
    setRestored(session);
    setSessionKey((key) => key + 1);
  }, []);

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        {cwd === null ? null : (
          <ChatPanel
            key={sessionKey}
            cwd={cwd}
            model={model}
            permission={permission}
            restored={restored}
            onCwdChange={handleCwdChange}
            onModelChange={handleModelChange}
            onPermissionChange={handlePermissionChange}
            onClear={startNewConversation}
            onRestore={handleRestore}
          />
        )}
      </section>
    </AppShell>
  );
}

/** One conversation. Remounted (via the parent `key`) to start a new session. */
function ChatPanel({
  cwd,
  model,
  permission,
  restored,
  onCwdChange,
  onModelChange,
  onPermissionChange,
  onClear,
  onRestore,
}: {
  cwd: string;
  model: string;
  permission: Permission;
  restored: RestoredSession | null;
  onCwdChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onPermissionChange: (value: Permission) => void;
  onClear: () => void;
  onRestore: (session: RestoredSession) => void;
}) {
  const { t } = useAppTranslation();
  const [input, setInput] = useState("");
  // The committed directory is what the session runs in; the draft is what the
  // user is typing, and only replaces it on Enter or blur so a rename does not
  // restart the conversation on every keystroke.
  const [cwdDraft, setCwdDraft] = useState(cwd);

  const {
    items,
    status,
    error,
    sessionInfo,
    pendingControl,
    logs,
    sendMessage,
    interrupt,
    respond,
    clearLogs,
  } = useClaudeCode({
    cwd,
    model,
    permissionMode: permission,
    initialItems: restored?.items,
    initialSessionId: restored?.sessionId,
  });

  const busy = status === "submitted" || status === "streaming";

  const commitCwd = useCallback(() => {
    const next = cwdDraft.trim();
    if (!next || next === cwd) {
      setCwdDraft(cwd);
      return;
    }
    onCwdChange(next);
  }, [cwdDraft, cwd, onCwdChange]);

  // Esc stops the turn, matching the CLI — but never while a prompt is open, or
  // Esc would kill the turn the dialog is waiting on instead of closing the dialog.
  useEffect(() => {
    if (!busy || pendingControl) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void interrupt();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, interrupt, pendingControl]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || busy) return;
    setInput("");
    void sendMessage(text);
  }, [input, busy, sendMessage]);

  const handleStop = useCallback(() => {
    void interrupt();
  }, [interrupt]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        handleSend();
      }
    },
    [handleSend]
  );

  const permissionLabel: Record<string, string> = {
    manual: t("claudeChat.permissionManual"),
    // The CLI still names manual mode `default` in its own session metadata.
    default: t("claudeChat.permissionManual"),
    acceptEdits: t("claudeChat.permissionAcceptEdits"),
    auto: t("claudeChat.permissionAuto"),
    plan: t("claudeChat.permissionPlan"),
    dontAsk: t("claudeChat.permissionDontAsk"),
    bypassPermissions: t("claudeChat.permissionBypass"),
  };

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="h-9 min-w-56 flex-1 font-mono text-xs"
          value={cwdDraft}
          disabled={busy}
          placeholder={t("claudeChat.cwdPlaceholder")}
          title={t("claudeChat.cwdHint")}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => setCwdDraft(event.target.value)}
          onBlur={commitCwd}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
        />
        <ModelPicker value={model} disabled={busy} onChange={onModelChange} />
        <Select
          value={permission}
          onValueChange={(value) => {
            if (isPermission(value)) onPermissionChange(value);
          }}
          disabled={busy}
        >
          <SelectTrigger size="sm" className="w-44" title={t("claudeChat.permissionLabel")}>
            <SelectValue placeholder={permissionLabel[PERMISSION_DEFAULT]} />
          </SelectTrigger>
          <SelectContent>
            {PERMISSIONS.map((value) => (
              <SelectItem key={value} value={value}>
                {permissionLabel[value]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button variant="outline" size="sm" onClick={onClear} disabled={busy}>
          <Eraser className="size-4" />
          {t("claudeChat.clear")}
        </Button>
        <HistorySheet cwd={cwd} disabled={busy} onRestore={onRestore} />
        <CliLogSheet logs={logs} onClear={clearLogs} />
      </div>

      {sessionInfo && (
        <div className="text-muted-foreground flex flex-wrap items-center gap-x-2 text-xs">
          {sessionInfo.model && <span className="font-mono">{sessionInfo.model}</span>}
          {sessionInfo.permissionMode && (
            <span className="font-mono">
              · {permissionLabel[sessionInfo.permissionMode] ?? sessionInfo.permissionMode}
            </span>
          )}
          <span className="font-mono">
            · {t("claudeChat.toolsCount", { count: sessionInfo.tools.length })}
          </span>
          {sessionInfo.mcpServers.length > 0 && (
            <span className="font-mono">
              · {t("claudeChat.mcpServers")}: {sessionInfo.mcpServers.map((s) => s.name).join(", ")}
            </span>
          )}
        </div>
      )}

      <TranscriptPane items={items} />

      {error && (
        <div className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border p-3 text-xs">
          {error}
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          className="min-h-16 flex-1 resize-none"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("claudeChat.placeholder")}
          disabled={busy}
        />
        <Button onClick={handleSend} disabled={busy || !input.trim()}>
          <Send className="size-4" />
          {t("claudeChat.send")}
        </Button>
        {busy && (
          <Button variant="outline" onClick={handleStop}>
            <Square className="size-4" />
            {t("claudeChat.stop")}
          </Button>
        )}
      </div>
      <p className="text-muted-foreground -mt-2 text-xs">{t("claudeChat.hint")}</p>

      {pendingControl && (
        // Keyed by request so each prompt gets a fresh dialog and countdown.
        <AskDialog
          key={pendingControl.requestId}
          request={pendingControl}
          onRespond={(response) => void respond(pendingControl.requestId, response)}
        />
      )}
    </>
  );
}
