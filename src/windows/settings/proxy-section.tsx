import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";
import type { ProxyConfig } from "@/commands";

/**
 * The proxy the app's HTTP clients and the tools it spawns go through.
 *
 * `useConfigDraft` saves 400 ms after the last edit, and the backend pushes the
 * value into the process environment — so git, the AI CLIs and the terminal
 * inherit it too. That is what a console launch with `HTTPS_PROXY` exported used
 * to be needed for.
 */
export function ProxySection() {
  const { t } = useAppTranslation();
  const { draft, setDraft, loading } = useConfigDraft("proxy");

  const update = (patch: Partial<ProxyConfig>) => {
    setDraft((current) =>
      current ? { ...current, proxy: { ...current.proxy, ...patch } } : current
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.proxy.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.proxy.description")}</p>
      </div>

      {loading && !draft ? (
        <Skeleton className="h-64 rounded-xl" />
      ) : draft ? (
        <div className="space-y-4">
          <div className="border-border space-y-4 rounded-xl border px-4 py-3">
            <div className="space-y-2">
              <label htmlFor="proxy-url" className="text-sm font-medium">
                {t("settings.proxy.urlLabel")}
              </label>
              <p className="text-muted-foreground text-xs">{t("settings.proxy.urlHint")}</p>
              <Input
                id="proxy-url"
                value={draft.proxy.url}
                onChange={(event) => update({ url: event.target.value })}
                placeholder={t("settings.proxy.urlPlaceholder")}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>

            <div className="space-y-2">
              <label htmlFor="proxy-no-proxy" className="text-sm font-medium">
                {t("settings.proxy.noProxyLabel")}
              </label>
              <p className="text-muted-foreground text-xs">{t("settings.proxy.noProxyHint")}</p>
              <Input
                id="proxy-no-proxy"
                value={draft.proxy.noProxy}
                onChange={(event) => update({ noProxy: event.target.value })}
                placeholder={t("settings.proxy.noProxyPlaceholder")}
                spellCheck={false}
                className="font-mono text-xs"
              />
            </div>
          </div>

          <div className="border-border space-y-1 border-t pt-4">
            <p className="text-muted-foreground text-xs">{t("settings.proxy.autoSave")}</p>
            <p className="text-muted-foreground text-xs">{t("settings.proxy.envNote")}</p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("settings.proxy.loadFailed")}</p>
      )}
    </div>
  );
}
