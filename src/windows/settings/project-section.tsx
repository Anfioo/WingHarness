import { type WorkspaceConfig } from "@/commands";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useConfigDraft } from "@/hooks/use-config-draft";

/**
 * The project the file browser and the preview open at.
 *
 * Kept as its own settings section rather than folded into another one: it is
 * project data, not environment setup, and the two change for different
 * reasons.
 */
export function ProjectSection() {
  const { t } = useAppTranslation();

  const { view, draft, setDraft, loading } = useConfigDraft("project config");

  const update = (field: keyof WorkspaceConfig, value: string) => {
    setDraft((current) =>
      current ? { ...current, workspace: { ...current.workspace, [field]: value } } : current
    );
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-semibold">{t("project.title")}</h2>
        <p className="text-muted-foreground text-sm">{t("project.description")}</p>
      </div>

      {loading && !draft ? (
        <Skeleton className="h-32 rounded-xl" />
      ) : draft && view ? (
        <div className="space-y-6">
          <div className="space-y-2">
            <label htmlFor="project-root" className="text-sm font-medium">
              {t("project.rootLabel")}
            </label>
            <p className="text-muted-foreground text-xs">{t("project.rootHint")}</p>
            <Input
              id="project-root"
              value={draft.workspace.root}
              onChange={(event) => update("root", event.target.value)}
              placeholder={t("project.rootPlaceholder")}
              spellCheck={false}
              className="font-mono text-xs"
            />
          </div>

          <div className="border-border border-t pt-4">
            <p className="text-muted-foreground text-xs">修改后自动保存。</p>
            <p className="text-muted-foreground mt-1 truncate font-mono text-xs" title={view.path}>
              {t("config.path", { path: view.path })}
            </p>
          </div>
        </div>
      ) : (
        <p className="text-muted-foreground text-sm">{t("config.loadFailed")}</p>
      )}
    </div>
  );
}
