// The projects tab: the scan-scope panel beside the coverage table, plus the
// refresh toolbar and the notices. Data and mutations live in
// `useMiseProjects`; this file only assembles them. There is no polling.

import { AlertTriangle, RefreshCw } from "lucide-react";

import { NoticeList } from "@/components/mise/notice-list";
import { ProjectCoverageTable } from "@/components/mise/project-coverage-table";
import { ScanDirectoriesPanel } from "@/components/mise/scan-directories-panel";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMiseProjects } from "@/hooks/use-mise-projects";
import { miseErrorKey } from "@/lib/mise/error-key";

const COUNT_CHIP =
  "border-border bg-muted/40 text-muted-foreground inline-flex items-center rounded-full border px-2.5 py-1 text-xs";

export default function ProjectsTab() {
  const { t } = useAppTranslation();
  const projects = useMiseProjects();
  const coverage = projects.coverage;
  const projectCount = coverage?.projects.length ?? 0;
  const overrideCount =
    coverage?.projects.reduce((total, project) => total + project.overrideCount, 0) ?? 0;
  const scanRootCount = coverage?.scanDirectories.length ?? 0;

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t("mise.projects.subtitle")}</p>
        <div className="flex flex-wrap items-center gap-2">
          {coverage !== null && (
            <>
              <span className={COUNT_CHIP}>
                {t("mise.projects.scanRoot.title")} · {scanRootCount}
              </span>
              <span className={COUNT_CHIP}>
                {t("mise.overview.metrics.projects.caption", {
                  count: projectCount,
                  overrides: overrideCount,
                })}
              </span>
            </>
          )}
          <Button
            variant="outline"
            size="sm"
            disabled={projects.loading || projects.busy}
            onClick={() => void projects.reload()}
          >
            <RefreshCw className={projects.loading ? "animate-spin" : undefined} />
            {t("mise.projects.scan")}
          </Button>
        </div>
      </div>

      {projects.error !== null && (
        <div
          role="alert"
          className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
        >
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1 break-words">{t(miseErrorKey(projects.error))}</span>
          <Button
            variant="outline"
            size="sm"
            disabled={projects.loading || projects.busy}
            onClick={() => void projects.reload()}
          >
            {t("mise.actions.retry")}
          </Button>
        </div>
      )}

      {coverage === null ? (
        projects.loading ? (
          <div className="grid gap-3 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
            <Skeleton className="h-72 rounded-xl" />
            <Skeleton className="h-72 rounded-xl" />
          </div>
        ) : null
      ) : (
        <>
          <NoticeList notices={coverage.notices} />
          <div className="grid min-h-0 gap-3 xl:grid-cols-[minmax(280px,340px)_minmax(0,1fr)]">
            <ScanDirectoriesPanel
              coverage={coverage}
              busy={projects.busy}
              onPickRoot={projects.pickRoot}
              onAddRoot={projects.addRoot}
              onRemoveRoot={projects.removeRoot}
              onToggleRoot={projects.toggleRoot}
            />
            <ProjectCoverageTable projects={coverage.projects} scanRootCount={scanRootCount} />
          </div>
        </>
      )}
    </div>
  );
}
