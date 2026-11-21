// Baseline shell for the task manager settings section; the interval,
// background, history and service controls land with the settings port.

import { useAppTranslation } from "@/hooks/use-app-translation";

export function TaskManagerSection() {
  const { t } = useAppTranslation();

  return (
    <section className="space-y-4">
      <div className="space-y-1">
        <h2 className="text-lg font-medium">{t("taskManager.settings.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("taskManager.settings.description")}</p>
      </div>
    </section>
  );
}
