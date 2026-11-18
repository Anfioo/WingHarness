import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * A0 placeholder for the performance tab. F2 replaces this file with the
 * summary cards and the CPU, memory, disk, network and GPU charts.
 */
export function PerformanceTab() {
  const { t } = useAppTranslation();

  return (
    <section className="flex h-full min-h-0 flex-col items-center justify-center gap-1 rounded-lg border border-dashed p-8 text-center">
      <h2 className="text-sm font-medium">{t("taskManager.tabs.performance")}</h2>
      <p className="text-muted-foreground text-sm">{t("taskManager.empty.performance")}</p>
    </section>
  );
}
