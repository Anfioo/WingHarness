// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import {
  CONFIG_CHANGED_EVENT,
  moinDefaultDownloadDir,
  moinListBackends,
  proxyStatus,
  type MoinBackendInfo,
  type MoinSettings,
  type ProxyStatus,
} from "@/commands";
import { Aria2Row } from "@/components/moin/aria2-row";
import { RpcPanel } from "@/components/moin/rpc-panel";
import {
  Field,
  Section,
  SelectField,
  SwitchField,
  type SelectOption,
} from "@/components/moin/settings-sections";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinSettings } from "@/hooks/use-moin-settings";
import { formatBytes } from "@/lib/moin/format";

const MIB = 1024 * 1024;

// 0 = unlimited; the rest are sensible concurrency caps.
const CONCURRENCY_OPTIONS = [0, 1, 2, 3, 4, 5, 6, 8, 10, 16];
// Parallel connections per download. 1 = a single stream (no splitting).
const CONNECTION_OPTIONS = [1, 2, 4, 6, 8, 12, 16];
// Smallest piece worth its own connection. 1 MiB is aria2's floor.
const MIN_SPLIT_OPTIONS = [1, 2, 4, 8, 16, 32].map((mib) => mib * MIB);
// Seconds of no data before a download is marked failed; 0 = wait forever.
const STALL_OPTIONS = [30, 60, 120, 300, 0];
// Seconds to wait to reach a server; 0 = the system default.
const CONNECT_OPTIONS = [5, 10, 15, 30, 60, 0];
// How often batched progress reaches the list, in ms.
const FLUSH_OPTIONS = [100, 200, 250, 500, 1000];

/** Engine ids with copy of their own; anything else falls back to its own label. */
const BACKEND_KEYS: Record<string, string> = {
  embedded: "moin.backend.embedded",
  aria2: "moin.backend.aria2",
};

const seconds = (value: number) => `${value} s`;
const millis = (value: number) => `${value} ms`;

/**
 * Options for a numeric setting. A stored value that is not in the fixed list
 * (hand-edited config, or an older build) is kept selectable instead of being
 * silently rendered as an empty dropdown.
 */
function numberOptions(
  values: number[],
  format: (value: number) => string,
  current: number
): SelectOption[] {
  const all = values.includes(current) ? values : [...values, current].sort((a, b) => a - b);
  return all.map((value) => ({ value: String(value), label: format(value) }));
}

/**
 * The download partition of the Settings window: download, network, engine,
 * browser integration and about.
 *
 * Every control writes through `patch` the moment it changes — there is no save
 * button. The hook keeps the last document the engine accepted, so a rejected
 * value rolls the control back by itself; all that is left here is the toast.
 */
export function DownloadSection() {
  const { t } = useAppTranslation();
  const { settings, loading, saving, error, patch, reload } = useMoinSettings();
  const [backends, setBackends] = useState<MoinBackendInfo[]>([]);
  const [defaultDir, setDefaultDir] = useState("");
  const [dirDraft, setDirDraft] = useState("");
  const [proxy, setProxy] = useState<ProxyStatus | null>(null);

  const loadBackends = useCallback(async () => {
    try {
      setBackends(await moinListBackends());
    } catch {
      setBackends([]);
    }
  }, []);

  // The proxy itself lives in the Proxy partition; this one only reports it.
  const loadProxy = useCallback(() => {
    void proxyStatus()
      .then(setProxy)
      .catch(() => setProxy(null));
  }, []);

  useEffect(() => {
    void loadBackends();
    void moinDefaultDownloadDir()
      .then(setDefaultDir)
      .catch(() => setDefaultDir(""));
    loadProxy();
  }, [loadBackends, loadProxy]);

  // The Proxy partition emits this after saving; keep the read-only card in
  // step without polling.
  useEffect(() => {
    const pending = listen(CONFIG_CHANGED_EVENT, () => loadProxy());
    return () => {
      void pending.then((off) => off());
    };
  }, [loadProxy]);

  // A path chosen in the aria2 row can make a backend available, so re-read the
  // list whenever the probe result changes.
  const handleToolChange = useCallback(() => {
    void loadBackends();
  }, [loadBackends]);

  useEffect(() => {
    setDirDraft(settings?.download_dir ?? "");
  }, [settings?.download_dir]);

  const apply = (next: Partial<MoinSettings>) => {
    void patch(next);
  };

  const commitDir = () => {
    if (!settings) return;
    const next = dirDraft.trim() || null;
    if (next !== (settings.download_dir ?? null)) apply({ download_dir: next });
  };

  const pickDir = async () => {
    try {
      const picked = await open({ directory: true, multiple: false });
      if (typeof picked !== "string") return;
      setDirDraft(picked);
      apply({ download_dir: picked });
    } catch {
      toast.error(t("moin.settings.saveFailed"));
    }
  };

  // Only HTTP-capable engines belong here; an unavailable one stays listed but
  // cannot be picked, and the stored choice is always present so it resolves.
  const engineOptions: SelectOption[] = backends
    .filter((backend) => backend.http)
    .map((backend) => ({
      value: backend.id,
      label: BACKEND_KEYS[backend.id] ? t(BACKEND_KEYS[backend.id]) : backend.label,
      badge: backend.available ? undefined : t("moin.backend.unavailable"),
      disabled: !backend.available,
    }));

  if (settings && !engineOptions.some((option) => option.value === settings.http_backend)) {
    engineOptions.push({
      value: settings.http_backend,
      label: BACKEND_KEYS[settings.http_backend]
        ? t(BACKEND_KEYS[settings.http_backend])
        : settings.http_backend,
    });
  }

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.download.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.download.description")}</p>
      </div>

      {loading && !settings ? (
        <p className="text-muted-foreground flex items-center gap-2 text-sm">
          <LoaderCircle className="size-4 animate-spin" />
          {t("moin.common.loading")}
        </p>
      ) : !settings ? (
        <p role="alert" className="text-destructive text-sm">
          {t(error ?? "moin.settings.loadFailed")}
        </p>
      ) : (
        <>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {t(error)}
            </p>
          )}

          <Section>
            <div className="space-y-2 py-2.5">
              <div>
                <label htmlFor="moin-settings-download-dir" className="text-sm font-medium">
                  {t("moin.settings.field.downloadDir")}
                </label>
                <p className="text-muted-foreground mt-0.5 text-xs">
                  {t("moin.settings.hint.downloadDirFallback")}
                </p>
              </div>
              <div className="flex items-center gap-2">
                <Input
                  id="moin-settings-download-dir"
                  value={dirDraft}
                  disabled={saving}
                  placeholder={defaultDir}
                  spellCheck={false}
                  className="min-w-0 font-mono text-xs"
                  onChange={(event) => setDirDraft(event.target.value)}
                  onBlur={commitDir}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") event.currentTarget.blur();
                  }}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={saving}
                  onClick={() => void pickDir()}
                >
                  {t("moin.common.browse")}
                </Button>
                {settings.download_dir && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="shrink-0"
                    disabled={saving}
                    onClick={() => apply({ download_dir: null })}
                  >
                    {t("moin.common.clear")}
                  </Button>
                )}
              </div>
              {defaultDir && (
                <p className="text-muted-foreground truncate font-mono text-xs" title={defaultDir}>
                  {defaultDir}
                </p>
              )}
            </div>

            <SelectField
              label={t("moin.settings.field.maxConcurrent")}
              hint={t("moin.settings.hint.maxConcurrent")}
              note={t("moin.settings.hint.unlimited")}
              value={String(settings.max_concurrent)}
              options={numberOptions(
                CONCURRENCY_OPTIONS,
                (value) => (value === 0 ? t("moin.settings.option.unlimited") : String(value)),
                settings.max_concurrent
              )}
              disabled={saving}
              onChange={(value) => apply({ max_concurrent: Number(value) })}
            />

            <SwitchField
              label={t("moin.settings.field.addPaused")}
              hint={t("moin.settings.hint.addPaused")}
              checked={settings.add_paused}
              disabled={saving}
              onChange={(checked) => apply({ add_paused: checked })}
            />

            <SwitchField
              label={t("moin.settings.field.notifyOnComplete")}
              hint={t("moin.settings.hint.notifyOnComplete")}
              checked={settings.notify_on_complete}
              disabled={saving}
              onChange={(checked) => apply({ notify_on_complete: checked })}
            />

            <SelectField
              label={t("moin.settings.field.progressFlush")}
              hint={t("moin.settings.hint.progressFlush")}
              value={String(settings.progress_flush_ms)}
              options={numberOptions(FLUSH_OPTIONS, millis, settings.progress_flush_ms)}
              disabled={saving}
              onChange={(value) => apply({ progress_flush_ms: Number(value) })}
            />
          </Section>

          <Section title={t("moin.settings.network")}>
            <SelectField
              label={t("moin.settings.field.connections")}
              hint={t("moin.settings.hint.connections")}
              value={String(settings.connections)}
              options={numberOptions(
                CONNECTION_OPTIONS,
                (value) => (value === 1 ? t("moin.settings.option.singleStream") : String(value)),
                settings.connections
              )}
              disabled={saving}
              onChange={(value) => apply({ connections: Number(value) })}
            />

            <SelectField
              label={t("moin.settings.field.minSplitSize")}
              hint={t("moin.settings.hint.minSplitSize")}
              value={String(settings.min_split_size)}
              options={numberOptions(MIN_SPLIT_OPTIONS, formatBytes, settings.min_split_size)}
              disabled={saving}
              onChange={(value) => apply({ min_split_size: Number(value) })}
            />

            <SelectField
              label={t("moin.settings.field.connectTimeout")}
              hint={t("moin.settings.hint.connectTimeout")}
              note={t("moin.settings.hint.osDefault")}
              value={String(settings.connect_timeout_secs)}
              options={numberOptions(
                CONNECT_OPTIONS,
                (value) => (value === 0 ? t("moin.settings.option.unlimited") : seconds(value)),
                settings.connect_timeout_secs
              )}
              disabled={saving}
              onChange={(value) => apply({ connect_timeout_secs: Number(value) })}
            />

            <SelectField
              label={t("moin.settings.field.stallTimeout")}
              hint={t("moin.settings.hint.stallTimeout")}
              value={String(settings.stall_timeout_secs)}
              options={numberOptions(
                STALL_OPTIONS,
                (value) => (value === 0 ? t("moin.settings.option.never") : seconds(value)),
                settings.stall_timeout_secs
              )}
              disabled={saving}
              onChange={(value) => apply({ stall_timeout_secs: Number(value) })}
            />

            <SwitchField
              label={t("moin.settings.field.hidePartFiles")}
              hint={t("moin.settings.hint.hidePartFiles")}
              checked={settings.hide_part_files}
              disabled={saving}
              onChange={(checked) => apply({ hide_part_files: checked })}
            />
          </Section>

          <Section title={t("moin.settings.proxy")} description={t("moin.settings.proxyHint")}>
            <Field label={t("moin.settings.field.proxyMode")}>
              <span className="text-sm">
                {proxy ? t(`moin.settings.proxyMode.${proxy.mode}`) : "—"}
              </span>
            </Field>
            <Field label={t("moin.settings.field.proxyAddress")}>
              <span className="font-mono text-xs">
                {proxy ? (proxy.url ?? t("moin.settings.proxyDirect")) : "—"}
              </span>
            </Field>
            <Field
              label={t("moin.settings.field.proxyBypass")}
              hint={t("moin.settings.hint.proxyBypass")}
            >
              <span className="font-mono text-xs">{proxy?.noProxy ?? "—"}</span>
            </Field>
          </Section>

          <Section title={t("moin.settings.engine")}>
            <SelectField
              label={t("moin.settings.field.engine")}
              hint={t("moin.settings.hint.engine")}
              value={settings.http_backend}
              options={engineOptions}
              disabled={saving}
              onChange={(value) => apply({ http_backend: value })}
            />
            <Aria2Row disabled={saving} onStatusChange={handleToolChange} />
          </Section>

          <RpcPanel settings={settings} saving={saving} onPatch={patch} onReload={reload} />
        </>
      )}
    </div>
  );
}
