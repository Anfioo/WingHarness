// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  moinRegenerateRpcToken,
  moinRpcStatus,
  type MoinRpcStatus,
  type MoinSettings,
} from "@/commands";
import { Field, NumberField, Section, SwitchField } from "@/components/moin/settings-sections";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The listener only binds once at start-up, so the badge polls instead of
 * subscribing: `bound` changes when the app restarts, not while the page is open.
 */
const STATUS_POLL_MS = 5_000;

/** `abcd••••wxyz` — enough to recognise a token without showing it in full. */
function maskToken(token: string): string {
  if (token.length <= 8) return "••••";
  return `${token.slice(0, 4)}••••${token.slice(-4)}`;
}

export type RpcPanelProps = {
  settings: MoinSettings;
  saving: boolean;
  onPatch: (patch: Partial<MoinSettings>) => Promise<void>;
  /** Re-reads the settings document; the regenerated token lands there. */
  onReload: () => Promise<void>;
};

/**
 * Browser integration: the loopback endpoint the companion extension talks to.
 *
 * The switch and the port are read once at start-up, so changing either only
 * takes effect after a restart — the panel says so as soon as one of them has
 * actually been stored. The token is read per request, so rotating it is
 * immediate and gets no restart notice.
 */
export function RpcPanel({ settings, saving, onPatch, onReload }: RpcPanelProps) {
  const { t } = useAppTranslation();
  const [status, setStatus] = useState<MoinRpcStatus | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  // The values the user just asked for. Comparing them with the stored document
  // keeps the restart notice honest: a rejected patch never shows it.
  const [pending, setPending] = useState<{ enabled?: boolean; port?: number }>({});

  const refreshStatus = useCallback(async () => {
    try {
      setStatus(await moinRpcStatus());
    } catch {
      setStatus(null);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    const timer = window.setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshStatus]);

  const toggleEnabled = async (enabled: boolean) => {
    await onPatch({ rpc_enabled: enabled });
    setPending((current) => ({ ...current, enabled }));
    await refreshStatus();
  };

  const commitPort = async (port: number) => {
    await onPatch({ rpc_port: port });
    setPending((current) => ({ ...current, port }));
    await refreshStatus();
  };

  const copyToken = async () => {
    try {
      await navigator.clipboard.writeText(settings.rpc_token);
      toast.success(t("moin.action.copied"));
    } catch {
      toast.error(t("moin.common.operationFailed"));
    }
  };

  const regenerate = async () => {
    setRegenerating(true);
    try {
      await moinRegenerateRpcToken();
      await onReload();
      toast.success(t("moin.settings.saveSuccess"));
    } catch {
      toast.error(t("moin.settings.saveFailed"));
    } finally {
      setRegenerating(false);
    }
  };

  const restartPending =
    (pending.enabled !== undefined && pending.enabled === settings.rpc_enabled) ||
    (pending.port !== undefined && pending.port === settings.rpc_port);

  return (
    <Section title={t("moin.settings.browser")}>
      <SwitchField
        label={t("moin.settings.field.rpcEnabled")}
        hint={t("moin.settings.hint.rpcEnabled")}
        checked={settings.rpc_enabled}
        disabled={saving}
        onChange={(enabled) => void toggleEnabled(enabled)}
      />

      <NumberField
        label={t("moin.settings.field.rpcPort")}
        hint={t("moin.settings.hint.rpcPort")}
        value={settings.rpc_port}
        min={1}
        max={65_535}
        disabled={saving}
        onCommit={(port) => void commitPort(port)}
      />

      <Field label={t("moin.settings.field.rpcToken")} hint={t("moin.settings.hint.rpcToken")}>
        <div className="flex flex-wrap items-center gap-2 sm:justify-end">
          <code className="bg-muted min-w-0 truncate rounded-md px-2 py-1 font-mono text-xs sm:max-w-56">
            {tokenVisible ? settings.rpc_token : maskToken(settings.rpc_token)}
          </code>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => setTokenVisible((current) => !current)}
          >
            {tokenVisible ? t("moin.rpc.hideToken") : t("moin.rpc.showToken")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!settings.rpc_token}
            onClick={() => void copyToken()}
          >
            {t("moin.rpc.copyToken")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={regenerating}
            onClick={() => void regenerate()}
          >
            {t("moin.rpc.regenerate")}
          </Button>
        </div>
      </Field>

      <div className="space-y-1.5 py-2.5">
        <div className="flex flex-wrap items-center justify-end gap-2">
          {status?.address && (
            <code className="text-muted-foreground font-mono text-xs">{status.address}</code>
          )}
          <Badge variant={status?.bound ? "secondary" : "outline"}>
            <span
              aria-hidden
              className={
                status?.bound
                  ? "size-1.5 rounded-full bg-emerald-500"
                  : "bg-muted-foreground size-1.5 rounded-full"
              }
            />
            {status?.bound ? t("moin.rpc.running") : t("moin.rpc.stopped")}
          </Badge>
        </div>

        {restartPending && (
          <p className="text-muted-foreground text-right text-xs">
            {t("moin.settings.hint.restartRequired")}
          </p>
        )}
      </div>
    </Section>
  );
}
