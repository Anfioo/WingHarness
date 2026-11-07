// Working-directory control for the active tab.
//
// Read-only by default; editing is a plain text field on purpose (no folder
// dialog, no browsing). The store decides whether a change reuses the tab or
// opens a new one.

import { useEffect, useState } from "react";
import type { JSX } from "react";
import { Check, FolderOpen, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAgentChatStore } from "@/features/agent-chat/store";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** Windows drive/UNC paths and POSIX paths; the CLI rejects anything else. */
function isAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

export function AgentCwdControl(): JSX.Element {
  const { t } = useAppTranslation();
  const tabId = useAgentChatStore((state) => state.activeTabId);
  const workspacePath = useAgentChatStore(
    (state) => state.tabs.find((tab) => tab.tabId === state.activeTabId)?.workspacePath ?? ""
  );
  const setWorkspace = useAgentChatStore((state) => state.setWorkspace);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(workspacePath);
  const [invalid, setInvalid] = useState(false);

  useEffect(() => {
    setDraft(workspacePath);
    setEditing(false);
    setInvalid(false);
  }, [workspacePath, tabId]);

  if (!tabId) return <></>;

  function confirm() {
    if (!tabId) return;
    const next = draft.trim();
    if (!next || !isAbsolutePath(next)) {
      setInvalid(true);
      return;
    }
    setWorkspace(tabId, next);
    setEditing(false);
    setInvalid(false);
  }

  function cancel() {
    setDraft(workspacePath);
    setEditing(false);
    setInvalid(false);
  }

  if (editing) {
    return (
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        <Input
          className="h-8 w-64 font-mono text-xs"
          value={draft}
          autoFocus
          aria-label={t("agentChat.cwd.label")}
          aria-invalid={invalid}
          placeholder={t("agentChat.cwd.placeholder")}
          title={t("agentChat.cwd.hint")}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              confirm();
            } else if (event.key === "Escape") {
              event.preventDefault();
              cancel();
            }
          }}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={confirm}
          aria-label={t("agentChat.cwd.confirm")}
          title={t("agentChat.cwd.confirm")}
        >
          <Check />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={cancel}
          aria-label={t("agentChat.cwd.cancel")}
          title={t("agentChat.cwd.cancel")}
        >
          <X />
        </Button>
        {invalid ? (
          <span className="text-destructive text-xs">{t("agentChat.cwd.invalid")}</span>
        ) : null}
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <FolderOpen className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span
        className="text-muted-foreground max-w-72 truncate font-mono text-xs"
        title={workspacePath}
      >
        {workspacePath || t("agentChat.cwd.placeholder")}
      </span>
      <Button
        variant="ghost"
        size="xs"
        onClick={() => {
          setDraft(workspacePath);
          setEditing(true);
        }}
        aria-label={t("agentChat.cwd.change")}
        title={t("agentChat.cwd.hint")}
      >
        {t("agentChat.cwd.change")}
      </Button>
    </div>
  );
}
