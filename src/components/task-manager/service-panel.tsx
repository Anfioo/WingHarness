import { Badge } from "@/components/ui/badge";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ServiceStatus } from "@/commands";

/**
 * The i18n key for a service state. The backend reports these four states;
 * anything newer falls back to a neutral label until this file knows it.
 */
export function serviceStateKey(state: string): string {
  return ["notInstalled", "stopped", "running", "unavailable"].includes(state)
    ? `taskManager.service.state.${state}`
    : "taskManager.service.state.unknown";
}

/**
 * A0 placeholder for the privileged-service panel. F3 replaces it with the
 * install/uninstall surface; the page already renders it so the service state
 * is visible from day one.
 */
export function ServicePanel({ service }: { service: ServiceStatus | null }) {
  const { t } = useAppTranslation();
  const state = service?.state ?? "notInstalled";

  return (
    <section className="rounded-lg border px-3 py-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="font-medium">{t("taskManager.service.label")}</span>
        <Badge variant="outline">{t(serviceStateKey(state))}</Badge>
      </div>
      <p className="text-muted-foreground mt-1 text-xs">{t("taskManager.empty.service")}</p>
    </section>
  );
}
