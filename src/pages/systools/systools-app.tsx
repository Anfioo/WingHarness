import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { isSystoolsTab, SYSTOOLS_TABS, type SystoolsTab } from "@/lib/systools-routes";
import { openSystoolsWindow, SYSTOOLS_TAB_EVENT } from "@/lib/systools-windows";
import { cn } from "@/lib/utils";
import { AnalysisTab } from "./tabs/analysis";
import { DuplicatesTab } from "./tabs/duplicates";
import { LargeFilesTab } from "./tabs/large-files";
import { OptimizeTab } from "./tabs/optimize";
import { StartupTab } from "./tabs/startup";
import { UninstallTab } from "./tabs/uninstall";

type SystoolsAppProps = {
  initialTab?: SystoolsTab;
  /** Set by the standalone window; the main window leaves it unset. */
  inWindow?: boolean;
};

/** The shared six-tab systools surface, used by the page and the window. */
export function SystoolsApp({ initialTab = "startup", inWindow }: SystoolsAppProps) {
  const { t } = useAppTranslation();
  const [activeTab, setActiveTab] = useState<SystoolsTab>(initialTab);
  const [standalone] = useState(() => inWindow ?? getCurrentWebviewWindow().label === "systools");

  // Keep the active tab in the URL so a standalone window can be opened on it.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", activeTab);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, [activeTab]);

  // An already-open window is switched to the requested tab instead of being
  // replaced by a second window; only that window listens for the event.
  useEffect(() => {
    if (!standalone) return;
    const unlisten = listen<SystoolsTab>(SYSTOOLS_TAB_EVENT, (event) => {
      if (isSystoolsTab(event.payload)) setActiveTab(event.payload);
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [standalone]);

  return (
    <div className="flex h-full min-h-0 w-full flex-1 flex-col">
      <header className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-2">
        <h1 className="text-sm font-medium">{t("systools.common.title")}</h1>
        {!standalone && (
          <Button variant="outline" size="sm" onClick={() => void openSystoolsWindow(activeTab)}>
            <ExternalLink className="size-4" />
            {t("systools.common.openInNewWindow")}
          </Button>
        )}
      </header>

      <div className="flex shrink-0 border-b px-3 py-1.5">
        <nav className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
          {SYSTOOLS_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => setActiveTab(tab)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`systools.tabs.${tab}`)}
            </button>
          ))}
        </nav>
      </div>

      {/* Every panel stays mounted so a scan's state survives a tab switch. */}
      <div className="min-h-0 flex-1">
        <div hidden={activeTab !== "startup"} className="h-full">
          <StartupTab />
        </div>
        <div hidden={activeTab !== "uninstall"} className="h-full">
          <UninstallTab />
        </div>
        <div hidden={activeTab !== "optimize"} className="h-full">
          <OptimizeTab />
        </div>
        <div hidden={activeTab !== "analysis"} className="h-full">
          <AnalysisTab />
        </div>
        <div hidden={activeTab !== "duplicates"} className="h-full">
          <DuplicatesTab />
        </div>
        <div hidden={activeTab !== "largeFiles"} className="h-full">
          <LargeFilesTab />
        </div>
      </div>
    </div>
  );
}
