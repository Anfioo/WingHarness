// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { useEffect, useRef, useState } from "react";
import { ChevronRight, Edit3, Inbox, Mail, Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { oneMailAccountRemove, type AccountStatus, type AccountSummary } from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { getProviderLabelKey, normalizeProviderKey } from "@/lib/one-mail/provider-metadata";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";
import ProviderIcon from "./provider-icon";

const STATUS_DOT: Record<AccountStatus, string> = {
  active: "bg-emerald-500",
  syncing: "animate-pulse bg-sky-500",
  auth_error: "bg-destructive",
  sync_error: "bg-amber-500",
  network_error: "bg-amber-500",
  disabled: "bg-muted-foreground/40",
};

interface AccountGroup {
  key: string;
  label: string;
  accounts: AccountSummary[];
}

/**
 * The account rail, grouped by provider exactly as the source workspace does.
 *
 * "All accounts" is its own section; every provider is a collapsible group,
 * and a row carries the provider mark, its unread count, a hover refresh action
 * and the connection dot. A right-click offers refresh, edit and delete.
 */
export default function AccountRail() {
  const page = useOneMailPageContext();
  const { t } = useAppTranslation();
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const [removing, setRemoving] = useState<AccountSummary | null>(null);

  const totalUnread = page.accounts.reduce((sum, account) => sum + account.unreadCount, 0);
  const hasAccounts = page.accounts.length > 0;
  const groups = groupAccounts(page.accounts, (key) => t(getProviderLabelKey(key)));

  // Opening a conversation from a collapsed group's account should reveal it.
  useEffect(() => {
    if (page.selectedAccountId === null) return;
    const selected = page.accounts.find((account) => account.accountId === page.selectedAccountId);
    if (!selected) return;
    const key = normalizeProviderKey(selected.providerKey);
    setCollapsedGroups((current) => {
      if (!current.has(key)) return current;
      const next = new Set(current);
      next.delete(key);
      return next;
    });
  }, [page.accounts, page.selectedAccountId]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const removeAccount = async (account: AccountSummary) => {
    try {
      await oneMailAccountRemove(account.accountId);
      if (page.selectedAccountId === account.accountId) page.selectAccount(null);
      await page.reloadAccounts();
      toast.success(t("oneMail.accounts.removed", { email: account.email }));
    } catch (failure) {
      toast.error(t("oneMail.accounts.removeFailed"));
      console.warn("Could not remove the mail account:", failure);
    } finally {
      setRemoving(null);
    }
  };

  return (
    <aside className="one-mail-sidebar native-sidebar flex h-full min-h-0 min-w-0 flex-col text-xs">
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 py-1.5">
        <TooltipProvider delayDuration={200}>
          <div className="flex flex-col gap-0.5">
            {hasAccounts && (
              <section className="mb-1">
                <div className="text-muted-foreground/80 px-2 pt-1 pb-1 text-[11px] font-semibold">
                  {t("oneMail.accounts.allEmail")}
                </div>
                <AllAccountsRow
                  unread={totalUnread}
                  selected={page.selectedAccountId === null}
                  onSelect={() => page.selectAccount(null)}
                />
              </section>
            )}

            {groups.length > 0 ? (
              groups.map((group) => {
                const collapsed = collapsedGroups.has(group.key);
                return (
                  <section key={group.key}>
                    <button
                      type="button"
                      className="text-muted-foreground/80 focus-visible:ring-ring flex h-7 w-full items-center gap-1 rounded-md px-1.5 text-left text-[11px] font-semibold focus-visible:ring-2 focus-visible:outline-none"
                      onClick={() => toggleGroup(group.key)}
                    >
                      <ChevronRight
                        className={cn("size-3.5 transition-transform", !collapsed && "rotate-90")}
                        aria-hidden
                      />
                      <span className="min-w-0 flex-1 truncate">{group.label}</span>
                    </button>
                    {!collapsed && (
                      <div className="flex flex-col gap-0.5">
                        {group.accounts.map((account) => (
                          <AccountRow
                            key={account.accountId}
                            account={account}
                            selected={page.selectedAccountId === account.accountId}
                            syncing={
                              account.status === "syncing" ||
                              (page.syncing && page.syncProgress?.accountId === account.accountId)
                            }
                            onSelect={() => page.selectAccount(account.accountId)}
                            onRefresh={() => void page.syncNow(account.accountId)}
                            onEdit={() => page.accountDialog.openEdit(account)}
                            onRemove={() => setRemoving(account)}
                          />
                        ))}
                      </div>
                    )}
                  </section>
                );
              })
            ) : (
              <EmptyRail onAdd={page.accountDialog.openAdd} />
            )}
          </div>
        </TooltipProvider>
      </div>

      {hasAccounts && (
        <div className="border-border border-t p-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={page.accountDialog.openAdd}
            aria-label={t("oneMail.accounts.add")}
            className="w-full justify-start"
          >
            <Plus />
            {t("oneMail.accounts.add")}
          </Button>
        </div>
      )}

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => {
          if (!open) setRemoving(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("oneMail.accounts.removeTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("oneMail.accounts.removeConfirm", { email: removing?.email ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("oneMail.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={() => {
                if (removing) void removeAccount(removing);
              }}
            >
              {t("oneMail.common.delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </aside>
  );
}

function AllAccountsRow({
  unread,
  selected,
  onSelect,
}: {
  unread: number;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left transition-colors",
        selected
          ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)]"
          : "hover:bg-accent/60"
      )}
    >
      <span className="bg-background ring-border/60 flex size-5 items-center justify-center rounded-md ring-1">
        <Inbox className="text-muted-foreground size-3.5" aria-hidden />
      </span>
      <span className="min-w-0 flex-1 truncate font-medium">{t("oneMail.accounts.all")}</span>
      {unread > 0 && <UnreadBadge count={unread} />}
    </button>
  );
}

function AccountRow({
  account,
  selected,
  syncing,
  onSelect,
  onRefresh,
  onEdit,
  onRemove,
}: {
  account: AccountSummary;
  selected: boolean;
  syncing: boolean;
  onSelect: () => void;
  onRefresh: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useAppTranslation();
  const [spinRequested, setSpinRequested] = useState(false);
  const spinTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (spinTimer.current) clearTimeout(spinTimer.current);
    },
    []
  );

  const refresh = () => {
    setSpinRequested(true);
    if (spinTimer.current) clearTimeout(spinTimer.current);
    spinTimer.current = setTimeout(() => {
      setSpinRequested(false);
      spinTimer.current = null;
    }, 1100);
    onRefresh();
  };

  const warning =
    account.status === "auth_error"
      ? t("oneMail.accounts.authError")
      : account.status === "sync_error" || account.status === "network_error"
        ? t("oneMail.accounts.syncError")
        : null;
  const spinning = syncing || spinRequested;

  const row = (
    <div
      className={cn(
        "group grid h-8 w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-0.5 rounded-md px-2 transition-colors",
        selected
          ? "bg-primary/15 text-foreground shadow-[inset_0_0_0_1px_rgb(0_0_0/0.025)]"
          : "hover:bg-accent/60",
        warning && "text-amber-700 dark:text-amber-300"
      )}
    >
      <button
        type="button"
        onClick={onSelect}
        aria-pressed={selected}
        title={account.email}
        className="grid min-w-0 grid-cols-[24px_minmax(0,1fr)] items-center gap-1 text-left outline-none"
      >
        <ProviderIcon providerKey={account.providerKey} address={account.email} />
        <span className="min-w-0 truncate">
          <span className="block truncate font-medium">{account.accountLabel}</span>
        </span>
      </button>
      <span className="flex min-w-5 items-center justify-end gap-1">
        {!warning && account.unreadCount > 0 && !spinning && (
          <UnreadBadge count={account.unreadCount} />
        )}
        <button
          type="button"
          aria-label={t("oneMail.accounts.syncNow")}
          title={t("oneMail.accounts.syncNow")}
          className={cn(
            "text-muted-foreground hover:text-foreground focus-visible:ring-ring hidden size-5 items-center justify-center rounded-md outline-none group-hover:inline-flex focus-visible:inline-flex focus-visible:ring-2",
            spinning && "inline-flex"
          )}
          onClick={(event) => {
            event.stopPropagation();
            refresh();
          }}
        >
          <RefreshCw
            aria-hidden
            className={cn(
              "size-3",
              spinning && "animate-spin [animation-duration:800ms] motion-reduce:animate-none"
            )}
          />
        </button>
        <span
          aria-hidden
          title={warning ?? undefined}
          className={cn("size-1.5 shrink-0 rounded-full", STATUS_DOT[account.status])}
        />
      </span>
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent className="w-40">
        <ContextMenuGroup>
          <ContextMenuItem onSelect={refresh}>
            <RefreshCw className="size-4" />
            {warning ? t("oneMail.accounts.resync") : t("oneMail.accounts.syncNow")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={onEdit}>
            <Edit3 className="size-4" />
            {t("oneMail.accounts.edit")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem variant="destructive" onSelect={onRemove}>
            <Trash2 className="size-4" />
            {t("oneMail.accounts.remove")}
          </ContextMenuItem>
        </ContextMenuGroup>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function UnreadBadge({ count }: { count: number }) {
  return (
    <Badge
      variant="secondary"
      className="bg-foreground/10 text-foreground/75 h-[18px] min-w-[18px] rounded-full border-0 px-1.5 text-[10px] tabular-nums shadow-none"
    >
      {count > 99 ? "99+" : count}
    </Badge>
  );
}

function EmptyRail({ onAdd }: { onAdd: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="text-muted-foreground flex min-h-40 flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-4 text-center">
      <Mail aria-hidden className="size-5" />
      <div className="text-foreground text-xs font-medium">{t("oneMail.accounts.emptyTitle")}</div>
      <div className="max-w-44 text-[11px]">{t("oneMail.accounts.noAccounts")}</div>
      <Button variant="outline" size="sm" onClick={onAdd}>
        <Plus />
        {t("oneMail.accounts.add")}
      </Button>
    </div>
  );
}

function groupAccounts(
  accounts: AccountSummary[],
  labelFor: (key: string) => string
): AccountGroup[] {
  const grouped = new Map<string, AccountSummary[]>();
  const latestInGroup = (group: AccountSummary[]) =>
    group.reduce(
      (latest, account) =>
        Math.max(latest, account.latestMessageAt ? Date.parse(account.latestMessageAt) : 0),
      0
    );

  for (const account of accounts) {
    const key = normalizeProviderKey(account.providerKey);
    grouped.set(key, [...(grouped.get(key) ?? []), account]);
  }

  return Array.from(grouped.entries())
    .sort(
      ([firstKey, first], [secondKey, second]) =>
        latestInGroup(second) - latestInGroup(first) || firstKey.localeCompare(secondKey)
    )
    .map(([key, group]) => ({
      key,
      label: labelFor(key),
      accounts: group.sort((first, second) => {
        const firstAt = first.latestMessageAt ? Date.parse(first.latestMessageAt) : 0;
        const secondAt = second.latestMessageAt ? Date.parse(second.latestMessageAt) : 0;
        return secondAt - firstAt || first.email.localeCompare(second.email);
      }),
    }));
}
