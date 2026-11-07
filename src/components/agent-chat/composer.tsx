// The input dock: the engine/model/permission/workspace toolbar, the
// multi-line prompt, and one Send/Stop action.

import { useEffect, useRef } from "react";
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from "react";
import { SendHorizontal, Square } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { resolveDefaultWorkspace, useAgentChatStore } from "@/features/agent-chat/store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { AgentCwdControl } from "./cwd-control";
import { AgentEnginePicker } from "./engine-picker";
import { AgentModelPicker } from "./model-picker";
import { AgentPermissionPicker } from "./permission-picker";

export function AgentComposer(): JSX.Element {
  const { t } = useAppTranslation();
  const activeTab = useAgentChatStore((state) =>
    state.tabs.find((tab) => tab.tabId === state.activeTabId)
  );
  const tabState = useAgentChatStore((state) =>
    state.activeTabId ? state.byTab[state.activeTabId] : undefined
  );
  const draft = useAgentChatStore((state) =>
    state.activeTabId ? (state.drafts[state.activeTabId] ?? "") : ""
  );
  const engines = useAgentChatStore((state) => state.engines);
  const setDraft = useAgentChatStore((state) => state.setDraft);
  const send = useAgentChatStore((state) => state.send);
  const interrupt = useAgentChatStore((state) => state.interrupt);
  const newTab = useAgentChatStore((state) => state.newTab);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const activeTabId = activeTab?.tabId ?? null;
  const busy = tabState?.status === "launching" || tabState?.status === "streaming";
  const engine = engines.find((item) => item.id === activeTab?.engine);
  const engineAvailable = engine?.available ?? false;
  const trimmed = draft.trim();
  const canSend = Boolean(activeTabId && tabState && !busy && engineAvailable && trimmed);

  // Esc interrupts only while the prompt has focus, so it never steals the key
  // from a dialog or a select opened elsewhere on the page.
  useEffect(() => {
    if (!busy || !activeTabId) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      if (document.activeElement !== textareaRef.current) return;
      event.preventDefault();
      void interrupt(activeTabId);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, activeTabId, interrupt]);

  if (!activeTabId) {
    return (
      <div className="flex shrink-0 flex-col items-center gap-2 border-t p-6 text-center">
        <p className="text-sm font-medium">{t("agentChat.empty.title")}</p>
        <p className="text-muted-foreground text-xs">{t("agentChat.empty.hint")}</p>
        <Button
          size="sm"
          onClick={() => {
            const nextEngine = useAgentChatStore.getState().tabs[0]?.engine ?? "claude";
            void resolveDefaultWorkspace().then((workspace) => newTab(nextEngine, workspace));
          }}
        >
          {t("agentChat.empty.newTab")}
        </Button>
      </div>
    );
  }

  function submit() {
    if (!canSend || !activeTabId) return;
    // The store keeps the user row even when the run fails, so the draft is
    // cleared up front instead of being held until the answer arrives.
    setDraft(activeTabId, "");
    void send(activeTabId, draft);
  }

  function handleKeyDown(event: ReactKeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    submit();
  }

  let disabledReason: string | null = null;
  if (!engineAvailable) {
    const install = t(`agentChat.install.${activeTab?.engine ?? ""}`);
    disabledReason = `${t("agentChat.error.engineUnavailable")} ${install}`;
  } else if (!trimmed) {
    disabledReason = t("agentChat.composer.emptyPrompt");
  }

  const sendButton = (
    <Button
      type="button"
      onClick={submit}
      disabled={!canSend}
      aria-label={t("agentChat.composer.send")}
    >
      <SendHorizontal />
      {t("agentChat.composer.send")}
    </Button>
  );

  return (
    <div className="flex shrink-0 flex-col gap-2 border-t p-3">
      {engine && !engineAvailable ? (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 flex flex-col gap-1 rounded-lg border px-3 py-2 text-xs"
        >
          <span className="text-destructive font-medium">
            {t("agentChat.error.engineUnavailable")}
          </span>
          <code className="text-muted-foreground font-mono break-all">
            {t(`agentChat.install.${engine.id}`)}
          </code>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <AgentEnginePicker />
        <AgentModelPicker />
        <AgentPermissionPicker />
        <AgentCwdControl />
      </div>
      <Textarea
        ref={textareaRef}
        className="min-h-20 resize-none"
        value={draft}
        placeholder={t("agentChat.composer.placeholder")}
        aria-label={t("agentChat.composer.placeholder")}
        onChange={(event) => setDraft(activeTabId, event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground text-xs">{t("agentChat.composer.hint")}</p>
        {busy ? (
          <Button
            type="button"
            variant="outline"
            onClick={() => void interrupt(activeTabId)}
            aria-label={t("agentChat.composer.stop")}
          >
            <Square />
            {t("agentChat.composer.stop")}
          </Button>
        ) : disabledReason ? (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <span tabIndex={0} className="inline-flex">
                  {sendButton}
                </span>
              </TooltipTrigger>
              <TooltipContent>{disabledReason}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        ) : (
          sendButton
        )}
      </div>
    </div>
  );
}
