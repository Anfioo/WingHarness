// The project coverage table: one row per scanned project and, when expanded,
// the version bindings that project declares. Presentational only; the tab owns
// the data through `useMiseProjects`. A project with overrides gets a warning
// badge, a project that matches the global configuration gets a healthy one.

import { AlertTriangle, Check, ChevronDown, Copy, Minus } from "lucide-react";
import { Fragment, useState } from "react";
import { toast } from "sonner";

import type {
  MiseBindingSource,
  MiseProject,
  MiseProjectNotes,
  MiseProjectScanIssue,
} from "@/commands";
import { StatusBadge } from "@/components/mise/status-badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatRelativeTime } from "@/lib/mise/format";
import { cn } from "@/lib/utils";

const NOTES_KEYS: Record<MiseProjectNotes, string> = {
  overrides: "mise.projects.notes.overrides",
  "project-only": "mise.projects.notes.projectOnly",
  none: "mise.projects.notes.none",
  consistent: "mise.projects.notes.consistent",
};

const ISSUE_KEYS: Record<MiseProjectScanIssue, string> = {
  "not-trusted": "mise.projects.issue.notTrusted",
  unavailable: "mise.projects.issue.unavailable",
};

// The DTO uses kebab-case codes; the locale keys are camelCase.
const BINDING_SOURCE_KEYS: Record<MiseBindingSource, string> = {
  project: "mise.projects.source.project",
  "project-file": "mise.projects.source.projectFile",
  global: "mise.projects.source.global",
  inherited: "mise.projects.source.inherited",
  resolved: "mise.projects.source.resolved",
};

const COLUMN_COUNT = 7;

export type ProjectCoverageTableProps = {
  projects: MiseProject[];
  /** Used by the empty state to tell "no roots yet" from "roots found nothing". */
  scanRootCount: number;
};

export function ProjectCoverageTable({ projects, scanRootCount }: ProjectCoverageTableProps) {
  const { t, language } = useAppTranslation();
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast.success(t("mise.projects.table.path"), { description: path });
    } catch {
      // Clipboard access can be refused; the path stays selectable by hand.
    }
  };

  const noteLabel = (project: MiseProject): string => {
    switch (project.notes) {
      case "overrides":
        return `${t(NOTES_KEYS.overrides, { count: project.overrideCount })} · ${project.overrideCount}`;
      case "project-only":
        return `${t(NOTES_KEYS["project-only"], {
          count: project.projectOnlyToolCount,
        })} · ${project.projectOnlyToolCount}`;
      default:
        return t(NOTES_KEYS[project.notes]);
    }
  };

  return (
    <section className="border-border bg-card flex min-w-0 flex-col rounded-xl border">
      <header className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <h2 className="text-sm font-medium">{t("mise.projects.table.title")}</h2>
        {projects.length > 0 && (
          <span className="text-muted-foreground text-xs">{projects.length}</span>
        )}
      </header>

      {projects.length === 0 ? (
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <p className="text-sm font-medium">{t("mise.projects.empty")}</p>
          <p className="text-muted-foreground text-xs">
            {scanRootCount > 0 ? t("mise.projects.scanRoot.hint") : t("mise.projects.emptyHint")}
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[820px] border-collapse text-sm">
            <thead>
              <tr className="bg-muted/40 text-muted-foreground text-left text-xs">
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.project")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.path")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.tools")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.declared")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.overrides")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.modified")}</th>
                <th className="px-3 py-2 font-medium">{t("mise.projects.table.notes")}</th>
              </tr>
            </thead>
            <tbody>
              {projects.map((project) => {
                const open = expanded.has(project.path);
                return (
                  <Fragment key={project.path}>
                    <tr className="border-border hover:bg-muted/20 border-t align-top">
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-1">
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-expanded={open}
                            aria-label={t(
                              open ? "mise.projects.table.collapse" : "mise.projects.table.expand"
                            )}
                            title={t(
                              open ? "mise.projects.table.collapse" : "mise.projects.table.expand"
                            )}
                            onClick={() => toggle(project.path)}
                          >
                            <ChevronDown
                              className={cn("transition-transform", open && "rotate-180")}
                            />
                          </Button>
                          <span className="min-w-0 text-sm font-medium break-words">
                            {project.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex items-start gap-1">
                          <span className="text-muted-foreground max-w-[280px] font-mono text-xs break-all select-text">
                            {project.path}
                          </span>
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            aria-label={t("mise.actions.copy")}
                            title={t("mise.actions.copy")}
                            onClick={() => void copyPath(project.path)}
                          >
                            <Copy />
                          </Button>
                        </div>
                      </td>
                      <td className="px-3 py-2">
                        <span className="text-xs">
                          {project.tools.length > 0
                            ? project.tools.join(", ")
                            : t("mise.common.notSet")}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums">
                        {project.declaredToolCount}
                      </td>
                      <td className="px-3 py-2 text-xs tabular-nums">{project.overrideCount}</td>
                      <td className="text-muted-foreground px-3 py-2 text-xs whitespace-nowrap">
                        {formatRelativeTime(project.lastModifiedMs, language) ||
                          t("mise.common.unknown")}
                      </td>
                      <td className="px-3 py-2">
                        <div className="flex flex-col items-start gap-1">
                          <StatusBadge level={project.overrideCount > 0 ? "warning" : "healthy"} />
                          <span
                            className={cn(
                              "text-xs",
                              project.notes === "overrides"
                                ? "text-amber-600"
                                : "text-muted-foreground"
                            )}
                          >
                            {noteLabel(project)}
                          </span>
                          {project.scanIssue !== null && (
                            <span className="flex items-center gap-1 text-xs text-amber-600">
                              <AlertTriangle className="size-3.5 shrink-0" />
                              {t(ISSUE_KEYS[project.scanIssue])}
                            </span>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-border bg-muted/30 border-t">
                        <td colSpan={COLUMN_COUNT} className="px-3 py-3">
                          <p className="mb-2 text-xs font-medium">
                            {t("mise.projects.bindings.title")}
                          </p>
                          {project.bindings.length === 0 ? (
                            <p className="text-muted-foreground text-xs">
                              {t("mise.projects.bindings.empty")}
                            </p>
                          ) : (
                            <div className="overflow-x-auto">
                              <table className="w-full min-w-[640px] text-xs">
                                <thead>
                                  <tr className="text-muted-foreground text-left">
                                    <th className="pr-3 pb-1.5 font-medium">
                                      {t("mise.projects.bindings.tool")}
                                    </th>
                                    <th className="pr-3 pb-1.5 font-medium">
                                      {t("mise.projects.bindings.projectVersion")}
                                    </th>
                                    <th className="pr-3 pb-1.5 font-medium">
                                      {t("mise.projects.bindings.globalVersion")}
                                    </th>
                                    <th className="pr-3 pb-1.5 font-medium">
                                      {t("mise.projects.bindings.source")}
                                    </th>
                                    <th className="pb-1.5 font-medium">
                                      {t("mise.projects.bindings.overridesGlobal")}
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {project.bindings.map((binding) => (
                                    <tr key={binding.name} className="border-border/60 border-t">
                                      <td className="py-1.5 pr-3 font-medium">{binding.name}</td>
                                      <td className="py-1.5 pr-3 font-mono">
                                        {binding.projectVersion || t("mise.common.notSet")}
                                      </td>
                                      <td className="py-1.5 pr-3 font-mono">
                                        {binding.globalVersion || t("mise.common.notSet")}
                                      </td>
                                      <td className="py-1.5 pr-3">
                                        {t(BINDING_SOURCE_KEYS[binding.source])}
                                        {binding.sourceFile !== null && (
                                          <span className="text-muted-foreground break-all">
                                            {" · "}
                                            {binding.sourceFile}
                                          </span>
                                        )}
                                      </td>
                                      <td className="py-1.5">
                                        {binding.overridesGlobal ? (
                                          <Check className="size-3.5 text-amber-600" />
                                        ) : (
                                          <Minus className="text-muted-foreground size-3.5" />
                                        )}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
