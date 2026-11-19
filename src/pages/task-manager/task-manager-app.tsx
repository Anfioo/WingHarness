import { useState } from "react";
import { RefreshCw, Settings } from "lucide-react";
import { argusErrorKey } from "@/commands";
import { ServicePanel } from "@/components/task-manager/service-panel";
import { ServiceBadge } from "@/components/task-manager/service-badge";
import { TaskManagerSettings } from "@/components/task-manager/task-manager-settings";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useTaskManager, type TaskManagerTab } from "@/hooks/use-task-manager";
import { cn } from "@/lib/utils";
import { PerformanceTab } from "./tabs/performance";
import { ProcessesTab } from "./tabs/processes";
import { ServicesTab } from "./tabs/services";

const TABS: TaskManagerTab[] = ["processes", "performance", "services"];

/**
 * The shared task manager surface: the header with the service badge and the
 * settings entry, the three tabs and their panels. Every panel stays mounted
 * so a tab switch keeps its state.
 */
export function TaskManagerApp() {
  const { t } = useAppTranslation();
  const page = useTaskManager();
  const [settingsOpen, setSettingsOpen] = useState(false);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("taskManager.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("taskManager.subtitle")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ServiceBadge service={page.service} />
          <Button variant="outline" size="sm" onClick={() => void page.refresh()}>
            <RefreshCw className="size-4" />
            {t("taskManager.actions.refresh")}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setSettingsOpen(true)}>
            <Settings className="size-4" />
            {t("taskManager.actions.settings")}
          </Button>
        </div>
      </header>

      {page.error && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive rounded-lg border px-3 py-2 text-sm"
        >
          {t(argusErrorKey(page.error.code))}
        </div>
      )}

      <ServicePanel service={page.service} />

      <div className="flex shrink-0 border-b px-3 py-1.5">
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
      </div>

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
      </div>

      <TaskManagerSettings open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
