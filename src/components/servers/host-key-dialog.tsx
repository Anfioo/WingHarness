import { useEffect, useState } from "react";
import { Copy, Loader2, ShieldAlert, ShieldCheck } from "lucide-react";
import { toast } from "sonner";
import {
  serverConnect,
  serverHostKeyForget,
  serverHostKeyTrustPending,
} from "@/commands/services/servers";
import type { ConnectOutcome } from "@/commands/services/servers/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText, serverErrorCodeKey } from "@/lib/servers/format";

/** What the engine reported about the host key that needs a decision. */
export type HostKeyRequest = {
  profileId: string;
  /** Fingerprint presented by the host; the value the user is asked to trust. */
  fingerprint: string;
  algorithm: string;
  host?: string;
  port?: number;
  /** Terminal size for the retry that follows a trust decision. */
  cols?: number;
  rows?: number;
  /** `mismatch` never offers a trust button — only "forget" and close. */
  mode?: "unknown" | "mismatch";
  /** Previously trusted fingerprint, shown for comparison on mismatch. */
  trusted?: string;
};

export type HostKeyDialogProps = {
  request: HostKeyRequest | null;
  onOpenChange: (open: boolean) => void;
  /** Called with the retried connection after the key was trusted. */
  onTrusted?: (outcome: ConnectOutcome) => void;
  /** Called after the saved key was removed, so the caller can retry later. */
  onForgotten?: () => void;
  onFailed?: (error: unknown) => void;
};

function FingerprintBlock({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <code className="border-border bg-muted rounded-md border px-2.5 py-1.5 font-mono text-xs leading-relaxed break-all">
        {value}
      </code>
    </div>
  );
}

/**
 * First-contact fingerprint confirmation, and the blocked state for a changed
 * key.
 *
 * Trusting calls `server_host_key_trust_pending` first and then retries
 * `server_connect` with `trustHostKey=true`. A mismatch is deliberately not
 * escapable from here: the user has to forget the record explicitly.
 */
export function HostKeyDialog({
  request,
  onOpenChange,
  onTrusted,
  onForgotten,
  onFailed,
}: HostKeyDialogProps) {
  const { t } = useAppTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setBusy(false);
    setError(null);
  }, [request?.profileId, request?.fingerprint, request?.mode]);

  const describeFailure = (failure: unknown) => {
    const key = serverErrorCodeKey(failure);
    return key ? t(key, { defaultValue: errorText(failure) }) : errorText(failure);
  };

  const trust = async () => {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await serverHostKeyTrustPending(request.profileId, request.fingerprint);
      const outcome = await serverConnect(
        request.profileId,
        request.cols ?? 80,
        request.rows ?? 24,
        true
      );
      onTrusted?.(outcome);
      onOpenChange(false);
    } catch (failure) {
      setError(describeFailure(failure));
      onFailed?.(failure);
    } finally {
      setBusy(false);
    }
  };

  const forget = async () => {
    if (!request || busy) return;
    setBusy(true);
    setError(null);
    try {
      await serverHostKeyForget(request.profileId);
      toast.success(t("servers.hostKey.forgotten", { defaultValue: "Saved host key removed." }));
      onForgotten?.();
      onOpenChange(false);
    } catch (failure) {
      setError(describeFailure(failure));
      onFailed?.(failure);
    } finally {
      setBusy(false);
    }
  };

  const copyFingerprint = async () => {
    if (!request) return;
    try {
      await navigator.clipboard.writeText(request.fingerprint);
      toast.success(t("servers.hostKey.copied", { defaultValue: "Fingerprint copied." }));
    } catch (failure) {
      toast.error(errorText(failure));
    }
  };

  const mismatch = request?.mode === "mismatch";
  const endpoint = request?.host
    ? request.port
      ? `${request.host}:${request.port}`
      : request.host
    : null;

  return (
    <Dialog open={request !== null} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {mismatch ? (
              <ShieldAlert className="text-destructive size-4 shrink-0" />
            ) : (
              <ShieldCheck className="text-primary size-4 shrink-0" />
            )}
            {t("servers.hostKey.title")}
          </DialogTitle>
          <DialogDescription>
            {mismatch
              ? t("servers.hostKey.mismatch")
              : t("servers.hostKey.unknownHint", {
                  defaultValue:
                    "This host is not trusted yet. Compare the fingerprint before continuing.",
                })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {endpoint && <span className="text-muted-foreground text-xs">{endpoint}</span>}

          {mismatch && request?.trusted && (
            <FingerprintBlock
              label={t("servers.hostKey.trustedFingerprint", {
                defaultValue: "Trusted fingerprint",
              })}
              value={request.trusted}
            />
          )}

          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <FingerprintBlock
                label={`${t("servers.hostKey.fingerprint")} · ${request?.algorithm ?? ""}`}
                value={request?.fingerprint ?? ""}
              />
            </div>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mt-6"
              aria-label={t("servers.hostKey.copy", { defaultValue: "Copy fingerprint" })}
              title={t("servers.hostKey.copy", { defaultValue: "Copy fingerprint" })}
              onClick={() => void copyFingerprint()}
            >
              <Copy />
            </Button>
          </div>

          {mismatch && (
            <p className="text-muted-foreground text-xs">{t("servers.hostKey.forgetHint")}</p>
          )}

          {error && (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-1.5 text-xs">
              {error}
            </p>
          )}
        </div>

        <DialogFooter>
          <Button variant="ghost" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("servers.form.cancel")}
          </Button>
          {mismatch ? (
            <Button variant="destructive" disabled={busy} onClick={() => void forget()}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldAlert />}
              {t("servers.action.forgetHostKey")}
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void trust()}>
              {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              {t("servers.hostKey.trust")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
