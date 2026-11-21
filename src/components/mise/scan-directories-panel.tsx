// The scan scope panel: the project windows that are open right now, the custom
// scan roots with their per-root project counts, and the confirmation shown
// when a picked folder is a filesystem root or the home directory. Every
// displayed value arrives through props; the hook owns the commands.

import { homeDir } from "@tauri-apps/api/path";
import { FolderOpen, Plus, Trash2 } from "lucide-react";
import { useState } from "react";

import type { MiseProjectCoverage, MiseScanDirectory } from "@/commands";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/** The backend caps the stored roots; disabling the button keeps the user from
 *  discovering the cap through a rejected add. */
const MAX_SCAN_ROOTS = 50;

const BADGE =
  "border-border bg-muted/40 text-muted-foreground inline-flex items-center rounded-full border px-2 py-0.5 text-[11px]";

const DRIVE_ROOT = /^[a-z]:$/;
const UNC_ROOT = /^\/\/[^/]+\/[^/]+$/;

export type ScanDirectoriesPanelProps = {
  coverage: MiseProjectCoverage;
  busy: boolean;
  onPickRoot: () => Promise<string | null>;
  onAddRoot: (path: string) => Promise<void>;
  onRemoveRoot: (path: string) => Promise<void>;
  onToggleRoot: (path: string, enabled: boolean) => Promise<void>;
};

/** Trailing separators removed; a bare root keeps the shape the regexes match. */
function normalizeRoot(path: string): string {
  const forward = path.trim().replace(/\\/g, "/");
  return forward === "/" ? forward : forward.replace(/\/+$/, "");
}

/** Windows drive root, Unix root, UNC share root, or the user's home folder. */
async function isRiskyRoot(path: string): Promise<boolean> {
  const normalized = normalizeRoot(path).toLowerCase();
  if (normalized === "/" || DRIVE_ROOT.test(normalized) || UNC_ROOT.test(normalized)) {
    return true;
  }

  try {
    const home = normalizeRoot(await homeDir()).toLowerCase();
    return home.length > 0 && normalized === home;
  } catch {
    return false;
  }
}

/** Project and override counts for the projects found under one scan root. */
function rootStats(coverage: MiseProjectCoverage, directory: MiseScanDirectory) {
  const projects = coverage.projects.filter((project) => project.scanRootPath === directory.path);
  const overrides = projects.reduce((total, project) => total + project.overrideCount, 0);
  return { count: projects.length, overrides };
}

export function ScanDirectoriesPanel({
  coverage,
  busy,
  onPickRoot,
  onAddRoot,
  onRemoveRoot,
  onToggleRoot,
}: ScanDirectoriesPanelProps) {
  const { t } = useAppTranslation();
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const roots = coverage.scanDirectories;
  const atLimit = roots.length >= MAX_SCAN_ROOTS;

  const pickAndAdd = async () => {
    const path = await onPickRoot();
    if (path === null) return;

    if (await isRiskyRoot(path)) setPendingPath(path);
    else await onAddRoot(path);
  };

  const confirmRiskyRoot = () => {
    const path = pendingPath;
    setPendingPath(null);
    if (path !== null) void onAddRoot(path);
  };

  return (
    <section className="border-border bg-card flex min-w-0 flex-col gap-4 rounded-xl border p-4">
      <header className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <h2 className="text-sm font-medium">{t("mise.projects.scanRoot.title")}</h2>
          <p className="text-muted-foreground text-xs">{t("mise.projects.scanRoot.hint")}</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || atLimit}
          onClick={() => void pickAndAdd()}
        >
          <Plus />
          {t("mise.projects.scanRoot.add")}
        </Button>
      </header>

      {atLimit && <p className="text-xs text-amber-600">{t("mise.projects.scanRoot.limit")}</p>}

      <div className="space-y-2">
        <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
          {t("mise.projects.opened")}
          <span className={BADGE}>{t("mise.projects.source.opened")}</span>
        </h3>
        {coverage.openedProjects.length === 0 ? (
          <p className="text-muted-foreground text-xs">{t("mise.projects.openedEmpty")}</p>
        ) : (
          <ul className="space-y-1">
            {coverage.openedProjects.map((path) => (
              <li
                key={path}
                className="bg-muted/40 rounded-md px-2 py-1.5 font-mono text-xs break-all select-text"
              >
                {path}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="space-y-2">
        <h3 className="text-muted-foreground flex items-center gap-2 text-xs font-medium">
          {t("mise.projects.source.scanRoot")}
          <span className={BADGE}>{roots.length}</span>
        </h3>
        {roots.length === 0 ? (
          <div className="border-border bg-muted/20 flex items-center gap-2 rounded-lg border border-dashed px-3 py-4">
            <FolderOpen className="text-muted-foreground size-4 shrink-0" />
            <p className="text-muted-foreground text-xs">{t("mise.projects.scanRoot.empty")}</p>
          </div>
        ) : (
          <ul className="space-y-2">
            {roots.map((directory) => {
              const stats = rootStats(coverage, directory);
              return (
                <li
                  key={directory.path}
                  className={cn(
                    "border-border bg-background/40 rounded-lg border p-2.5",
                    !directory.enabled && "opacity-60"
                  )}
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1 space-y-1">
                      <p className="font-mono text-xs break-all select-text">{directory.path}</p>
                      <p className="text-muted-foreground text-xs">
                        {t("mise.overview.metrics.projects.caption", {
                          count: stats.count,
                          overrides: stats.overrides,
                        })}
                      </p>
                    </div>
                    <Switch
                      checked={directory.enabled}
                      disabled={busy}
                      aria-label={t("mise.projects.scanRoot.toggleAria", { path: directory.path })}
                      onCheckedChange={(enabled) => void onToggleRoot(directory.path, enabled)}
                    />
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={busy}
                      aria-label={t("mise.projects.scanRoot.remove")}
                      title={t("mise.projects.scanRoot.remove")}
                      onClick={() => void onRemoveRoot(directory.path)}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <AlertDialog
        open={pendingPath !== null}
        onOpenChange={(open) => {
          if (!open) setPendingPath(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("mise.projects.risk.title")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("mise.projects.risk.body", { path: pendingPath ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("mise.actions.cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={confirmRiskyRoot}>
              {t("mise.projects.risk.confirm")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
