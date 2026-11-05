import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";

/**
 * Which agents the AI config sync page manages.
 *
 * A switched-off agent is not listed there and is never written to. `null` in
 * the config means "every agent" (the default for a config that has never been
 * touched), which is why the checked state is derived from the roster rather
 * than read off the stored list directly.
 */
export function AiConfigSection() {
  const { t } = useAppTranslation();
  const { view, draft, setDraft, loading } = useConfigDraft("ai config");

  const agents = view?.aiAgents ?? [];
  const enabled = new Set(draft?.aiConfig.enabledAgents ?? agents.map((agent) => agent.id));

  const toggle = (id: string, on: boolean) => {
    setDraft((current) => {
      if (!current) return current;
      const all = agents.map((agent) => agent.id);
      const checked = current.aiConfig.enabledAgents ?? all;
      const next = on ? [...checked, id] : checked.filter((entry) => entry !== id);
      // Stored in roster order so the saved list is stable and reviewable.
      return {
        ...current,
        aiConfig: { enabledAgents: all.filter((agentId) => next.includes(agentId)) },
      };
    });
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("settings.aiConfig.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("settings.aiConfig.description")}</p>
      </div>

      {loading && !draft ? (
        <Skeleton className="h-72 rounded-xl" />
      ) : draft && view ? (
        <div className="space-y-4">
          <div className="border-border rounded-xl border">
            <div className="border-border border-b px-4 py-3">
              <p className="text-sm font-medium">{t("settings.aiConfig.agentsLabel")}</p>
              <p className="text-muted-foreground mt-0.5 text-xs">
                {t("settings.aiConfig.agentsHint")}
              </p>
            </div>
            <div className="divide-border flex flex-col divide-y">
              {agents.map((agent) => (
                <div
                  key={agent.id}
                  className="hover:bg-accent/40 flex items-center gap-3 px-4 py-2.5"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium">{agent.name}</p>
                    <p className="text-muted-foreground font-mono text-xs">{agent.id}</p>
                  </div>
                  <Switch
                    checked={enabled.has(agent.id)}
                    onCheckedChange={(on) => toggle(agent.id, on)}
                    aria-label={agent.name}
                  />
                </div>
              ))}
            </div>
          </div>

          {enabled.size === 0 && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              {t("settings.aiConfig.noneEnabled")}
            </p>
          )}

          <div className="border-border border-t pt-4">
            <p className="text-muted-foreground text-xs">{t("settings.aiConfig.autoSave")}</p>
            <p className="text-muted-foreground mt-1 truncate font-mono text-xs" title={view.path}>
              {t("config.path", { path: view.path })}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("settings.aiConfig.loadFailed")}</p>
      )}
    </div>
  );
}
