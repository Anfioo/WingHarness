// Baseline shell for the connections tab; the endpoint table lands with the
// connections UI port.

import { useAppTranslation } from "@/hooks/use-app-translation";

export function ConnectionsTab() {
  const { t } = useAppTranslation();

  return (
    <div className="border-border bg-card flex h-full min-h-0 flex-col items-center justify-center gap-2 rounded-xl border px-6 py-12 text-center">
      <h2 className="text-sm font-medium">{t("taskManager.connections.title")}</h2>
      <p className="text-muted-foreground max-w-md text-xs">
        {t("taskManager.connections.empty.body")}
      </p>
    </div>
  );
}
