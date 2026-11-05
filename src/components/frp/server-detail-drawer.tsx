import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  Copy,
  Loader2,
  Pencil,
  Play,
  RotateCw,
  ScrollText,
  ShieldCheck,
  Square,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import { frpConfigPreview, frpConfigVerify } from "@/commands/services/frp";
import {
  isFrpError,
  type ConfigPreview,
  type ConfigVerifyResult,
  type ConnectionSnapshot,
  type FrpProfile,
  type RuntimeView,
  type TunnelState,
  type TunnelView,
} from "@/commands/services/frp/types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { isActiveProcessState, StateBadge } from "@/components/frp/state-badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatEndpoint, formatLatency, formatVersion, frpFailureKey } from "@/lib/frp/format";
import { cn } from "@/lib/utils";

export type ServerDetailDrawerProps = {
  open: boolean;
  profile: FrpProfile | null;
  snapshot: ConnectionSnapshot | null;
  /** All tunnels; the drawer narrows them to this profile. */
  tunnels: TunnelView[];
  runtimes: RuntimeView[];
  busy: boolean;
  needsRestart: boolean;
  onOpenChange: (open: boolean) => void;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onViewLogs: () => void;
};

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 text-sm">
      <span className="text-muted-foreground shrink-0">{label}</span>
      <span className="min-w-0 text-right break-words">{children}</span>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <h3 className="text-foreground text-sm font-medium">{children}</h3>;
}

/**
 * Read-only detail view for one profile: live state, runtime binding, the
 * redacted config the engine would run, and the tunnel summary. Actions are
 * delegated to the owning tab so both the overview and the servers tab share
 * the same busy/confirm behavior.
 */
export function ServerDetailDrawer({
  open,
  profile,
  snapshot,
  tunnels,
  runtimes,
  busy,
  needsRestart,
  onOpenChange,
  onStart,
  onStop,
  onRestart,
  onEdit,
  onDelete,
  onViewLogs,
}: ServerDetailDrawerProps) {
  const { t } = useAppTranslation();
  const profileId = profile?.id ?? null;

  const [preview, setPreview] = useState<ConfigPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [verifyResult, setVerifyResult] = useState<ConfigVerifyResult | null>(null);
  const [verifyError, setVerifyError] = useState<{
    message: string;
    rawOutput: string | null;
  } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const describe = useCallback(
    (failure: unknown): string => {
      if (isFrpError(failure)) {
        const key = frpFailureKey(failure);
        const message = failure.message.trim();
        if (key) return message ? `${t(key)}: ${message}` : t(key);
        return message || t("frp.error.internal");
      }
      return failure instanceof Error ? failure.message : String(failure);
    },
    [t]
  );

  useEffect(() => {
    if (!open || !profileId) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(null);
    setPreviewLoading(true);
    setVerifyResult(null);
    setVerifyError(null);

    frpConfigPreview(profileId)
      .then((result) => {
        if (!cancelled) setPreview(result);
      })
      .catch((failure) => {
        if (!cancelled) setPreviewError(describe(failure));
      })
      .finally(() => {
        if (!cancelled) setPreviewLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, profileId, describe]);

  const profileTunnels = useMemo(
    () => tunnels.filter((tunnel) => tunnel.profileId === profileId),
    [tunnels, profileId]
  );

  const pinnedRuntime =
    profile?.runtimePolicy === "pinned" && profile.runtimeId
      ? (runtimes.find((runtime) => runtime.id === profile.runtimeId) ?? null)
      : null;

  const state = snapshot?.state ?? "stopped";
  const active = isActiveProcessState(state);

  const verifyConfig = async () => {
    if (!profileId || verifying) return;
    setVerifying(true);
    setVerifyResult(null);
    setVerifyError(null);
    try {
      setVerifyResult(await frpConfigVerify(profileId));
    } catch (failure) {
      const rawOutput =
        isFrpError(failure) && failure.detail && typeof failure.detail.rawOutput === "string"
          ? failure.detail.rawOutput
          : null;
      setVerifyError({ message: describe(failure), rawOutput });
    } finally {
      setVerifying(false);
    }
  };

  const copyConfig = async () => {
    if (!preview) return;
    try {
      await navigator.clipboard.writeText(preview.content);
      toast.success(t("frp.common.copied"));
    } catch {
      toast.error(t("frp.common.copyFailed"));
    }
  };

  const tunnelStateOf = (tunnel: TunnelView): TunnelState => {
    if (!active) return "offline";
    return snapshot?.tunnelStates.find((entry) => entry.name === tunnel.name)?.state ?? "offline";
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full gap-0 sm:max-w-lg">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2">
            <span className="min-w-0 truncate">{profile?.name ?? t("frp.serverDetail.title")}</span>
            <StateBadge state={state} />
            {needsRestart && (
              <Badge
                variant="outline"
                className="border-amber-500/40 text-amber-700 dark:text-amber-400"
              >
                {t("frp.servers.badgeRestart")}
              </Badge>
            )}
          </SheetTitle>
          <SheetDescription className="font-mono">
            {profile ? formatEndpoint(profile.serverAddr, profile.serverPort) : "—"}
          </SheetDescription>
        </SheetHeader>

        <div className="flex flex-col gap-5 overflow-y-auto px-4 pt-2 pb-4">
          <div className="flex flex-wrap items-center gap-2">
            {active ? (
              <Button size="sm" variant="outline" disabled={busy} onClick={onStop}>
                {busy ? <Loader2 className="animate-spin" /> : <Square />}
                {t("frp.common.stop")}
              </Button>
            ) : (
              <Button size="sm" disabled={busy} onClick={onStart}>
                {busy ? <Loader2 className="animate-spin" /> : <Play />}
                {t("frp.common.start")}
              </Button>
            )}
            <Button size="sm" variant="outline" disabled={busy} onClick={onRestart}>
              <RotateCw />
              {t("frp.common.restart")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onEdit}>
              <Pencil />
              {t("frp.common.edit")}
            </Button>
            <Button size="sm" variant="outline" onClick={onViewLogs}>
              <ScrollText />
              {t("frp.serverDetail.viewLogs")}
            </Button>
            <Button size="sm" variant="outline" disabled={busy} onClick={onDelete}>
              <Trash2 />
              {t("frp.common.delete")}
            </Button>
          </div>

          {needsRestart && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("frp.serverDetail.restartToApply")}
            </p>
          )}

          <section className="flex flex-col gap-2">
            <SectionTitle>{t("frp.serverDetail.basic")}</SectionTitle>
            <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
              <InfoRow label={t("frp.serverForm.name")}>{profile?.name ?? "—"}</InfoRow>
              <InfoRow label={t("frp.serverForm.token")}>
                <span className="font-mono">{profile?.token ? "••••••" : "—"}</span>
              </InfoRow>
              <InfoRow label={t("frp.serverForm.reconnect")}>
                {profile?.reconnectEnabled ? t("frp.common.enabled") : t("frp.common.disabled")}
              </InfoRow>
              <InfoRow label={t("frp.servers.col.status")}>
                <StateBadge state={state} />
              </InfoRow>
              <InfoRow label={t("frp.overview.pid")}>
                <span className="tabular-nums">{snapshot?.pid ?? "—"}</span>
              </InfoRow>
              <InfoRow label={t("frp.servers.col.latency")}>
                <span className="tabular-nums">{formatLatency(snapshot?.latencyMs)}</span>
              </InfoRow>
              <InfoRow label={t("frp.serverForm.note")}>{profile?.note?.trim() || "—"}</InfoRow>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>{t("frp.serverDetail.runtime")}</SectionTitle>
            <div className="bg-muted/40 flex flex-col gap-1.5 rounded-lg p-3">
              <InfoRow label={t("frp.serverForm.runtimePolicy")}>
                {profile?.runtimePolicy === "pinned"
                  ? t("frp.serverForm.runtimePinned")
                  : t("frp.serverForm.runtimeRecommended")}
              </InfoRow>
              <InfoRow label={t("frp.serverForm.runtime")}>
                {profile?.runtimePolicy === "pinned"
                  ? pinnedRuntime
                    ? formatVersion(pinnedRuntime.version)
                    : t("frp.servers.runtime.missing")
                  : formatVersion(snapshot?.runtimeVersion ?? null)}
              </InfoRow>
              {pinnedRuntime && (
                <p className="text-muted-foreground truncate font-mono text-[11px]">
                  {pinnedRuntime.path}
                </p>
              )}
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <div className="flex items-center justify-between gap-2">
              <SectionTitle>{t("frp.serverDetail.configPreview")}</SectionTitle>
              <Button
                variant="ghost"
                size="xs"
                disabled={!preview}
                onClick={() => void copyConfig()}
              >
                <Copy />
                {t("frp.serverDetail.copyConfig")}
              </Button>
            </div>
            <div className="border-border bg-muted/30 max-h-72 overflow-auto rounded-lg border p-3">
              {previewLoading ? (
                <p className="text-muted-foreground flex items-center gap-2 text-xs">
                  <Loader2 className="size-3 animate-spin" />
                  {t("frp.serverDetail.configLoading")}
                </p>
              ) : previewError ? (
                <p className="text-destructive text-xs break-words">{previewError}</p>
              ) : (
                <pre className="font-mono text-xs whitespace-pre">{preview?.content ?? ""}</pre>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={verifying || previewLoading}
                onClick={() => void verifyConfig()}
              >
                {verifying ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
                {verifying ? t("frp.serverDetail.verifying") : t("frp.serverDetail.verify")}
              </Button>
              {verifyResult && (
                <Badge
                  variant="outline"
                  className={
                    verifyResult.valid
                      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                      : "border-destructive/30 bg-destructive/10 text-destructive"
                  }
                >
                  {verifyResult.valid ? <CheckCircle2 /> : <XCircle />}
                  {verifyResult.valid
                    ? t("frp.serverDetail.verifyValid")
                    : t("frp.serverDetail.verifyInvalid")}
                </Badge>
              )}
              {verifyError && (
                <Badge
                  variant="outline"
                  className="border-destructive/30 bg-destructive/10 text-destructive"
                >
                  <XCircle />
                  {t("frp.serverDetail.verifyInvalid")}
                </Badge>
              )}
            </div>
            {verifyResult && !verifyResult.valid && verifyResult.rawOutput && (
              <div className="border-border bg-muted/30 overflow-auto rounded-lg border p-3">
                <p className="text-muted-foreground mb-1 text-xs">
                  {t("frp.serverDetail.rawOutput")}
                </p>
                <pre className="font-mono text-xs whitespace-pre">{verifyResult.rawOutput}</pre>
              </div>
            )}
            {verifyError && (
              <div className="border-border bg-muted/30 overflow-auto rounded-lg border p-3">
                <p className="text-destructive text-xs break-words">{verifyError.message}</p>
                {verifyError.rawOutput && (
                  <pre className="mt-2 font-mono text-xs whitespace-pre">
                    {verifyError.rawOutput}
                  </pre>
                )}
              </div>
            )}
          </section>

          <section className="flex flex-col gap-2">
            <SectionTitle>{t("frp.serverDetail.tunnels")}</SectionTitle>
            {profileTunnels.length === 0 ? (
              <p className="text-muted-foreground text-xs">{t("frp.serverDetail.noTunnels")}</p>
            ) : (
              <ul className="flex flex-col gap-1">
                {profileTunnels.map((tunnel) => (
                  <li
                    key={tunnel.id}
                    className={cn(
                      "border-border flex items-center gap-2 rounded-md border px-2 py-1.5 text-xs",
                      !tunnel.enabled && "opacity-60"
                    )}
                  >
                    <span className="min-w-0 flex-1 truncate font-medium">{tunnel.name}</span>
                    <Badge variant="secondary">{tunnel.type.toUpperCase()}</Badge>
                    <span className="text-muted-foreground shrink-0 font-mono">
                      {formatEndpoint(tunnel.localIp, tunnel.localPort)}
                    </span>
                    <StateBadge state={tunnelStateOf(tunnel)} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export type ServerDeleteDialogProps = {
  profile: FrpProfile | null;
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

/** Shared delete confirmation: it stops frpc and cascades to tunnels, config and logs. */
export function ServerDeleteDialog({
  profile,
  open,
  busy,
  onOpenChange,
  onConfirm,
}: ServerDeleteDialogProps) {
  const { t } = useAppTranslation();

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("frp.delete.title")}</DialogTitle>
          <DialogDescription>{t("frp.delete.description")}</DialogDescription>
        </DialogHeader>
        {profile && <p className="text-sm font-medium">{profile.name}</p>}
        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("frp.common.cancel")}
          </Button>
          <Button variant="destructive" disabled={busy} onClick={onConfirm}>
            {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t("frp.common.delete")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
