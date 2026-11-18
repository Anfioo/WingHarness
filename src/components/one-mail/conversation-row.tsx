// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Paperclip, Star } from "lucide-react";
import type { ConversationParticipant, ConversationSummary } from "@/commands";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/**
 * The eight avatar tints, spelled out as whole Tailwind classes: the scanner
 * only sees classes that appear literally, so no `bg-${tone}` is possible.
 */
const AVATAR_TONES = [
  "bg-sky-500/15 text-sky-700 dark:text-sky-300",
  "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  "bg-amber-500/15 text-amber-700 dark:text-amber-300",
  "bg-rose-500/15 text-rose-700 dark:text-rose-300",
  "bg-violet-500/15 text-violet-700 dark:text-violet-300",
  "bg-cyan-500/15 text-cyan-700 dark:text-cyan-300",
  "bg-orange-500/15 text-orange-700 dark:text-orange-300",
  "bg-teal-500/15 text-teal-700 dark:text-teal-300",
];

/**
 * A stable tint for any seed — an account colour key or a correspondent's
 * address. The same seed always lands on the same class, so a rail row and its
 * messages keep one colour without the backend having to freeze a palette.
 */
export function avatarTone(seed: string): string {
  let hash = 0;
  for (let index = 0; index < seed.length; index += 1) {
    hash = (hash * 31 + seed.charCodeAt(index)) % 100_000;
  }
  return AVATAR_TONES[hash % AVATAR_TONES.length];
}

/** One or two letters for the avatar: the name when there is one, else the address. */
function initialsFor(name: string | null, email: string): string {
  const source = (name ?? "").trim() || email.split("@")[0] || "?";
  const parts = source.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * The time column: the clock time for today, the month and day for this year,
 * and the full date before that — the same narrowing a mail client uses.
 */
function formatConversationTime(iso: string | null, language: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";

  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return new Intl.DateTimeFormat(language, { hour: "2-digit", minute: "2-digit" }).format(date);
  }
  if (date.getFullYear() === now.getFullYear()) {
    return new Intl.DateTimeFormat(language, { month: "numeric", day: "numeric" }).format(date);
  }
  return new Intl.DateTimeFormat(language, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
  }).format(date);
}

/** The correspondent's avatar, with the participant count when there are several. */
function ParticipantAvatar({ participants }: { participants: ConversationParticipant[] }) {
  const first = participants[0];
  const email = first?.email ?? "";
  const many = participants.length > 1;

  return (
    <span className="relative flex size-9 shrink-0 items-center justify-center">
      <Avatar aria-hidden className="size-9">
        <AvatarFallback className={cn("text-[11px] font-semibold", avatarTone(email || "unknown"))}>
          {initialsFor(first?.name ?? null, email)}
        </AvatarFallback>
      </Avatar>
      {many && (
        <span
          aria-hidden
          className="bg-muted text-muted-foreground ring-background absolute -right-1 -bottom-1 flex size-4 items-center justify-center rounded-full text-[9px] font-medium tabular-nums ring-2"
        >
          {participants.length}
        </span>
      )}
    </span>
  );
}

export interface ConversationRowProps {
  item: ConversationSummary;
  selected: boolean;
  onOpen: (item: ConversationSummary) => void;
}

/**
 * One conversation in the list: the correspondent, the subject, the snippet and
 * the trailing time / unread / star / attachment marks.
 *
 * The row is a real button, so Enter and Space open it without extra handlers,
 * and the whole 76px height is the hit area.
 */
export function ConversationRow({ item, selected, onOpen }: ConversationRowProps) {
  const { t, language } = useAppTranslation();

  const unread = item.unreadCount > 0;
  const time = formatConversationTime(item.lastMessage.receivedAt, language);
  const subject = item.lastMessage.subject ?? t("oneMail.thread.noSubject");

  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "focus-visible:ring-ring/50 flex h-full w-full items-center gap-3 px-3 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none",
        selected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <ParticipantAvatar participants={item.participants} />

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-baseline gap-2">
          <span
            className={cn(
              "shrink-0 truncate text-sm",
              unread ? "text-foreground font-semibold" : "text-foreground/90 font-medium"
            )}
          >
            {item.displayName}
          </span>
          {item.messageCount > 1 && (
            <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
              {item.messageCount}
            </span>
          )}
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              unread ? "text-foreground/80" : "text-muted-foreground"
            )}
          >
            {subject}
          </span>
        </span>
        <span className="text-muted-foreground truncate text-xs">{item.lastMessage.snippet}</span>
      </span>

      <span className="flex shrink-0 flex-col items-end gap-1">
        <span className="text-muted-foreground text-[11px] whitespace-nowrap tabular-nums">
          {time}
        </span>
        <span className="flex items-center gap-1">
          {item.hasAttachments && (
            <>
              <Paperclip aria-hidden className="text-muted-foreground size-3" />
              <span className="sr-only">{t("oneMail.conversations.attachments")}</span>
            </>
          )}
          {item.isStarred && (
            <>
              <Star aria-hidden className="size-3 fill-amber-400 text-amber-400" />
              <span className="sr-only">{t("oneMail.conversations.starred")}</span>
            </>
          )}
          {unread && (
            <>
              <span aria-hidden className="bg-primary size-1.5 rounded-full" />
              <span className="sr-only">{t("oneMail.conversations.unread")}</span>
            </>
          )}
        </span>
      </span>
    </button>
  );
}

export default ConversationRow;
