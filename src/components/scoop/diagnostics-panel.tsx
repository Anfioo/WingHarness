import { useCallback, useEffect, useState } from "react";
import { AlertTriangle, Check, Loader2, RefreshCw, Trash2 } from "lucide-react";
import type { ScoopCacheClear, ScoopCheckupItem } from "@/commands";
import { scoopCacheClear, scoopCheckup, scoopOpenSettings } from "@/commands";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { formatBytes, messageOf } from "@/lib/scoop/diagnostics";
import { ScoopCacheManager } from "./cache-manager";
import { ScoopShimManager } from "./shim-manager";

/**
 * The install's health, what can be cleaned up, and the two folders Scoop fills
 * on its own: the download cache and the shims.
 *
 * Only the checkup is read from the backend as a list of ids; the sentences are
 * the page's, so a row can never arrive translated from somewhere else.
 */
export function ScoopDiagnosticsPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const [items, setItems] = useState<ScoopCheckupItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [cacheKey, setCacheKey] = useState(0);
  const [clearing, setClearing] = useState(false);
  const [cleared, setCleared] = useState<ScoopCacheClear | null>(null);
  const busy = page.running !== null || page.preparing;

  const check = useCallback(async () => {
    setLoading(true);
    try {
      setItems(await scoopCheckup());
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void check();
  }, [check]);

  const fix = (item: ScoopCheckupItem) => {
    const action = item.fix;
    if (!action) return;
    switch (action.kind) {
      case "installPackage":
        void page.installApp(action.package);
        break;
      case "installBucket":
        void page.addBucket(action.name, action.url);
        break;
      case "openSettings":
        void scoopOpenSettings(action.page).catch((failure) => setError(messageOf(failure)));
        break;
    }
  };

  const fixLabel = (item: ScoopCheckupItem) => {
    const action = item.fix;
    if (!action) return "";
    switch (action.kind) {
      case "installPackage":
        return t("scoop.diagnostics.fix.install", { package: action.package });
      case "installBucket":
        return t("scoop.diagnostics.fix.bucket", { name: action.name });
      default:
        return t("scoop.diagnostics.fix.settings");
    }
  };

  /**
   * The outdated downloads, deleted by the page: `scoop cache rm *` would take
   * every file with it, including the ones an app installed from several
   * versions still needs.
   */
  const clearOutdated = async () => {
    setClearing(true);
    try {
      setCleared(await scoopCacheClear(null, true));
      setError(null);
      setCacheKey((key) => key + 1);
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setClearing(false);
    }
  };

  const failed = items?.filter((item) => !item.ok).length ?? 0;

  return (
    <div className="space-y-4">
      <section className="border-border rounded-xl border">
        <header className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2">
          <div>
            <h2 className="text-sm font-semibold">{t("scoop.diagnostics.checkupTitle")}</h2>
            <p className="text-muted-foreground mt-0.5 text-xs">
              {items
                ? failed === 0
                  ? t("scoop.diagnostics.checkupOk")
                  : t("scoop.diagnostics.checkupFailed", { count: failed })
                : t("scoop.diagnostics.checkupHint")}
            </p>
          </div>
          <Button variant="outline" size="sm" disabled={loading} onClick={() => void check()}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            {t("scoop.diagnostics.rerun")}
          </Button>
        </header>

        {error && <p className="text-destructive px-4 py-2 text-xs">{error}</p>}

        {loading && !items ? (
          <div className="space-y-2 px-4 py-3">
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-6 w-full rounded-md" />
            ))}
          </div>
        ) : (
          <ul className="divide-border divide-y">
            {(items ?? []).map((item) => (
              <li
                key={`${item.id}-${item.value ?? ""}`}
                className="flex items-start gap-2 px-4 py-2"
              >
                {item.ok ? (
                  <Check className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400" />
                ) : (
                  <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
                )}
                <div className="min-w-0 flex-1">
                  <p className="text-sm">
                    {t(`scoop.diagnostics.check.${item.id}`, { value: item.value ?? "" })}
                  </p>
                  {!item.ok && (
                    <p className="text-muted-foreground mt-0.5 text-xs">
                      {t(`scoop.diagnostics.check.${item.id}Hint`)}
                    </p>
                  )}
                </div>
                {item.fix && (
                  <Button variant="outline" size="xs" disabled={busy} onClick={() => fix(item)}>
                    {fixLabel(item)}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="border-border flex flex-col gap-3 rounded-xl border p-4">
          <div>
            <h2 className="text-sm font-semibold">{t("scoop.diagnostics.cleanup.title")}</h2>
            <p className="text-muted-foreground mt-1 text-xs">
              {t("scoop.diagnostics.cleanup.hint")}
            </p>
          </div>

          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-sm">{t("scoop.diagnostics.cleanup.versions")}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("scoop.diagnostics.cleanup.versionsHint")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void page.cleanupApps()}
            >
              <Trash2 />
              {t("scoop.diagnostics.cleanup.run")}
            </Button>
          </div>

          <div className="border-border flex items-start justify-between gap-3 border-t pt-3">
            <div className="min-w-0">
              <p className="text-sm">{t("scoop.diagnostics.cleanup.cache")}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("scoop.diagnostics.cleanup.cacheHint")}
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              disabled={clearing}
              onClick={() => void clearOutdated()}
            >
              {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("scoop.diagnostics.cleanup.run")}
            </Button>
          </div>

          {cleared && (
            <p className="text-muted-foreground text-xs">
              {t("scoop.diagnostics.cleanup.cleared", {
                count: cleared.deleted,
                size: formatBytes(cleared.freed),
              })}
              {cleared.skipped > 0 &&
                ` ${t("scoop.diagnostics.cleanup.skipped", { count: cleared.skipped })}`}
            </p>
          )}
        </section>

        <ScoopCacheManager reloadKey={cacheKey} />
      </div>

      <ScoopShimManager />
    </div>
  );
}
