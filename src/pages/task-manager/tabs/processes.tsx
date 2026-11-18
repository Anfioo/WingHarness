import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * A0 placeholder for the processes tab. F1 replaces this file with the three
 * views, the table, the detail panel and the context menu.
 */
export function ProcessesTab() {
  const { t } = useAppTranslation();

  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center">
      <h2 className="text-sm font-medium">{t("taskManager.tabs.processes")}</h2>
      <p className="text-muted-foreground text-sm">{t("taskManager.empty.processes")}</p>
    </section>
  );
}
