// The tray's apps flyout: the second-level menu that launches Scoop's apps.
//
// The list is the Start Menu shortcuts Scoop wrote, minus the ones the user hid,
// with the pinned ones on top. Clicking a row opens the shortcut through the
// shell, so the app starts exactly as it would from its own Start Menu entry.
// The footer row is the way into the settings page that curates the list.

import { Boxes, Settings2 } from "lucide-react";
import type { TrayApp, TrayAppsView } from "@/commands";
import { TrayAppRow } from "@/components/tray-apps/app-row";
import { useAppTranslation } from "@/hooks/use-app-translation";

export type AppsPanelProps = {
  /** `null` until the first read lands. */
  view: TrayAppsView | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  onLaunch: (app: TrayApp) => void;
  onEdit: () => void;
};

export function AppsPanel({ view, onMouseEnter, onMouseLeave, onLaunch, onEdit }: AppsPanelProps) {
  const { t } = useAppTranslation();

  const hidden = new Set(view?.hidden ?? []);
  const pinned = new Set(view?.pinned ?? []);
  const shown = (view?.apps ?? []).filter((app) => !hidden.has(app.id));
  const pinnedApps = shown.filter((app) => pinned.has(app.id));
  const otherApps = shown.filter((app) => !pinned.has(app.id));

  return (
    <section
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      className="bg-popover text-popover-foreground border-border flex h-[460px] w-[340px] shrink-0 flex-col overflow-hidden rounded-md border select-none"
    >
      <header className="flex h-9 shrink-0 items-center gap-2 border-b px-3">
        <Boxes className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">{t("tray.apps")}</span>
        <span className="text-muted-foreground ml-auto text-[11px]">
          {t("tray.appsCount", { count: shown.length })}
        </span>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {view === null ? (
          <Hint text={t("tray.appsPanel.loading")} />
        ) : shown.length === 0 ? (
          <Hint text={t("tray.appsPanel.empty")} detail={t("tray.appsPanel.emptyHint")} />
        ) : (
          <>
            {pinnedApps.map((app) => (
              <TrayAppRow key={app.id} app={app} pinned onSelect={() => onLaunch(app)} />
            ))}
            {pinnedApps.length > 0 && otherApps.length > 0 && (
              <div className="bg-border my-1 h-px" />
            )}
            {otherApps.map((app) => (
              <TrayAppRow key={app.id} app={app} onSelect={() => onLaunch(app)} />
            ))}
          </>
        )}
      </div>

      <footer className="border-border shrink-0 border-t p-1">
        <button
          type="button"
          onClick={onEdit}
          className="hover:bg-accent hover:text-accent-foreground flex h-8 w-full items-center gap-2 rounded-sm px-2 text-sm"
        >
          <Settings2 className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate">{t("tray.appsPanel.edit")}</span>
        </button>
      </footer>
    </section>
  );
}

function Hint({ text, detail }: { text: string; detail?: string }) {
  return (
    <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
      <p className="text-xs">{text}</p>
      {detail && <p className="text-muted-foreground/70 text-[11px] leading-relaxed">{detail}</p>}
    </div>
  );
}
