// Baseline shell for the history tab; the charts and the time cursor land with
// the history UI port.

import { useAppTranslation } from "@/hooks/use-app-translation";

export function HistoryTab() {
  const { t } = useAppTranslation();

  return (
    <div className="border-border bg-card flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <h2 className="text-sm font-medium">{t("taskManager.history.title")}</h2>
      <p className="text-muted-foreground max-w-md text-xs">
        {t("taskManager.history.empty.body")}
      </p>
    </div>
  );
}
