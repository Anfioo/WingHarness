import { useEffect, useState } from "react";
import { AppShell } from "@/components/app-shell";
import { ScoopBucketsPanel } from "@/components/scoop/buckets-panel";
import { ScoopInstallPanel } from "@/components/scoop/install-panel";
import { ScoopOverviewPanel } from "@/components/scoop/overview-panel";
import { ScoopRunDock } from "@/components/scoop/run-dock";
import { ScoopSearchPanel } from "@/components/scoop/search-panel";
import { ScoopSettingsPanel } from "@/components/scoop/settings-panel";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useScoopPage } from "@/hooks/use-scoop-page";

/**
 * The page's own shape, drawn while the status is read: the tab row, then the
 * three counters, the folded paths line and the apps card of the overview.
 */
function ScoopLoadingScreen() {
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex shrink-0 items-center gap-1">
        {[0, 1, 2, 3].map((tab) => (
          <Skeleton key={tab} className="h-8 w-24 rounded-md" />
        ))}
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-hidden">
        <div className="grid gap-3 sm:grid-cols-3">
          {[0, 1, 2].map((card) => (
            <div key={card} className="border-border space-y-2 rounded-xl border p-4">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-5 w-24" />
            </div>
          ))}
        </div>

        <div className="border-border flex items-center justify-between gap-2 rounded-xl border px-4 py-2">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-6 w-16" />
        </div>

        <div className="border-border space-y-3 rounded-xl border p-4">
          <Skeleton className="h-4 w-32" />
          {[0, 1, 2].map((row) => (
            <Skeleton key={row} className="h-9 w-full rounded-md" />
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Scoop, in two states: the install screen until there is an install on disk,
 * then the version/overview with search, buckets and settings tabs.
 */
export default function ScoopPage() {
  const { t } = useAppTranslation();
  const page = useScoopPage();
  // The install folder says "installed" long before the catalog is read, so the
  // badge and the loading screen never claim "not installed" about an install
  // that is there. `status` overrules it as soon as it arrives.
  const installed = page.status?.installed ?? page.quickInstalled ?? false;
  const [tab, setTab] = useState("overview");

  // The install tab only exists while there is nothing installed; the tab list
  // and this effect keep the selected value legal when that state flips.
  useEffect(() => {
    if (!page.status) return;
    if (page.status.installed && tab === "install") setTab("overview");
    if (!page.status.installed && tab !== "install") setTab("install");
  }, [page.status, tab]);

  return (
    <AppShell>
      <div className="flex h-full min-h-0 w-full flex-col gap-3">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{t("scoop.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("scoop.subtitle")}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={installed ? "default" : "secondary"}>
              {installed ? t("scoop.status.installed") : t("scoop.status.missing")}
            </Badge>
            {installed && page.status?.version && (
              <Badge variant="outline" className="font-mono">
                {page.status.version}
              </Badge>
            )}
          </div>
        </header>

        {page.statusError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
          >
            {t("scoop.error.status")} {page.statusError}
          </div>
        )}

        {page.restartNeeded && (
          <div className="border-border bg-muted/40 flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2 text-sm">
            <span className="min-w-48 flex-1">{t("scoop.restart.message")}</span>
            <Button size="sm" onClick={page.relaunchApp}>
              {t("scoop.restart.button")}
            </Button>
          </div>
        )}

        {page.loading && !page.status ? (
          <ScoopLoadingScreen />
        ) : !installed ? (
          <div className="min-h-0 flex-1 overflow-auto">
            <ScoopInstallPanel page={page} />
          </div>
        ) : (
          <Tabs value={tab} onValueChange={setTab} className="min-h-0 flex-1 gap-2">
            <TabsList className="shrink-0">
              <TabsTrigger value="overview">{t("scoop.tabs.overview")}</TabsTrigger>
              <TabsTrigger value="search">{t("scoop.tabs.search")}</TabsTrigger>
              <TabsTrigger value="buckets">{t("scoop.tabs.buckets")}</TabsTrigger>
              <TabsTrigger value="settings">{t("scoop.tabs.settings")}</TabsTrigger>
            </TabsList>

            <TabsContent value="overview" className="min-h-0 flex-1 overflow-auto">
              <ScoopOverviewPanel page={page} />
            </TabsContent>
            <TabsContent value="search" className="min-h-0 flex-1 overflow-auto">
              <ScoopSearchPanel page={page} />
            </TabsContent>
            <TabsContent value="buckets" className="min-h-0 flex-1 overflow-auto">
              <ScoopBucketsPanel page={page} />
            </TabsContent>
            <TabsContent value="settings" className="min-h-0 flex-1 overflow-auto">
              <ScoopSettingsPanel page={page} />
            </TabsContent>
          </Tabs>
        )}

        <ScoopRunDock page={page} />
      </div>
    </AppShell>
  );
}
