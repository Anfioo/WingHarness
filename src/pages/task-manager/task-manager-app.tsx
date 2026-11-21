import { RefreshCw, Settings } from "lucide-react";
import { argusErrorKey } from "@/commands";
import { ServiceBadge } from "@/components/task-manager/service-badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager, type TaskManagerTab } from "@/hooks/use-task-manager";
import { openSettingsSection } from "@/lib/window";
import { cn } from "@/lib/utils";
import { ConnectionsTab } from "./tabs/connections";
import { HistoryTab } from "./tabs/history";
import { PerformanceTab } from "./tabs/performance";
import { ProcessesTab } from "./tabs/processes";
import { ServicesTab } from "./tabs/services";
import { StartupTab } from "./tabs/startup";

const TABS: TaskManagerTab[] = [
  "processes",
  "performance",
  "services",
  "startup",
  "connections",
  "history",
];

/**
 * The shared task manager surface: the tab row with the service badge and the
 * settings entry, and the six panels. Every panel stays mounted so a tab
 * switch keeps its state.
 */
export function TaskManagerApp() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const openTaskManagerSettings = () => {
    void openSettingsSection("taskManager");
  };

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-1.5">
        <nav className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
          {TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => page.setActiveTab(tab)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                page.activeTab === tab
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(`taskManager.tabs.${tab}`)}
            </button>
          ))}
        </nav>
        <div className="flex flex-wrap items-center gap-2">
          <ServiceBadge service={page.service} onClick={openTaskManagerSettings} />
          <Button variant="outline" size="sm" onClick={() => void page.refresh()}>
            <RefreshCw className="size-4" />
            {t("taskManager.actions.refresh")}
          </Button>
          <Button variant="outline" size="sm" onClick={openTaskManagerSettings}>
            <Settings className="size-4" />
            {t("taskManager.actions.settings")}
          </Button>
        </div>
      </div>

      {page.error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t(argusErrorKey(page.error.code))}
        </div>
      )}

      <div className="min-h-0 flex-1">
        <div hidden={page.activeTab !== "processes"} className="h-full">
          <ProcessesTab />
        </div>
        <div hidden={page.activeTab !== "performance"} className="h-full">
          <PerformanceTab />
        </div>
        <div hidden={page.activeTab !== "services"} className="h-full">
          <ServicesTab active={page.activeTab === "services"} />
        </div>
        <div hidden={page.activeTab !== "startup"} className="h-full">
          <StartupTab />
        </div>
        <div hidden={page.activeTab !== "connections"} className="h-full">
          <ConnectionsTab />
        </div>
        <div hidden={page.activeTab !== "history"} className="h-full">
          <HistoryTab />
        </div>
      </div>
    </div>
  );
}
