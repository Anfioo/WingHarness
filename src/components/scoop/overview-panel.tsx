import { useMemo, useState } from "react";
import { ChevronRight, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";
import type { ScoopApp } from "@/commands/services/scoop/types";
import { samePath } from "@/lib/scoop/page";
import { cn } from "@/lib/utils";
import { InfoRow } from "./info-row";
import { ScoopPathRows } from "./path-rows";

/** Version, paths, environment, proxy and the installed apps. */
export function ScoopOverviewPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const status = page.status;
  const [filter, setFilter] = useState("");
  // `null` follows the install: the paths card stays folded while the variables
  // point at the fixed links, and opens itself as soon as one does not.
  const [pathsOpen, setPathsOpen] = useState<boolean | null>(null);
  const busy = page.running !== null || page.preparing;

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
  const pathsReady =
    status.envScoop !== null &&
    samePath(status.envScoop, status.root) &&
    status.envScoopGlobal !== null &&
    samePath(status.envScoopGlobal, status.globalRoot);
  const pathsExpanded = pathsOpen ?? !pathsReady;

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

      {/* Folded to one line while the folders, the links and the variables are
          in place: the apps are what the page is opened for. It opens itself
          when a variable no longer points at its fixed link. */}
      <Collapsible
        open={pathsExpanded}
        onOpenChange={setPathsOpen}
        className="border-border rounded-xl border"
      >
        <header className="flex items-center justify-between gap-2 px-4 py-1.5">
          <CollapsibleTrigger asChild>
            <button
              type="button"
              title={pathsExpanded ? t("scoop.overview.pathsHide") : t("scoop.overview.pathsShow")}
              className="hover:bg-muted -ml-2 flex items-center gap-2 rounded-md px-2 py-1 text-sm font-semibold"
            >
              <ChevronRight
                className={cn(
                  "text-muted-foreground size-4 transition-transform",
                  pathsExpanded && "rotate-90"
                )}
              />
              {t("scoop.overview.pathsTitle")}
              {pathsReady && (
                <Badge variant="secondary" className="text-[10px]">
                  {t("scoop.overview.pathsReady")}
                </Badge>
              )}
            </button>
          </CollapsibleTrigger>
          <Button variant="ghost" size="sm" onClick={() => void page.refresh()}>
            {t("scoop.overview.refresh")}
          </Button>
        </header>
        <CollapsibleContent className="border-border space-y-2 border-t px-4 py-3">
          <ScoopPathRows status={status} />
          <InfoRow label={t("scoop.overview.dataDir")} value={status.dataDir} />
          <InfoRow label={t("scoop.overview.proxy")} value={proxyText} />
        </CollapsibleContent>
      </Collapsible>

      <section className="border-border space-y-3 rounded-xl border p-4">
        <header className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold">{t("scoop.overview.installedTitle")}</h2>
          <div className="flex items-center gap-2">
            <Input
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder={t("scoop.overview.filterPlaceholder")}
              className="h-8 w-56 text-xs"
            />
            <Button
              variant="outline"
              size="sm"
              disabled={busy || status.apps.length === 0}
              title={t("scoop.overview.updateAllTitle")}
              onClick={() => void page.updateApps()}
            >
              {t("scoop.overview.updateAll")}
            </Button>
          </div>
        </header>

        {apps.length === 0 ? (
          <p className="text-muted-foreground text-xs">
            {status.apps.length === 0 ? t("scoop.overview.noApps") : t("scoop.overview.noMatches")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {apps.map((app) => (
              <li
                key={`${app.global ? "g" : "u"}-${app.name}`}
                className="flex items-start gap-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => page.openPackageDetail(app.name, app.bucket, app.global)}
                  title={t("scoop.overview.openDetail", { app: app.name })}
                  className="hover:bg-muted/60 focus-visible:ring-ring min-w-0 flex-1 rounded-md text-start focus-visible:ring-2 focus-visible:outline-none"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{app.name}</span>
                    {app.version && (
                      <span className="text-muted-foreground font-mono text-xs">{app.version}</span>
                    )}
                    {app.hold && (
                      <Badge variant="secondary" className="text-[10px]">
                        {t("scoop.overview.heldBadge")}
                      </Badge>
                    )}
                    {app.plugin && (
                      <Badge variant="outline" className="text-[10px]">
                        {t("scoop.overview.pluginBadge")}
                      </Badge>
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
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy || app.hold}
                    title={
                      app.hold
                        ? t("scoop.overview.updateHeldTitle", { app: app.name })
                        : t("scoop.overview.updateTitle", { app: app.name })
                    }
                    onClick={() => void page.updateApp(app)}
                  >
                    {t("scoop.overview.update")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    title={
                      app.hold
                        ? t("scoop.overview.unpinTitle", { app: app.name })
                        : t("scoop.overview.pinTitle", { app: app.name })
                    }
                    onClick={() => void page.setAppHold(app, !app.hold)}
                  >
                    {app.hold ? t("scoop.overview.unpin") : t("scoop.overview.pin")}
                  </Button>
                  {/* Scoop lists itself as an app, and uninstalling it would
                      take every other app with it. The backend refuses the
                      name; the row simply offers no button for it. */}
                  {app.name.toLowerCase() !== "scoop" && (
                    <UninstallButton page={page} app={app} disabled={busy} />
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

/**
 * `scoop uninstall [-p] <app>`. The confirmation asks whether the app's
 * `persist` folder goes too, because Scoop keeps it by default and that is the
 * data a reinstall would otherwise pick up again.
 */
function UninstallButton({
  page,
  app,
  disabled,
}: {
  page: ScoopPageController;
  app: ScoopApp;
  disabled: boolean;
}) {
  const { t } = useAppTranslation();
  const [purge, setPurge] = useState(false);

  return (
    <AlertDialog
      onOpenChange={(open) => {
        if (!open) setPurge(false);
      }}
    >
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={disabled}
          title={t("scoop.overview.uninstallTitle", { app: app.name })}
          aria-label={t("scoop.overview.uninstallTitle", { app: app.name })}
          className="hover:bg-destructive/10 hover:text-destructive"
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("scoop.overview.uninstallDialogTitle", { app: app.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("scoop.overview.uninstallDialogBody", { app: app.name })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="flex items-center gap-2">
          <Switch
            id={`scoop-uninstall-purge-${app.global ? "g" : "u"}-${app.name}`}
            checked={purge}
            onCheckedChange={setPurge}
          />
          <Label
            htmlFor={`scoop-uninstall-purge-${app.global ? "g" : "u"}-${app.name}`}
            className="text-xs font-normal"
          >
            {t("scoop.overview.uninstallPurge")}
          </Label>
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("scoop.overview.uninstallCancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive hover:bg-destructive/90 text-white"
            onClick={() => void page.uninstallApp(app, purge)}
          >
            {t("scoop.overview.uninstallConfirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
