// The open-session tab strip.
//
// Each tab is an independent run. The tab key is the locally generated tab id,
// so a conversation keeps its streaming rows while the engine reports the
// native session id. Closing a running tab interrupts its run first.

import type { KeyboardEvent } from "react";
import { Plus, X } from "lucide-react";

import type { AgentSessionMeta, AgentTab } from "@/commands/services/agent-chat/types";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  AGENT_MAX_TABS,
  resolveDefaultWorkspace,
  useAgentChatStore,
} from "@/features/agent-chat/store";
import { cn } from "@/lib/utils";

function findSession(sessions: AgentSessionMeta[], tab: AgentTab): AgentSessionMeta | undefined {
  if (!tab.sessionId) return undefined;
  return sessions.find(
    (session) =>
      session.engine === tab.engine &&
      session.sessionId === tab.sessionId &&
      session.workspacePath === tab.workspacePath
  );
}

export function AgentSessionTabs() {
  const { t } = useAppTranslation();
  const tabs = useAgentChatStore((state) => state.tabs);
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const byTab = useAgentChatStore((state) => state.byTab);
  const sessions = useAgentChatStore((state) => state.sessions);
  const focusTab = useAgentChatStore((state) => state.focusTab);
  const closeTab = useAgentChatStore((state) => state.closeTab);
  const newTab = useAgentChatStore((state) => state.newTab);

  const atLimit = tabs.length >= AGENT_MAX_TABS;
  const activeTab = tabs.find((tab) => tab.tabId === activeTabId) ?? null;

  async function handleNewTab() {
    if (atLimit) return;
    const engine = activeTab?.engine ?? tabs[0]?.engine ?? "claude";
    const workspace = activeTab?.workspacePath || (await resolveDefaultWorkspace());
    newTab(engine, workspace);
  }

  async function handleCloseOthers(tabId: string) {
    const targets = useAgentChatStore.getState().tabs.filter((tab) => tab.tabId !== tabId);
    for (const target of targets) await closeTab(target.tabId);
    focusTab(tabId);
  }

  async function handleCloseAll() {
    const targets = useAgentChatStore.getState().tabs.slice();
    for (const target of targets) await closeTab(target.tabId);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLDivElement>, tabId: string) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    focusTab(tabId);
  }

  const newTabButton = (
    <Button
      variant="ghost"
      size="icon-sm"
      onClick={() => void handleNewTab()}
      disabled={atLimit}
      aria-label={t("agentChat.tab.new")}
      title={atLimit ? t("agentChat.tab.limit", { count: AGENT_MAX_TABS }) : t("agentChat.tab.new")}
    >
      <Plus />
    </Button>
  );

  return (
    <div
      role="tablist"
      aria-label={t("agentChat.title")}
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b px-2 py-1.5"
    >
      {tabs.map((tab) => {
        const session = findSession(sessions, tab);
        const title = session?.title.trim() || t("agentChat.tab.untitled");
        const active = tab.tabId === activeTabId;
        const streaming = byTab[tab.tabId]?.status === "streaming";

        return (
          <ContextMenu key={tab.tabId}>
            <ContextMenuTrigger asChild>
              <div
                role="tab"
                aria-selected={active}
                tabIndex={active ? 0 : -1}
                title={title}
                onClick={() => focusTab(tab.tabId)}
                onKeyDown={(event) => handleKeyDown(event, tab.tabId)}
                className={cn(
                  "group/tab flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border px-2.5 py-1 text-xs transition-colors",
                  "focus-visible:ring-ring/50 outline-none focus-visible:ring-[3px]",
                  active
                    ? "bg-background text-foreground shadow-sm"
                    : "bg-muted/40 text-muted-foreground hover:bg-muted"
                )}
              >
                <span className="max-w-[160px] truncate">{title}</span>
                {streaming ? (
                  <span
                    className="bg-primary size-1.5 shrink-0 animate-pulse rounded-full"
                    aria-hidden
                  />
                ) : null}
                <button
                  type="button"
                  aria-label={t("agentChat.tab.close")}
                  title={t("agentChat.tab.close")}
                  onClick={(event) => {
                    event.stopPropagation();
                    void closeTab(tab.tabId);
                  }}
                  className="hover:bg-accent hover:text-accent-foreground -mr-1 rounded p-0.5"
                >
                  <X className="size-3" />
                </button>
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem onSelect={() => void closeTab(tab.tabId)}>
                {t("agentChat.tab.close")}
              </ContextMenuItem>
              <ContextMenuItem onSelect={() => void handleCloseOthers(tab.tabId)}>
                {t("agentChat.tab.closeOthers")}
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem onSelect={() => void handleCloseAll()}>
                {t("agentChat.tab.closeAll")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        );
      })}

      {atLimit ? (
        <TooltipProvider delayDuration={0}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span tabIndex={0} className="shrink-0">
                {newTabButton}
              </span>
            </TooltipTrigger>
            <TooltipContent>{t("agentChat.tab.limit", { count: AGENT_MAX_TABS })}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className="shrink-0">{newTabButton}</div>
      )}
    </div>
  );
}
