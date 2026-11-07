import { useCallback, useEffect, useState } from "react";
import { FolderGit2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  projectRecentList,
  projectSetActive,
  setActiveProject,
  type ProjectEntry,
} from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { openProjectHome } from "@/lib/project-routes";
import { cn } from "@/lib/utils";

/**
 * The project a page without a window of its own works on — the file preview,
 * the AI config sync and the database page.
 *
 * Choosing here does two things: it sets the module-level active project the
 * command wrappers read, and it records the choice as the app-wide active one,
 * so opening another of these pages starts where this one left off. With no
 * project opened yet it says so and points at the picker page.
 */
export function ProjectPicker({
  value,
  onChange,
  className,
}: {
  value: string;
  onChange: (root: string) => void;
  className?: string;
}) {
  const { t } = useAppTranslation();
  const [recents, setRecents] = useState<ProjectEntry[]>([]);

  const load = useCallback(() => {
    void projectRecentList()
      .then(setRecents)
      .catch((error: unknown) => {
        console.error("Failed to load recent projects:", error);
      });
  }, []);

  // A project opened in the meantime should appear without a reload; focus is
  // the only moment this can change without this page doing it.
  useEffect(() => {
    load();
    const refresh = () => load();
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [load]);

  const choose = useCallback(
    (root: string) => {
      setActiveProject(root);
      void projectSetActive(root).catch(() => undefined);
      onChange(root);
    },
    [onChange]
  );

  // The newest project is what the page shows until the user picks another; the
  // backend already puts the most recently opened first.
  useEffect(() => {
    if (value || recents.length === 0) return;
    choose(recents[0].path);
  }, [choose, recents, value]);

  return (
    <div className={cn("flex min-w-0 items-center gap-2", className)}>
      <FolderGit2 className="text-muted-foreground size-4 shrink-0" />
      {recents.length === 0 ? (
        <span className="text-muted-foreground text-xs">{t("projectPicker.empty")}</span>
      ) : (
        <Select value={value} onValueChange={choose}>
          <SelectTrigger className="h-8 w-72" aria-label={t("projectPicker.label")}>
            <SelectValue placeholder={t("projectPicker.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {recents.map((project) => (
              <SelectItem key={project.path} value={project.path}>
                {project.name || project.path}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button variant="outline" size="sm" onClick={openProjectHome}>
        {t("projectPicker.manage")}
      </Button>
    </div>
  );
}
