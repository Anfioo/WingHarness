// Engine selection for the active tab.
//
// An engine is bound to a conversation. Switching inside a tab that has no
// history just re-labels it; switching anywhere else opens a new tab so the
// old engine's transcript stays intact.

import type { JSX } from "react";
import { toast } from "sonner";

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { persist, resolveDefaultWorkspace, useAgentChatStore } from "@/features/agent-chat/store";
import { useAppTranslation } from "@/hooks/use-app-translation";

export function AgentEnginePicker(): JSX.Element {
  const { t } = useAppTranslation();
  const engine = useAgentChatStore(
    (state) => state.tabs.find((tab) => tab.tabId === state.activeTabId)?.engine ?? null
  );
  const engines = useAgentChatStore((state) => state.engines);
  const newTab = useAgentChatStore((state) => state.newTab);
  const current = engines.find((item) => item.id === engine);

  const installHint = (engineId: string) => t(`agentChat.install.${engineId}`);

  function unavailableTitle(engineId: string): string {
    return `${t("agentChat.engine.unavailable")} · ${installHint(engineId)}`;
  }

  async function handleChange(next: string) {
    if (!next || next === engine) return;
    const target = engines.find((item) => item.id === next);
    if (!target) return;
    if (!target.available) {
      toast.error(t("agentChat.error.engineUnavailable"));
      return;
    }

    const state = useAgentChatStore.getState();
    const tab = state.tabs.find((candidate) => candidate.tabId === state.activeTabId);
    if (!tab) {
      newTab(next, await resolveDefaultWorkspace());
      return;
    }

    const empty = tab.sessionId === null && (state.byTab[tab.tabId]?.messages.length ?? 0) === 0;
    if (empty) {
      // The store's frozen action set has no setEngine; an empty tab has no
      // run to migrate, so relabeling it in place is the whole change.
      useAgentChatStore.setState((currentState) => ({
        tabs: currentState.tabs.map((candidate) =>
          candidate.tabId === tab.tabId ? { ...candidate, engine: next } : candidate
        ),
      }));
      persist();
      return;
    }

    const previousTabId = state.activeTabId;
    newTab(next, tab.workspacePath);
    // `newTab` refuses at the tab limit and shows its own message.
    if (useAgentChatStore.getState().activeTabId !== previousTabId) {
      toast.info(t("agentChat.newChat"));
    }
  }

  return (
    <Select
      value={engine ?? ""}
      onValueChange={(value) => void handleChange(value)}
      disabled={!engine}
    >
      <SelectTrigger
        size="sm"
        className="h-8 w-36"
        aria-label={t("agentChat.engine.label")}
        title={current && !current.available ? unavailableTitle(current.id) : undefined}
      >
        <SelectValue placeholder={t("agentChat.engine.label")} />
      </SelectTrigger>
      <SelectContent>
        {engines.map((item) => (
          <SelectItem
            key={item.id}
            value={item.id}
            disabled={!item.available}
            title={item.available ? item.label : unavailableTitle(item.id)}
          >
            <span className="flex items-center gap-2">
              <span>{item.label}</span>
              {!item.available ? (
                <span className="text-muted-foreground text-xs">
                  {t("agentChat.engine.unavailable")}
                </span>
              ) : null}
            </span>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
