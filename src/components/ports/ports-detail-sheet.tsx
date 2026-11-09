// The right-hand port detail sheet: lazy load, three sections and the confirm-to-kill action.

import { AlertTriangle } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";

import { portsDetail, portsErrorCode } from "@/commands";
import type { PortDetail, PortsErrorCode, PortStatus } from "@/commands";
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
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { portsErrorKey } from "@/lib/ports/error-key";
import { cn } from "@/lib/utils";

import type { PortDetailSheetProps } from "./props";

/** One label/value line inside a detail card. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

/** A long value printed under its label, so paths and command lines can wrap. */
function LongField({
  label,
  value,
  unknown,
}: {
  label: string;
  value: string | null;
  unknown: string;
}) {
  return (
    <div className="border-border/60 flex flex-col gap-1 border-t pt-1.5">
      <span className="text-muted-foreground text-sm">{label}</span>
      {value ? (
        <span className="font-mono text-xs break-all select-text">{value}</span>
      ) : (
        <span className="text-sm">{unknown}</span>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-foreground text-sm font-medium">{children}</h3>;
}

function DetailSkeleton() {
  return (
    <div className="flex flex-col gap-5">
      {[0, 1, 2].map((section) => (
        <div key={section} className="flex flex-col gap-2">
          <Skeleton className="h-4 w-24" />
          <div className="bg-muted/40 flex flex-col gap-2 rounded-lg p-3">
            <Skeleton className="h-4 w-full" />
            <Skeleton className="h-4 w-4/5" />
            <Skeleton className="h-4 w-2/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

const STATUS_DOT: Record<PortStatus, string> = {
  free: "bg-emerald-500",
  occupied: "bg-sky-500",
  system: "bg-amber-500",
};

/** Formats a byte count as KB, MB or GB with one decimal, localized. */
function formatMemory(bytes: number, language: string): string {
  let value: number;
  let unit: string;
  if (bytes < 1024 * 1024) {
    value = bytes / 1024;
    unit = "KB";
  } else if (bytes < 1024 ** 3) {
    value = bytes / 1024 ** 2;
    unit = "MB";
  } else {
    value = bytes / 1024 ** 3;
    unit = "GB";
  }
  const formatted = new Intl.NumberFormat(language, {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  }).format(value);
  return `${formatted} ${unit}`;
}

/** A relative "started 12 minutes ago" line plus the absolute local time. */
function formatStarted(
  startedAt: number,
  language: string
): { relative: string; absolute: string } {
  const startedMs = startedAt * 1000;
  const elapsedSeconds = Math.round((startedMs - Date.now()) / 1000);
  const magnitude = Math.abs(elapsedSeconds);

  let value = elapsedSeconds;
  let unit: Intl.RelativeTimeFormatUnit = "second";
  if (magnitude >= 86_400) {
    value = Math.round(elapsedSeconds / 86_400);
    unit = "day";
  } else if (magnitude >= 3_600) {
    value = Math.round(elapsedSeconds / 3_600);
    unit = "hour";
  } else if (magnitude >= 60) {
    value = Math.round(elapsedSeconds / 60);
    unit = "minute";
  }

  return {
    relative: new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(value, unit),
    absolute: new Date(startedMs).toLocaleString(language),
  };
}

export function PortDetailSheet({ port, onOpenChange, onKill }: PortDetailSheetProps) {
  const { t, language } = useAppTranslation();

  const [detail, setDetail] = useState<PortDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<PortsErrorCode | "unknown" | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    setConfirmOpen(false);

    if (port === null) {
      setDetail(null);
      setError(null);
      setLoading(false);
      return;
    }

    // A response that lands after the sheet closed or moved to another port is stale.
    let cancelled = false;
    setDetail(null);
    setError(null);
    setLoading(true);

    portsDetail(port)
      .then((result) => {
        if (!cancelled) setDetail(result);
      })
      .catch((failure: unknown) => {
        if (!cancelled) setError(portsErrorCode(failure));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [port]);

  const killTarget = detail && detail.status !== "system" ? detail.process : null;
  const unknown = t("ports.detail.unknown");

  const confirmKill = () => {
    if (!killTarget) return;
    const pid = killTarget.pid;
    setConfirmOpen(false);
    onKill(pid);
    onOpenChange(false);
  };

  const started =
    detail?.process?.startedAt != null ? formatStarted(detail.process.startedAt, language) : null;

  return (
    <Sheet open={port !== null} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader>
          <SheetTitle>{t("ports.detail.title", { port: port ?? "" })}</SheetTitle>
          <SheetDescription className="font-mono">
            {detail ? `${detail.address ?? "—"}:${detail.port}` : "—"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto px-4 pb-4">
          {loading ? (
            <DetailSkeleton />
          ) : error !== null ? (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
            >
              {t("ports.detail.loadFailed")} {t(portsErrorKey(error))}
            </div>
          ) : detail === null ? (
            <div className="flex flex-col items-center gap-1 px-4 py-12 text-center">
              <p className="text-sm font-medium">{t("ports.detail.empty.title")}</p>
              <p className="text-muted-foreground text-xs">{t("ports.detail.empty.body")}</p>
            </div>
          ) : (
            <>
              <section className="flex flex-col gap-2">
                <SectionTitle>{t("ports.detail.section.port")}</SectionTitle>
                <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
                  <InfoRow label={t("ports.detail.field.status")}>
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("size-2 rounded-full", STATUS_DOT[detail.status])} />
                      {t(`ports.status.${detail.status}`)}
                    </span>
                  </InfoRow>
                  <InfoRow label={t("ports.detail.field.protocol")}>
                    <span className="font-mono">{detail.protocol.toUpperCase()}</span>
                  </InfoRow>
                  <InfoRow label={t("ports.detail.field.address")}>
                    <span className="font-mono">{detail.address ?? "—"}</span>
                  </InfoRow>
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle>{t("ports.detail.section.process")}</SectionTitle>
                <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
                  <InfoRow label={t("ports.detail.field.name")}>
                    {detail.process?.name ?? unknown}
                  </InfoRow>
                  <InfoRow label={t("ports.detail.field.pid")}>
                    <span className="font-mono tabular-nums">
                      {detail.process ? detail.process.pid.toLocaleString(language) : unknown}
                    </span>
                  </InfoRow>
                  <LongField
                    label={t("ports.detail.field.path")}
                    value={detail.process?.path ?? null}
                    unknown={unknown}
                  />
                  <LongField
                    label={t("ports.detail.field.command")}
                    value={detail.process?.command ?? null}
                    unknown={unknown}
                  />
                  <LongField
                    label={t("ports.detail.field.workingDir")}
                    value={detail.process?.workingDir ?? null}
                    unknown={unknown}
                  />
                </div>
              </section>

              <section className="flex flex-col gap-2">
                <SectionTitle>{t("ports.detail.section.resources")}</SectionTitle>
                <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
                  <InfoRow label={t("ports.detail.field.memory")}>
                    {detail.process?.memoryBytes != null
                      ? formatMemory(detail.process.memoryBytes, language)
                      : unknown}
                  </InfoRow>
                  <InfoRow label={t("ports.detail.field.started")}>
                    {started ? (
                      <span className="flex flex-col items-end gap-0.5">
                        <span>{started.relative}</span>
                        <span className="text-muted-foreground text-xs">{started.absolute}</span>
                      </span>
                    ) : (
                      unknown
                    )}
                  </InfoRow>
                  <InfoRow label={t("ports.detail.field.user")}>
                    {detail.process?.user ?? unknown}
                  </InfoRow>
                </div>
              </section>
            </>
          )}
        </div>

        <SheetFooter className="flex-row items-center justify-end gap-2 border-t">
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("ports.actions.close")}
          </Button>
          {killTarget && (
            <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
              <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
                <AlertTriangle />
                {t("ports.actions.kill")}
              </Button>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t("ports.kill.title")}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t("ports.kill.description", {
                      name: killTarget.name,
                      pid: killTarget.pid,
                      port: port ?? "",
                    })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>{t("ports.actions.cancel")}</AlertDialogCancel>
                  <AlertDialogAction
                    className={buttonVariants({ variant: "destructive" })}
                    onClick={confirmKill}
                  >
                    {t("ports.kill.confirm")}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
