// Part of the one-mail module, adapted from OneMail
// (https://github.com/zhihui-hu/one-mail), AGPL-3.0-only.
// See `src-tauri/one-mail-core/UPSTREAM.md` for the porting record.

import { Loader2, Mail, Paperclip, Pencil, RefreshCw, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { OutboxItem, OutboxStatus } from "@/commands";
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
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useOneMailPageContext } from "@/pages/one-mail/context";

type GroupKey = "draft" | "failed" | "sent";

const GROUPS: { key: GroupKey; statuses: OutboxStatus[] }[] = [
  // A queued or in-flight row belongs beside its draft: it is still editable
  // content, even though the actions stay disabled until it settles.
  { key: "draft", statuses: ["draft", "queued", "sending", "cancelled"] },
  { key: "failed", statuses: ["failed"] },
  { key: "sent", statuses: ["sent"] },
];

const GROUP_LABEL: Record<GroupKey, string> = {
  draft: "oneMail.outbox.draft",
  failed: "oneMail.outbox.failed",
  sent: "oneMail.outbox.sent",
};

const UNSETTLED: OutboxStatus[] = ["queued", "sending"];

function formatRecipients(item: OutboxItem): string {
  const addresses = item.to.length > 0 ? item.to : item.cc;
  return addresses
    .map((address) => address.name || address.email)
    .filter((label) => label !== "")
    .join(", ");
}

function formatTime(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat(language, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(date);
}

function badgeGroup(status: OutboxStatus): GroupKey {
  if (status === "failed") return "failed";
  if (status === "sent") return "sent";
  return "draft";
}

/**
 * The outbox drawer: drafts to continue, failed sends to retry, and the sent
 * log. It is also the only place a Bcc-only message can appear, because the
 * conversation list never groups one.
 */
export default function OutboxPanel() {
  const page = useOneMailPageContext();
  const { outbox, outboxOpen, loading, setOutboxOpen, reloadOutbox, retryOutbox, deleteOutbox } =
    page;
  const { t, language } = useAppTranslation();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OutboxItem | null>(null);

  // The hook already listens for `one-mail:outbox-changed`; opening the drawer
  // just asks for a fresh list so it never shows a stale one.
  useEffect(() => {
    if (outboxOpen) void reloadOutbox();
  }, [outboxOpen, reloadOutbox]);

  const groups = useMemo(
    () =>
      GROUPS.map((group) => ({
        ...group,
        items: outbox.filter((item) => group.statuses.includes(item.status)),
      })).filter((group) => group.items.length > 0),
    [outbox]
  );

  const retry = async (item: OutboxItem) => {
    setBusyId(item.outboxId);
    try {
      await retryOutbox(item.outboxId);
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: OutboxItem) => {
    setBusyId(item.outboxId);
    setDeleteTarget(null);
    try {
      await deleteOutbox(item.outboxId);
    } finally {
      setBusyId(null);
    }
  };

  return (
    <>
      <Sheet open={outboxOpen} onOpenChange={setOutboxOpen}>
        <SheetContent side="right" className="flex w-full flex-col gap-0 p-0 sm:max-w-md">
          <SheetHeader className="border-b px-4 py-3 pr-12">
            <div className="flex items-center justify-between gap-3">
              <SheetTitle className="text-base">{t("oneMail.outbox.title")}</SheetTitle>
              <Button
                type="button"
                size="icon-sm"
                variant="outline"
                aria-label={t("oneMail.filters.refresh")}
                title={t("oneMail.filters.refresh")}
                onClick={() => void reloadOutbox()}
              >
                <RefreshCw />
              </Button>
            </div>
            <SheetDescription className="sr-only">{t("oneMail.outbox.title")}</SheetDescription>
          </SheetHeader>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {loading && outbox.length === 0 ? (
              <p className="text-muted-foreground flex items-center gap-2 px-4 py-6 text-sm">
                <Loader2 className="size-4 animate-spin" />
                {t("oneMail.common.loading")}
              </p>
            ) : groups.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
                <span className="bg-muted flex size-10 items-center justify-center rounded-xl">
                  <Mail className="text-muted-foreground size-4" />
                </span>
                <p className="text-muted-foreground text-xs">{t("oneMail.outbox.empty")}</p>
              </div>
            ) : (
              groups.map((group) => (
                <section key={group.key} className="border-b last:border-b-0">
                  <h3 className="text-muted-foreground bg-muted/30 px-4 py-1.5 text-[11px] font-medium tracking-wide uppercase">
                    {t(GROUP_LABEL[group.key])}
                    <span className="ml-1.5 tabular-nums">{group.items.length}</span>
                  </h3>
                  <ul className="divide-y">
                    {group.items.map((item) => {
                      const unsettled = UNSETTLED.includes(item.status);
                      const working = busyId === item.outboxId;
                      const editable = item.status === "draft";
                      const failed = item.status === "failed";
                      const onlyBcc =
                        item.to.length === 0 && item.cc.length === 0 && item.bcc.length > 0;
                      return (
                        <li key={item.outboxId} className="space-y-1.5 px-4 py-2.5">
                          <div className="flex items-start gap-2">
                            <div className="min-w-0 flex-1">
                              <p className="truncate text-sm font-medium">
                                {item.subject || t("oneMail.thread.noSubject")}
                              </p>
                              <p className="text-muted-foreground truncate text-xs">
                                {formatRecipients(item) || "—"}
                              </p>
                            </div>
                            <Badge
                              variant={failed ? "destructive" : "outline"}
                              className={cn(
                                "shrink-0 text-[10px]",
                                item.status === "sent" && "text-muted-foreground"
                              )}
                            >
                              {t(GROUP_LABEL[badgeGroup(item.status)])}
                            </Badge>
                          </div>

                          <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-[11px]">
                            <span className="tabular-nums">
                              {formatTime(item.sentAt ?? item.createdAt, language)}
                            </span>
                            {item.attachmentCount > 0 && (
                              <span className="flex items-center gap-0.5">
                                <Paperclip className="size-3" />
                                {item.attachmentCount}
                              </span>
                            )}
                          </div>

                          {onlyBcc && (
                            <p className="text-muted-foreground text-[11px]">
                              {t("oneMail.outbox.onlyBcc")}
                            </p>
                          )}
                          {item.lastError && (
                            <p
                              className="text-destructive line-clamp-2 text-[11px]"
                              title={item.lastError}
                            >
                              {item.lastError}
                            </p>
                          )}

                          <div className="flex flex-wrap items-center gap-1.5">
                            {editable && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={unsettled || working}
                                onClick={() => void page.composer.openDraft(item)}
                              >
                                <Pencil />
                                {t("oneMail.outbox.edit")}
                              </Button>
                            )}
                            {failed && (
                              <Button
                                type="button"
                                size="sm"
                                variant="outline"
                                className="h-7 px-2 text-xs"
                                disabled={unsettled || working}
                                onClick={() => void retry(item)}
                              >
                                {working ? <Loader2 className="animate-spin" /> : <RotateCcw />}
                                {working ? t("oneMail.outbox.retrying") : t("oneMail.outbox.retry")}
                              </Button>
                            )}
                            <Button
                              type="button"
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive h-7 px-2 text-xs"
                              disabled={unsettled || working}
                              onClick={() => setDeleteTarget(item)}
                            >
                              <Trash2 />
                              {t("oneMail.outbox.delete")}
                            </Button>
                          </div>
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
            )}
          </div>
        </SheetContent>
      </Sheet>

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) setDeleteTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("oneMail.outbox.delete")}</AlertDialogTitle>
            <AlertDialogDescription>
              {deleteTarget?.status === "draft"
                ? t("oneMail.compose.discardConfirm")
                : t("oneMail.outbox.deleteConfirm")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("oneMail.common.cancel")}</AlertDialogCancel>
            <AlertDialogAction asChild>
              <Button
                type="button"
                variant="destructive"
                onClick={(event) => {
                  event.preventDefault();
                  if (deleteTarget) void remove(deleteTarget);
                }}
              >
                {t("oneMail.common.delete")}
              </Button>
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
