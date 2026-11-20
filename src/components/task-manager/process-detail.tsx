// Ported from Argus (https://github.com/Ray-lea/Argus), AGPL-3.0-or-later.
// See docs/UPSTREAM_PROJECTS.md for the porting record.

// The selected process's details, as the sections and the action row of the
// right-hand panel: fields from the snapshot at once, and the slower command
// line, user and version fetched per process instance.

import { useEffect, useState, type ReactNode } from "react";
import { Clipboard, ListX, ShieldAlert, Skull } from "lucide-react";
import { toast } from "sonner";
import {
  argusErrorKey,
  argusProcessDetails,
  isArgusError,
  type Architecture,
  type ArgusError,
  type Integrity,
  type ProcessDetails,
  type ProcessRow,
} from "@/commands";
import {
  formatBytes,
  formatDuration,
  formatPercent,
  formatRate,
} from "@/components/task-manager/format";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  isOwnProcess,
  isSystemProcess,
  priorityOf,
  procKey,
} from "@/lib/task-manager/process-identity";
import type { ProcessActions } from "./process-context-menu";

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

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

/**
 * The slow fields of one process instance. The identity, not the row object,
 * is the effect's dependency: a snapshot replaces every row each tick, but only
 * another process asks for new details. A response that arrives after the
 * panel moved on is discarded.
 */
function useProcessDetails(process: ProcessRow) {
  const [details, setDetails] = useState<ProcessDetails | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<ArgusError | null>(null);

  const identity = procKey(process);
  const pid = process.pid;

  useEffect(() => {
    setDetails(null);
    setError(null);
    setLoading(true);

    let cancelled = false;
    argusProcessDetails(pid)
      .then((result) => {
        if (!cancelled) setDetails(result);
      })
      .catch((failure: unknown) => {
        if (cancelled) return;
        setError(
          isArgusError(failure)
            ? failure
            : {
                code: "internal",
                message: failure instanceof Error ? failure.message : String(failure),
              }
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [identity, pid]);

  return { details, loading, error };
}

export function ProcessDetailsBody({
  process,
  processNetwork,
}: {
  process: ProcessRow;
  processNetwork: boolean;
}) {
  const { t, language } = useAppTranslation();
  const { details, loading, error } = useProcessDetails(process);

  const unknown = t("taskManager.details.unknown");
  const integrity = (value: Integrity | null | undefined) =>
    value ? t(`taskManager.details.integrity.${value}`) : unknown;
  const architecture = (value: Architecture | null | undefined) =>
    value ? t(`taskManager.details.arch.${value}`) : unknown;
  const priority = details?.priorityClass ?? priorityOf(process.basePriority);

  if (loading) {
    return (
      <div className="mt-4 pb-1">
        <DetailSkeleton />
      </div>
    );
  }

  return (
    <div className="mt-4 flex flex-col gap-5">
      {error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t(argusErrorKey(error.code))}
        </div>
      )}
      {details && !details.accessible && (
        <div className="border-border bg-muted/40 flex items-start gap-2 rounded-lg border px-3 py-2 text-sm">
          <ShieldAlert className="text-muted-foreground mt-0.5 size-4 shrink-0" />
          <span>{t("taskManager.details.noAccess")}</span>
        </div>
      )}

      <section className="flex flex-col gap-2">
        <SectionTitle>{t("taskManager.details.section.process")}</SectionTitle>
        <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
          <InfoRow label={t("taskManager.details.pid")}>
            <span className="font-mono tabular-nums">{process.pid}</span>
          </InfoRow>
          <InfoRow label={t("taskManager.details.parent")}>
            <span className="font-mono tabular-nums">{process.ppid}</span>
          </InfoRow>
          <InfoRow label={t("taskManager.details.started")}>
            {new Date(process.createTime).toLocaleString(language)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.cpuTime")}>
            {formatDuration(process.cpuTime)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.session")}>
            <span className="font-mono tabular-nums">{process.sessionId}</span>
          </InfoRow>
          <InfoRow label={t("taskManager.details.user")}>{details?.user ?? unknown}</InfoRow>
          <InfoRow label={t("taskManager.details.integrityLevel")}>
            {integrity(details?.integrity)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.architecture")}>
            {architecture(details?.architecture)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.priorityLabel")}>
            {priority ? t(`taskManager.details.priority.${priority}`) : unknown}
          </InfoRow>
          <InfoRow label={t("taskManager.details.efficiency")}>
            {t(
              process.efficiency
                ? "taskManager.details.efficiencyOn"
                : "taskManager.details.efficiencyOff"
            )}
          </InfoRow>
          <LongField label={t("taskManager.details.path")} value={process.path} unknown={unknown} />
          <LongField
            label={t("taskManager.details.commandLine")}
            value={details?.commandLine ?? null}
            unknown={unknown}
          />
        </div>
      </section>

      <section className="flex flex-col gap-2">
        <SectionTitle>{t("taskManager.details.section.resources")}</SectionTitle>
        <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
          <InfoRow label={t("taskManager.process.column.cpu")}>
            {formatPercent(process.cpu)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.privateWs")}>
            {formatBytes(process.privateWs)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.workingSet")}>
            {formatBytes(process.workingSet)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.commit")}>{formatBytes(process.commit)}</InfoRow>
          <InfoRow label={t("taskManager.details.diskRead")}>
            {process.diskRead === null ? "—" : formatRate(process.diskRead)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.diskWrite")}>
            {process.diskWrite === null ? "—" : formatRate(process.diskWrite)}
          </InfoRow>
          <InfoRow label={t("taskManager.details.gpu")}>
            {formatPercent(process.gpu)}
            {process.gpuEngine ? (
              <span className="text-muted-foreground"> · {process.gpuEngine}</span>
            ) : null}
          </InfoRow>
          <InfoRow label={t("taskManager.details.net")}>
            {processNetwork ? (
              t("taskManager.process.netRates", {
                sent: formatRate(process.netSent),
                received: formatRate(process.netReceived),
              })
            ) : (
              <span className="text-muted-foreground">
                {t("taskManager.details.netUnavailable")}
              </span>
            )}
          </InfoRow>
          <InfoRow label={t("taskManager.details.threads")}>
            <span className="font-mono tabular-nums">{process.threads}</span>
          </InfoRow>
          <InfoRow label={t("taskManager.details.handles")}>
            <span className="font-mono tabular-nums">{process.handles}</span>
          </InfoRow>
        </div>
      </section>

      {details &&
        (details.version.productName ||
          details.version.fileVersion ||
          details.version.description ||
          details.version.company) && (
          <section className="flex flex-col gap-2">
            <SectionTitle>{t("taskManager.details.section.version")}</SectionTitle>
            <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
              <InfoRow label={t("taskManager.details.product")}>
                {details.version.productName ?? unknown}
              </InfoRow>
              <InfoRow label={t("taskManager.details.version")}>
                {details.version.fileVersion ?? unknown}
              </InfoRow>
              <InfoRow label={t("taskManager.details.description")}>
                {details.version.description ?? unknown}
              </InfoRow>
              <InfoRow label={t("taskManager.details.company")}>
                {details.version.company ?? unknown}
              </InfoRow>
            </div>
          </section>
        )}
    </div>
  );
}

/** Copy and end actions for the selected process, pinned under the panel. */
export function ProcessDetailsActions({
  process,
  actions,
}: {
  process: ProcessRow;
  actions: ProcessActions;
}) {
  const { t } = useAppTranslation();
  const own = isOwnProcess(process, actions.selfNames);
  const needsService = isSystemProcess(process) && !actions.serviceReady;
  const endDisabled = own || needsService;
  const hint = own
    ? t("taskManager.process.selfHint")
    : needsService
      ? t("taskManager.process.systemNeedsService")
      : undefined;

  const copy = async (value: string, successKey: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t(successKey));
    } catch {
      toast.error(t("taskManager.toast.copyFailed"));
    }
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2 border-t px-4 py-3">
      <Button
        variant="outline"
        size="sm"
        title={t("taskManager.details.copyPid")}
        onClick={() => void copy(String(process.pid), "taskManager.toast.pidCopied")}
      >
        <Clipboard />
        {t("taskManager.details.copyPid")}
      </Button>
      <Button
        variant="outline"
        size="sm"
        disabled={!process.path}
        title={t("taskManager.details.copyPath")}
        onClick={() =>
          process.path ? void copy(process.path, "taskManager.toast.pathCopied") : undefined
        }
      >
        <Clipboard />
        {t("taskManager.details.copyPath")}
      </Button>
      <Button
        variant="outline"
        disabled={endDisabled}
        title={hint}
        onClick={() => actions.onRequestKillTree(process)}
      >
        <ListX />
        {t("taskManager.actions.killTree")}
      </Button>
      <Button
        variant="destructive"
        disabled={endDisabled}
        title={hint}
        onClick={() => actions.onRequestKill(process)}
      >
        <Skull />
        {t("taskManager.actions.kill")}
      </Button>
    </div>
  );
}
