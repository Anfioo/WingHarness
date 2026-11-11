// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  moinListBackends,
  moinRegenerateRpcToken,
  moinRpcStatus,
  moinSetToolPath,
  moinToolStatus,
  type MoinBackendInfo,
  type MoinRpcStatus,
  type MoinToolStatus,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinSettings } from "@/hooks/use-moin-settings";
import { formatBytes } from "@/lib/moin/format";

/** A number input that only commits on blur, so a half-typed value never patches. */
function NumberField({
  label,
  hint,
  value,
  min,
  max,
  disabled,
  onCommit,
}: {
  label: string;
  hint?: string;
  value: number;
  min: number;
  max: number;
  disabled: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
      setDraft(String(value));
      return;
    }
    if (parsed !== value) onCommit(parsed);
  };

  return (
    <label className="grid gap-1.5 text-sm sm:grid-cols-[minmax(12rem,0.7fr)_minmax(10rem,1fr)] sm:items-center">
      <span>{label}</span>
      <Input
        type="number"
        min={min}
        max={max}
        step={1}
        value={draft}
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
      />
      {hint && <span className="text-muted-foreground text-xs sm:col-start-2">{hint}</span>}
    </label>
  );
}

function Toggle({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        className="accent-primary size-4"
      />
      {label}
    </label>
  );
}

export default function SettingsTab() {
  const { t } = useAppTranslation();
  const { settings, loading, saving, error, patch } = useMoinSettings();
  const [backends, setBackends] = useState<MoinBackendInfo[]>([]);
  const [tool, setTool] = useState<MoinToolStatus | null>(null);
  const [rpc, setRpc] = useState<MoinRpcStatus | null>(null);
  const [tokenVisible, setTokenVisible] = useState(false);
  const [downloadDir, setDownloadDir] = useState("");

  useEffect(() => {
    void moinListBackends()
      .then(setBackends)
      .catch(() => undefined);
    void moinToolStatus()
      .then(setTool)
      .catch(() => undefined);
    void moinRpcStatus()
      .then(setRpc)
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    setDownloadDir(settings?.download_dir ?? "");
  }, [settings?.download_dir]);

  if (loading && !settings) {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-2 rounded-lg border py-12 text-sm">
        <LoaderCircle className="size-4 animate-spin" />
        {t("moin.common.loading")}
      </div>
    );
  }

  if (!settings) {
    return (
      <div role="alert" className="rounded-lg border p-4">
        <p className="text-destructive text-sm">{t(error ?? "moin.settings.loadFailed")}</p>
      </div>
    );
  }

  const apply = async (next: Parameters<typeof patch>[0], success = false) => {
    await patch(next);
    if (success) toast.success(t("moin.settings.saveSuccess"));
  };

  const commitDownloadDir = () => {
    const next = downloadDir.trim() || null;
    if (next !== (settings.download_dir ?? null)) {
      void apply({ download_dir: next }, true);
    }
  };

  return (
    <div className="flex max-w-3xl flex-col gap-4">
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {t(error)}
        </p>
      )}

      <section className="bg-card rounded-lg border p-4 sm:p-5">
        <h2 className="mb-4 font-semibold">{t("moin.settings.download")}</h2>
        <div className="grid gap-4">
          <label className="grid gap-1.5 text-sm sm:grid-cols-[minmax(12rem,0.7fr)_minmax(10rem,1fr)] sm:items-center">
            <span>{t("moin.settings.field.downloadDir")}</span>
            <Input
              value={downloadDir}
              disabled={saving}
              onChange={(event) => setDownloadDir(event.target.value)}
              onBlur={commitDownloadDir}
              placeholder={t("moin.settings.hint.downloadDirFallback")}
            />
          </label>
          <NumberField
            label={t("moin.settings.field.maxConcurrent")}
            hint={t("moin.settings.hint.unlimited")}
            value={settings.max_concurrent}
            min={0}
            max={64}
            disabled={saving}
            onCommit={(value) => void apply({ max_concurrent: value })}
          />
          <NumberField
            label={t("moin.settings.field.connections")}
            value={settings.connections}
            min={1}
            max={64}
            disabled={saving}
            onCommit={(value) => void apply({ connections: value })}
          />
          <NumberField
            label={t("moin.settings.field.stallTimeout")}
            hint={t("moin.settings.hint.osDefault")}
            value={settings.stall_timeout_secs}
            min={0}
            max={3_600}
            disabled={saving}
            onCommit={(value) => void apply({ stall_timeout_secs: value })}
          />
          <NumberField
            label={t("moin.settings.field.connectTimeout")}
            hint={t("moin.settings.hint.osDefault")}
            value={settings.connect_timeout_secs}
            min={0}
            max={600}
            disabled={saving}
            onCommit={(value) => void apply({ connect_timeout_secs: value })}
          />
          <NumberField
            label={t("moin.settings.field.progressFlush")}
            value={settings.progress_flush_ms}
            min={100}
            max={5_000}
            disabled={saving}
            onCommit={(value) => void apply({ progress_flush_ms: value })}
          />
          <p className="text-muted-foreground text-xs">
            {t("moin.settings.field.minSplitSize")}: {formatBytes(settings.min_split_size)}
          </p>
          <Toggle
            label={t("moin.settings.field.addPaused")}
            checked={settings.add_paused}
            disabled={saving}
            onChange={(value) => void apply({ add_paused: value })}
          />
          <Toggle
            label={t("moin.settings.field.hidePartFiles")}
            checked={settings.hide_part_files}
            disabled={saving}
            onChange={(value) => void apply({ hide_part_files: value })}
          />
          <Toggle
            label={t("moin.settings.field.notifyOnComplete")}
            checked={settings.notify_on_complete}
            disabled={saving}
            onChange={(value) => void apply({ notify_on_complete: value })}
          />
        </div>
      </section>

      <section className="bg-card rounded-lg border p-4 sm:p-5">
        <h2 className="mb-4 font-semibold">{t("moin.settings.engine")}</h2>
        <ul className="mb-4 flex flex-col gap-1 text-sm">
          {backends.map((backend) => (
            <li key={backend.id} className="flex items-center justify-between gap-3">
              <span>
                {backend.id === "embedded" ? t("moin.backend.embedded") : t("moin.backend.aria2")}
              </span>
              <span className="text-muted-foreground text-xs">
                {backend.available ? t("moin.tool.present") : t("moin.backend.unavailable")}
              </span>
            </li>
          ))}
        </ul>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("moin.backend.aria2")}</span>
          <span className="text-muted-foreground text-xs">
            {tool?.present ? t("moin.tool.present") : t("moin.tool.missing")}
          </span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => void moinToolStatus().then(setTool)}
          >
            {t("moin.tool.reprobe")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => {
              void open({ multiple: false, directory: false })
                .then((selected) => {
                  if (typeof selected !== "string") return undefined;
                  return moinSetToolPath(selected);
                })
                .then((status) => {
                  if (!status) return;
                  setTool(status);
                  toast.success(t("moin.settings.saveSuccess"));
                })
                .catch(() => toast.error(t("moin.settings.saveFailed")));
            }}
          >
            {t("moin.tool.choose")}
          </Button>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">{t("moin.tool.fallbackHint")}</p>
      </section>

      <section className="bg-card rounded-lg border p-4 sm:p-5">
        <h2 className="mb-4 font-semibold">{t("moin.settings.browser")}</h2>
        <div className="grid gap-4">
          <Toggle
            label={t("moin.settings.field.rpcEnabled")}
            checked={settings.rpc_enabled}
            disabled={saving}
            onChange={(value) => void apply({ rpc_enabled: value })}
          />
          <NumberField
            label={t("moin.settings.field.rpcPort")}
            hint={t("moin.settings.hint.restartRequired")}
            value={settings.rpc_port}
            min={1}
            max={65_535}
            disabled={saving}
            onCommit={(value) => void apply({ rpc_port: value })}
          />
          <div className="grid gap-1.5 text-sm">
            <span>{t("moin.settings.field.rpcToken")}</span>
            <div className="flex flex-wrap items-center gap-2">
              <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1 text-xs">
                {tokenVisible
                  ? settings.rpc_token
                  : "•".repeat(Math.min(32, settings.rpc_token.length))}
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
                onClick={() =>
                  void moinRegenerateRpcToken().then(() => {
                    toast.success(t("moin.settings.saveSuccess"));
                  })
                }
              >
                {t("moin.rpc.regenerate")}
              </Button>
            </div>
            <p className="text-muted-foreground text-xs">
              {rpc?.bound ? t("moin.rpc.running") : t("moin.rpc.stopped")}
              {rpc?.address ? ` · ${rpc.address}` : ""}
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}
