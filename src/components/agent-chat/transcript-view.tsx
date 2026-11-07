import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { JSX } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useScrollFollow } from "@/features/agent-chat/scroll";
import { useAgentChatStore } from "@/features/agent-chat/store";
import type { AgentMessageRow as AgentMessageRowData } from "@/features/agent-chat/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { AgentMessageRow } from "./message-row";
import { AgentToolExpansionProvider, type ToolExpansionState } from "./tool-card";

const EMPTY_ROWS: AgentMessageRowData[] = [];

const ESTIMATED_HEIGHT: Record<AgentMessageRowData["kind"], number> = {
  user: 120,
  assistant: 120,
  tool: 64,
  thinking: 56,
  question: 320,
  grant: 140,
  error: 80,
};

export function AgentTranscriptView(): JSX.Element {
  const { t } = useAppTranslation();
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const tab = useAgentChatStore((state) =>
    state.activeTabId ? state.byTab[state.activeTabId] : undefined
  );
  const loadEarlier = useAgentChatStore((state) => state.loadEarlier);
  const send = useAgentChatStore((state) => state.send);

  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const rows = tab?.messages ?? EMPTY_ROWS;
  const { atBottom, scrollToBottom } = useScrollFollow({ scrollerRef, itemCount: rows.length });

  // Expansion lives here because virtual rows unmount as they leave the window.
  const [expanded, setExpanded] = useState<Map<number, boolean>>(() => new Map());
  const toolExpansion = useMemo<ToolExpansionState>(
    () => ({
      isOpen: (seq) => expanded.get(seq),
      setOpen: (seq, open) =>
        setExpanded((current) => {
          const next = new Map(current);
          next.set(seq, open);
          return next;
        }),
    }),
    [expanded]
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollerRef.current,
    estimateSize: (index) => ESTIMATED_HEIGHT[rows[index].kind],
    overscan: 6,
    getItemKey: (index) => rows[index].seq,
  });

  useLayoutEffect(() => {
    scrollToBottom("auto");
  }, [activeTabId, scrollToBottom]);

  const lastUser = useMemo(() => {
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index];
      if (row.kind === "user") return row;
    }
    return null;
  }, [rows]);

  let statusText: string | null = null;
  if (tab?.retry) {
    statusText = t("agentChat.status.retrying", {
      attempt: tab.retry.attempt,
      max: tab.retry.max,
    });
  } else if (tab?.compacting) {
    statusText = t("agentChat.status.compacting");
  } else if (tab?.status === "launching") {
    statusText = t("agentChat.status.launching");
  } else if (tab?.status === "streaming") {
    statusText = t("agentChat.status.streaming");
  }

  const showLoadEarlier = Boolean(activeTabId && tab?.nextBefore != null);

  return (
    <AgentToolExpansionProvider state={toolExpansion}>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {tab?.error ? (
          <div className="border-destructive/40 bg-destructive/5 mx-3 mt-2 flex items-start gap-2 rounded-lg border px-3 py-2 text-xs">
            <div className="min-w-0 flex-1">
              <div className="text-destructive font-medium">{t("agentChat.message.error")}</div>
              <div className="text-muted-foreground break-words">{tab.error.message}</div>
            </div>
            {lastUser ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (activeTabId) void send(activeTabId, lastUser.text);
                }}
              >
                {t("agentChat.sidebar.retry")}
              </Button>
            ) : null}
          </div>
        ) : null}

        {showLoadEarlier ? (
          <div className="flex justify-center px-3 pt-2">
            <Button
              size="xs"
              variant="ghost"
              disabled={tab?.loading}
              onClick={() => {
                if (activeTabId) void loadEarlier(activeTabId);
              }}
            >
              {tab?.loading ? <Loader2 className="animate-spin" /> : null}
              {t("agentChat.history.loadEarlier")}
            </Button>
          </div>
        ) : null}

        <div ref={scrollerRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-3xl px-4 py-4">
            {rows.length === 0 ? (
              <div className="py-16 text-center">
                {tab?.loading ? (
                  <div className="mx-auto flex w-full max-w-md flex-col gap-2">
                    <Skeleton className="h-10 w-2/3" />
                    <Skeleton className="ml-auto h-10 w-1/2" />
                    <Skeleton className="h-16 w-full" />
                  </div>
                ) : (
                  <p className="text-muted-foreground text-sm">{t("agentChat.subtitle")}</p>
                )}
              </div>
            ) : (
              <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
                {virtualizer.getVirtualItems().map((item) => (
                  <div
                    key={item.key}
                    data-index={item.index}
                    ref={virtualizer.measureElement}
                    className="absolute inset-x-0 top-0 pb-3"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <AgentMessageRow row={rows[item.index]} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {statusText ? (
          <div className="text-muted-foreground flex items-center gap-1.5 px-4 pb-2 text-xs">
            <Loader2 className="size-3 animate-spin" />
            <span>{statusText}</span>
          </div>
        ) : null}

        {!atBottom && rows.length > 0 ? (
          <Button
            size="icon-sm"
            variant="secondary"
            aria-label={t("agentChat.scrollToBottom")}
            className="absolute right-4 bottom-10 z-10 rounded-full shadow-md"
            onClick={() => scrollToBottom("smooth")}
          >
            <ArrowDown />
          </Button>
        ) : null}
      </div>
    </AgentToolExpansionProvider>
  );
}
