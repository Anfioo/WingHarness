import { Boxes } from "lucide-react";
import type { TrayApp } from "@/commands";
import { TrayAppRow } from "@/components/tray-apps/app-row";
import type { CuratedApps } from "@/hooks/use-tray-apps-page";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The second-level menu as the tray draws it, so the settings page shows the
 * result of a pin or a hide instead of describing it. Rows open the app here
 * too — a quick check that the entry still launches.
 */
export function TrayMenuPreview({
  curated,
  onLaunch,
}: {
  curated: CuratedApps;
  onLaunch: (app: TrayApp) => void;
}) {
  const { t } = useAppTranslation();
  const shown = curated.pinned.length + curated.rest.length;

  return (
    <div className="bg-popover text-popover-foreground border-border flex h-full min-h-0 flex-col overflow-hidden rounded-md border select-none">
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Boxes className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{t("tray.apps")}</span>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {t("tray.appsCount", { count: shown })}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {shown === 0 ? (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-xs">{t("tray.appsPanel.empty")}</p>
            <p className="text-muted-foreground/70 text-[11px] leading-relaxed">
              {t("tray.appsPanel.emptyHint")}
            </p>
          </div>
        ) : (
          <>
            {curated.pinned.map((app) => (
              <TrayAppRow key={app.id} app={app} pinned onSelect={() => onLaunch(app)} />
            ))}
            {curated.pinned.length > 0 && curated.rest.length > 0 && (
              <div className="bg-border my-1 h-px" />
            )}
            {curated.rest.map((app) => (
              <TrayAppRow key={app.id} app={app} onSelect={() => onLaunch(app)} />
            ))}
          </>
        )}
      </div>
    </div>
  );
}
