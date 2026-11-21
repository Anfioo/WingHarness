// Baseline shell for the startup tab; the table and its actions land with the
// startup UI port.

import { useAppTranslation } from "@/hooks/use-app-translation";

export function StartupTab() {
  const { t } = useAppTranslation();

  return (
    <div className="border-border bg-card flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <h2 className="text-sm font-medium">{t("taskManager.startup.title")}</h2>
      <p className="text-muted-foreground max-w-md text-xs">
        {t("taskManager.startup.empty.body")}
      </p>
    </div>
  );
}
