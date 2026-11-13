import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import { InfoRow } from "./info-row";
import { ScoopPathRows } from "./path-rows";

/** Version, paths, environment, proxy and the installed apps. */
export function ScoopOverviewPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const status = page.status;
  const [filter, setFilter] = useState("");

  const apps = useMemo(() => {
    if (!status) return [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return status.apps;
    return status.apps.filter(
      (app) =>
        app.name.toLowerCase().includes(needle) || (app.bucket ?? "").toLowerCase().includes(needle)
    );
  }, [filter, status]);

  if (!status) return null;

  const proxyText = status.proxy.url ?? t("scoop.proxy.system");

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <section className="border-border rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t("scoop.overview.version")}</p>
          <p className="mt-1 text-lg font-semibold">
            {status.version ?? t("scoop.overview.unknownVersion")}
          </p>
        </section>
        <section className="border-border rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t("scoop.overview.apps")}</p>
          <p className="mt-1 text-lg font-semibold">{status.apps.length}</p>
        </section>
        <section className="border-border rounded-xl border p-4">
          <p className="text-muted-foreground text-xs">{t("scoop.overview.buckets")}</p>
          <p className="mt-1 text-lg font-semibold">{status.buckets.length}</p>
        </section>
      </div>

      <section className="border-border space-y-2 rounded-xl border p-4">
        <header className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("scoop.overview.pathsTitle")}</h2>
          <Button variant="ghost" size="sm" onClick={() => void page.refresh()}>
            {t("scoop.overview.refresh")}
          </Button>
        </header>
        <ScoopPathRows status={status} />
        <InfoRow label={t("scoop.overview.dataDir")} value={status.dataDir} />
        <InfoRow label={t("scoop.overview.proxy")} value={proxyText} />
      </section>

      <section className="border-border space-y-3 rounded-xl border p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("scoop.overview.installedTitle")}</h2>
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder={t("scoop.overview.filterPlaceholder")}
            className="h-8 w-56 text-xs"
          />
        </header>

        {apps.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {status.apps.length === 0 ? t("scoop.overview.noApps") : t("scoop.overview.noMatches")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {apps.map((app) => (
              <li key={app.name} className="flex items-start gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{app.name}</span>
                    {app.version && (
                      <span className="text-muted-foreground font-mono text-xs">{app.version}</span>
                    )}
                    {app.bucket && (
                      <Badge variant="secondary" className="text-[10px]">
                        {app.bucket}
                      </Badge>
                    )}
                    {app.global && (
                      <Badge variant="outline" className="text-[10px]">
                        {t("scoop.overview.globalBadge")}
                      </Badge>
                    )}
                  </div>
                  {app.description && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                      {app.description}
                    </p>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
