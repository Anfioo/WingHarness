// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef, useState } from "react";
import { Mail, Pencil, Plus, RefreshCw } from "lucide-react";
import type { AccountStatus } from "@/commands";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";
import { avatarTone } from "./conversation-row";

/** Below this rail width only the avatar, the unread dot and the row menu stay. */
const COMPACT_WIDTH = 220;

const STATUS_DOT: Record<AccountStatus, string> = {
  active: "bg-emerald-500",
  syncing: "animate-pulse bg-sky-500",
  auth_error: "bg-destructive",
  sync_error: "bg-amber-500",
  network_error: "bg-amber-500",
  disabled: "bg-muted-foreground/40",
};

const ICON_BUTTON =
  "flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground focus-visible:ring-ring/50 focus-visible:ring-2 focus-visible:outline-none";

interface AccountRowProps {
  label: string;
  /** The account's initials, or empty for the "all accounts" row. */
  avatarText: string;
  tone: string;
  unreadCount: number;
  /** `null` hides the status dot: the "all accounts" row has no status of its own. */
  status: AccountStatus | null;
  errorText: string | null;
  selected: boolean;
  compact: boolean;
  title?: string;
  onSelect: () => void;
  onEdit?: () => void;
  onSync?: () => void;
}

/**
 * One rail row: the avatar, the label with its error line, the unread badge and
 * the status dot. A real account also gets an edit button on hover and a
 * right-click menu, which is the only place "sync this account" lives.
 */
function AccountRow({
  label,
  avatarText,
  tone,
  unreadCount,
  status,
  errorText,
  selected,
  compact,
  title,
  onSelect,
  onEdit,
  onSync,
}: AccountRowProps) {
  const { t } = useAppTranslation();

  const unreadLabel = t("oneMail.accounts.unreadCount", { count: unreadCount });
  const accessibleName = unreadCount > 0 ? `${label} · ${unreadLabel}` : label;

  const row = (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md",
        compact ? "justify-center px-1 py-1.5" : "px-1.5 py-1.5",
        selected ? "bg-accent" : "hover:bg-accent/50"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        aria-label={accessibleName}
        title={title}
        className={cn(
          "focus-visible:ring-ring/50 flex min-w-0 items-center gap-2 rounded-md focus-visible:ring-2 focus-visible:outline-none",
          compact ? "justify-center" : "flex-1 text-left"
        )}
      >
        <span className="relative flex size-7 shrink-0 items-center justify-center">
          <Avatar aria-hidden className="size-7">
            <AvatarFallback className={cn("text-[10px] font-semibold", tone)}>
              {avatarText || <Mail className="size-3.5" />}
            </AvatarFallback>
          </Avatar>
          {compact && unreadCount > 0 && (
            <span
              aria-hidden
              className="bg-primary ring-background absolute -right-0.5 -bottom-0.5 size-2 rounded-full ring-2"
            />
          )}
        </span>

        {!compact && (
          <span className="min-w-0 flex-1">
            <span
              className={cn(
                "block truncate text-xs",
                selected ? "text-foreground font-semibold" : "text-foreground/90 font-medium"
              )}
            >
              {label}
            </span>
            {errorText && (
              <span className="text-destructive block truncate text-[10px]">{errorText}</span>
            )}
          </span>
        )}
      </button>

      {!compact && unreadCount > 0 && (
        <Badge
          variant="secondary"
          aria-label={unreadLabel}
          className="h-[18px] shrink-0 rounded-full px-1.5 text-[10px] tabular-nums"
        >
          {unreadCount}
        </Badge>
      )}

      {status !== null && (
        <span
          aria-hidden
          title={errorText ?? undefined}
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[status])}
        />
      )}

      {!compact && onEdit && (
        <button
          type="button"
          onClick={onEdit}
          aria-label={t("oneMail.accounts.edit")}
          className={ICON_BUTTON}
        >
          <Pencil aria-hidden className="size-3" />
        </button>
      )}
    </div>
  );

  if (!onEdit && !onSync) return row;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        {onSync && (
          <ContextMenuItem onSelect={onSync}>
            <RefreshCw />
            {t("oneMail.accounts.syncNow")}
          </ContextMenuItem>
        )}
        {onEdit && (
          <ContextMenuItem onSelect={onEdit}>
            <Pencil />
            {t("oneMail.accounts.edit")}
          </ContextMenuItem>
        )}
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The no-account rail: one hint and the same "add account" action as the footer. */
function EmptyRail({ compact, onAdd }: { compact: boolean; onAdd: () => void }) {
  const { t } = useAppTranslation();

  return (
    <div className="flex flex-col items-center gap-2 rounded-lg border border-dashed p-3 text-center">
      <Mail aria-hidden className="text-muted-foreground size-5 shrink-0" />
      {!compact && (
        <p className="text-muted-foreground text-[11px]">{t("oneMail.accounts.noAccounts")}</p>
      )}
      <Button variant="outline" size="sm" onClick={onAdd} aria-label={t("oneMail.accounts.add")}>
        <Plus />
        {!compact && t("oneMail.accounts.add")}
      </Button>
    </div>
  );
}

/**
 * The account rail: "all accounts" with the summed unread count, then one row
 * per account, and the add button at the foot.
 *
 * The rail narrows with its panel, not the window, so it watches its own width
 * and collapses to an avatar strip under 220px.
 */
export default function AccountRail() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const railRef = useRef<HTMLElement>(null);
  const [compact, setCompact] = useState(false);

  useEffect(() => {
    const element = railRef.current;
    if (!element) return;

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? element.getBoundingClientRect().width;
      setCompact(width < COMPACT_WIDTH);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const totalUnread = page.accounts.reduce((sum, account) => sum + account.unreadCount, 0);
  const hasAccounts = page.accounts.length > 0;

  return (
    <aside ref={railRef} className="border-border flex h-full min-h-0 flex-col border-r">
      <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto p-1.5">
        {hasAccounts ? (
          <>
            <AccountRow
              label={t("oneMail.accounts.all")}
              avatarText=""
              tone="bg-muted text-muted-foreground"
              unreadCount={totalUnread}
              status={null}
              errorText={null}
              selected={page.selectedAccountId === null}
              compact={compact}
              onSelect={() => page.selectAccount(null)}
            />
            <div aria-hidden className="bg-border mx-1 my-1 h-px" />
            {page.accounts.map((account) => (
              <AccountRow
                key={account.accountId}
                label={account.accountLabel}
                title={account.email}
                avatarText={account.avatarText}
                tone={avatarTone(account.colorKey || account.email)}
                unreadCount={account.unreadCount}
                status={account.status}
                errorText={
                  account.status === "auth_error"
                    ? t("oneMail.accounts.authError")
                    : account.status === "sync_error"
                      ? t("oneMail.accounts.syncError")
                      : null
                }
                selected={page.selectedAccountId === account.accountId}
                compact={compact}
                onSelect={() => page.selectAccount(account.accountId)}
                onEdit={() => page.accountDialog.openEdit(account)}
                onSync={() => void page.syncNow(account.accountId)}
              />
            ))}
          </>
        ) : (
          <EmptyRail compact={compact} onAdd={page.accountDialog.openAdd} />
        )}
      </div>

      {hasAccounts && (
        <div className="border-border border-t p-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={page.accountDialog.openAdd}
            aria-label={t("oneMail.accounts.add")}
            className={cn("w-full", compact ? "justify-center px-0" : "justify-start")}
          >
            <Plus />
            {!compact && t("oneMail.accounts.add")}
          </Button>
        </div>
      )}
    </aside>
  );
}
