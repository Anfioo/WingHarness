// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

import { useState } from "react";
import { Download, FolderDown, RefreshCw, Settings2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMoinTasks } from "@/hooks/use-moin-tasks";
import CategoriesTab from "./categories-tab";
import DownloadsTab from "./downloads-tab";
import SettingsTab from "./settings-tab";

type MoinTab = "downloads" | "categories" | "settings";

const TABS: { value: MoinTab; labelKey: string; Icon: typeof Download }[] = [
  { value: "downloads", labelKey: "moin.tab.downloads", Icon: Download },
  { value: "categories", labelKey: "moin.tab.categories", Icon: FolderDown },
  { value: "settings", labelKey: "moin.tab.settings", Icon: Settings2 },
];

/**
 * Page shell: header, first-level tabs and the shared download snapshot.
 *
 * The download events are subscribed here (through `useMoinTasks`) rather than
 * in the tab, so switching tabs never drops a task update and the header can
 * show the queue state. `AppShell` is already applied by `RoutedApp` for this
 * route, so the page must not wrap itself in another one.
 */
export default function MoinPage() {
  const { t } = useAppTranslation();
  const [tab, setTab] = useState<MoinTab>("downloads");
  const downloads = useMoinTasks();

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-semibold">{t("moin.title")}</h1>
          <p className="text-muted-foreground text-sm">{t("moin.subtitle")}</p>
        </div>
        {tab === "downloads" && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={downloads.loading}
            onClick={() => void downloads.reload()}
          >
            <RefreshCw className={downloads.loading ? "animate-spin" : ""} />
            {downloads.loading ? t("moin.common.refreshing") : t("moin.common.refresh")}
          </Button>
        )}
      </header>

      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value as MoinTab)}
        className="min-h-0 flex-1"
      >
        <TabsList>
          {TABS.map(({ value, labelKey, Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon />
              {t(labelKey)}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="downloads" className="mt-4">
          <DownloadsTab
            tasks={downloads.tasks}
            progress={downloads.progress}
            loading={downloads.loading}
            error={downloads.error}
            reload={downloads.reload}
          />
        </TabsContent>
        <TabsContent value="categories" className="mt-4">
          <CategoriesTab />
        </TabsContent>
        <TabsContent value="settings" className="mt-4">
          <SettingsTab />
        </TabsContent>
      </Tabs>
    </div>
  );
}
