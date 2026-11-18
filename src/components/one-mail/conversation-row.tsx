// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Copy } from "lucide-react";
import { toast } from "sonner";
import type { ConversationSummary } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import ConversationAvatar from "./conversation-avatar";

/** A short relative time such as "3 hours ago", without a date-fns dependency. */
function formatRelativeTime(iso: string | null, language: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const seconds = Math.round((date.getTime() - Date.now()) / 1000);
  const formatter = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  const units: Array<[Intl.RelativeTimeFormatUnit, number]> = [
    ["year", 31_536_000],
    ["month", 2_592_000],
    ["week", 604_800],
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  for (const [unit, size] of units) {
    if (Math.abs(seconds) >= size) {
      return formatter.format(Math.round(seconds / size), unit);
    }
  }
  return formatter.format(seconds, "second");
}

export interface ConversationRowProps {
  item: ConversationSummary;
  selected: boolean;
  onOpen: (item: ConversationSummary) => void;
}

/**
 * One person in the list: the avatar with its unread badge, the name and time,
 * and the last message's snippet. The row is a button, so the whole height is
 * the hit area and Enter/Space work without extra handlers.
 */
export function ConversationRow({ item, selected, onOpen }: ConversationRowProps) {
  const { t, language } = useAppTranslation();
  const unread = item.unreadCount > 0;
  const snippet =
    item.lastMessage.snippet || item.lastMessage.subject || t("oneMail.thread.noSubject");
  const time = formatRelativeTime(item.lastMessage.receivedAt, language);
  const participantEmails = item.participants.map((participant) => participant.email).join(", ");

  return (
    <div
      className={cn(
        "conversation-row group relative flex h-full w-full items-center gap-2.5 px-3.5 py-2",
        selected && "is-selected"
      )}
    >
      <button
        type="button"
        className="focus-visible:ring-ring absolute inset-0 outline-none focus-visible:ring-2 focus-visible:ring-inset"
        aria-current={selected ? "true" : undefined}
        aria-label={participantEmails}
        onClick={() => onOpen(item)}
      />
      <span className="pointer-events-none relative shrink-0">
        <ConversationAvatar
          seed={item.participants[0]?.email || item.conversationKey}
          members={item.participants.length > 1 ? item.participants : undefined}
          compact
        />
        {unread && (
          <span
            className="conversation-unread absolute -top-1.5 -right-1.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] tabular-nums"
            aria-label={t("oneMail.conversations.unreadCount", { count: item.unreadCount })}
          >
            {item.unreadCount > 99 ? "99+" : item.unreadCount}
          </span>
        )}
      </span>

      <span className="pointer-events-none relative min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              "min-w-0 truncate text-sm",
              unread ? "text-foreground font-semibold" : "font-medium"
            )}
            title={item.displayName}
          >
            {item.displayName}
          </span>
          <time
            dateTime={item.lastMessage.receivedAt ?? undefined}
            className="text-muted-foreground ml-auto shrink-0 text-[11px] whitespace-nowrap"
          >
            {time}
          </time>
          <button
            type="button"
            className="text-muted-foreground hover:text-foreground focus-visible:ring-ring pointer-events-auto hidden size-5 shrink-0 items-center justify-center rounded group-focus-within:flex group-hover:flex focus-visible:ring-2 focus-visible:outline-none"
            aria-label={t("oneMail.list.copyAddress")}
            title={t("oneMail.list.copyAddress")}
            onClick={(event) => {
              event.stopPropagation();
              void navigator.clipboard
                .writeText(participantEmails)
                .then(() => toast.success(t("oneMail.common.copied")))
                .catch(() => toast.error(t("oneMail.common.copyFailed")));
            }}
          >
            <Copy className="size-3" aria-hidden />
          </button>
        </span>
        <span
          className="text-muted-foreground mt-0.5 block truncate text-xs leading-4"
          title={snippet}
        >
          {snippet}
        </span>
      </span>
    </div>
  );
}

export default ConversationRow;
