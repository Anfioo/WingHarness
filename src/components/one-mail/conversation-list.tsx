// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef, type ReactNode } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertCircle, Inbox, SearchX } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useOneMailPageContext } from "@/pages/one-mail/context";
import MailFilters from "./mail-filters";
import { ConversationRow } from "./conversation-row";

/** The fixed row height the virtualizer assumes; the row fills it exactly. */
const ROW_HEIGHT = 76;
const OVERSCAN = 8;
const SKELETON_ROWS = 6;

/**
 * The conversation lane: the filter bar on top and the virtualized list below.
 *
 * The list owns its scroller (the panel it sits in clips its overflow), and the
 * page state is the only data source — the hook refetches page zero whenever
 * the account, the keyword or the filters change.
 */
export default function ConversationList() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);

  const conversations = page.conversations;
  const { hasMoreConversations, loadMoreConversations, conversationsLoading } = page;

  const virtualizer = useVirtualizer({
    count: conversations.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (index) => conversations[index]?.conversationKey ?? index,
  });

  const virtualItems = virtualizer.getVirtualItems();
  const lastIndex = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : -1;

  // Reaching the end of the rendered range asks for the next page; the hook
  // ignores the call while a page is in flight or when nothing is left.
  useEffect(() => {
    if (!hasMoreConversations || conversationsLoading) return;
    if (lastIndex < conversations.length - 1) return;
    loadMoreConversations();
  }, [
    hasMoreConversations,
    conversationsLoading,
    lastIndex,
    conversations.length,
    loadMoreConversations,
  ]);

  const hasAccounts = page.accounts.length > 0;
  const hasQuery = page.keyword.trim().length > 0;
  const hasFilters =
    page.filters.unreadOnly || page.filters.starredOnly || page.filters.range !== "all";
  const emptyBecauseOfQuery = hasQuery || hasFilters;
  const showError = page.conversationsError !== null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-border border-b px-2 py-2">
        <MailFilters />
      </div>

      {/* An error with rows already loaded keeps the rows and adds the bar. */}
      {showError && conversations.length > 0 && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive mx-2 mt-2 flex items-center gap-2 rounded-lg border px-2 py-1.5 text-[11px]"
        >
          <AlertCircle aria-hidden className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate">{page.conversationsError}</span>
          <Button variant="ghost" size="xs" onClick={page.reloadConversations}>
            {t("oneMail.common.retry")}
          </Button>
        </div>
      )}

      {showError && conversations.length === 0 ? (
        <ListState
          icon={<AlertCircle aria-hidden className="text-destructive size-6" />}
          text={page.conversationsError ?? t("oneMail.common.empty")}
          action={
            <Button variant="outline" size="sm" onClick={page.reloadConversations}>
              {t("oneMail.common.retry")}
            </Button>
          }
        />
      ) : conversationsLoading && conversations.length === 0 ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {Array.from({ length: SKELETON_ROWS }, (_, index) => (
            <div
              key={index}
              className="flex items-center gap-3 px-3"
              style={{ height: ROW_HEIGHT }}
            >
              <Skeleton className="size-9 shrink-0 rounded-full" />
              <div className="flex min-w-0 flex-1 flex-col gap-2">
                <Skeleton className="h-3 w-1/2" />
                <Skeleton className="h-3 w-4/5" />
              </div>
              <Skeleton className="h-3 w-8 shrink-0" />
            </div>
          ))}
        </div>
      ) : !hasAccounts ? (
        <ListState
          icon={<Inbox aria-hidden className="text-muted-foreground size-6" />}
          text={t("oneMail.accounts.noAccounts")}
        />
      ) : conversations.length === 0 ? (
        <ListState
          icon={<SearchX aria-hidden className="text-muted-foreground size-6" />}
          text={
            emptyBecauseOfQuery
              ? t("oneMail.conversations.noResults")
              : t("oneMail.conversations.empty")
          }
        />
      ) : (
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
          <div className="relative w-full" style={{ height: virtualizer.getTotalSize() }}>
            {virtualItems.map((virtualItem) => {
              const conversation = conversations[virtualItem.index];
              if (!conversation) return null;
              return (
                <div
                  key={virtualItem.key}
                  className="absolute inset-x-0 top-0"
                  style={{ height: ROW_HEIGHT, transform: `translateY(${virtualItem.start}px)` }}
                >
                  <ConversationRow
                    item={conversation}
                    selected={page.selectedConversationKey === conversation.conversationKey}
                    onOpen={page.openConversation}
                  />
                </div>
              );
            })}
          </div>
        </div>
      )}

      {conversations.length > 0 && hasMoreConversations && (
        <div className="border-border flex justify-center border-t px-2 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            disabled={conversationsLoading}
            onClick={loadMoreConversations}
          >
            {conversationsLoading
              ? t("oneMail.conversations.loadingMore")
              : t("oneMail.conversations.loadMore")}
          </Button>
        </div>
      )}
    </div>
  );
}

/** A centered state card: the skeleton's slot for "loading / empty / failed". */
function ListState({ icon, text, action }: { icon: ReactNode; text: string; action?: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-4">
      <div className="flex max-w-64 flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-8 text-center">
        {icon}
        <p className="text-muted-foreground text-xs">{text}</p>
        {action}
      </div>
    </div>
  );
}
