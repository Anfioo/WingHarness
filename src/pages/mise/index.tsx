import { AlertTriangle, Copy, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMisePage, type MiseTab } from "@/hooks/use-mise-page";
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";
import ConfigTab from "./config-tab";
import OverviewTab from "./overview-tab";
import ProjectsTab from "./projects-tab";
import ToolsTab from "./tools-tab";

const TABS: { value: MiseTab; labelKey: string }[] = [
  { value: "overview", labelKey: "mise.tabs.overview" },
  { value: "tools", labelKey: "mise.tabs.tools" },
  { value: "projects", labelKey: "mise.tabs.projects" },
  { value: "config", labelKey: "mise.tabs.config" },
];

/**
 * The environment page shell: it owns the runtime probe and the tab selection.
 * Each tab is a separate component owned by its lane; the page header's refresh
 * only reloads the runtime and bumps a nonce, which remounts the current tab so
 * that tab's own hook reloads its data.
 */
export default function MisePage() {
  const { t } = useAppTranslation();
  const page = useMisePage();
  const runtime = page.runtime;
  const missing = runtime !== null && !runtime.available;

  const copyInstallCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("mise.shell.guideCopied"));
    } catch {
      // Clipboard access can be refused; the command stays selectable by hand.
    }
  };

  return (
    <AppShell>
      <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-4">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">{t("mise.title")}</h1>
            <p className="text-muted-foreground text-sm">{t("mise.subtitle")}</p>
          </div>
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "rounded-full border px-2.5 py-1 text-xs",
                runtime?.available
                  ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                  : "border-amber-500/40 bg-amber-500/10 text-amber-600"
              )}
            >
              {page.loading
                ? t("mise.common.loading")
                : runtime?.available
                  ? t("mise.shell.runtimeBadge", {
                      version: runtime.version ?? t("mise.common.unknown"),
                    })
                  : t("mise.shell.runtimeMissing")}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page.loading}
              onClick={() => void page.refresh()}
            >
              <RefreshCw className={page.loading ? "animate-spin" : undefined} />
              {t("mise.actions.refresh")}
            </Button>
          </div>
        </header>

        {page.runtimeError && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span className="min-w-0 flex-1 break-words">
              {t(miseErrorKey(page.runtimeError.code))}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page.loading}
              onClick={() => void page.reloadRuntime()}
            >
              {t("mise.actions.retry")}
            </Button>
          </div>
        )}

        {!page.loading && missing && runtime && (
          <section className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <div className="flex items-start gap-3">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-amber-600" />
              <div className="min-w-0 flex-1 space-y-1">
                <h2 className="text-sm font-semibold">{t("mise.shell.guideTitle")}</h2>
                <p className="text-muted-foreground text-sm">{t("mise.shell.guideBody")}</p>
              </div>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1 font-mono text-xs">
                {runtime.installHint}
              </code>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void copyInstallCommand(runtime.installHint)}
              >
                <Copy />
                {t("mise.shell.guideCopy")}
              </Button>
              <Button size="sm" disabled={page.loading} onClick={() => void page.reloadRuntime()}>
                {page.loading && <Loader2 className="animate-spin" />}
                {t("mise.shell.guideRetry")}
              </Button>
            </div>
          </section>
        )}

        <nav className="bg-muted/70 flex flex-wrap items-center gap-0.5 rounded-lg p-0.5">
          {TABS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={page.tab === option.value}
              onClick={() => page.setTab(option.value)}
              className={cn(
                "rounded-md px-3 py-1.5 text-sm transition-colors",
                page.tab === option.value
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
            >
              {t(option.labelKey)}
            </button>
          ))}
        </nav>

        <div className="flex min-h-0 flex-1 flex-col">
          {page.tab === "overview" &&
            (runtime ? (
              <OverviewTab
                key={`overview-${page.refreshNonce}`}
                runtime={runtime}
                onReloadRuntime={() => void page.reloadRuntime()}
              />
            ) : (
              !page.loading && (
                <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
                  {t("mise.common.empty")}
                </div>
              )
            ))}
          {page.tab === "tools" && <ToolsTab key={`tools-${page.refreshNonce}`} />}
          {page.tab === "projects" && <ProjectsTab key={`projects-${page.refreshNonce}`} />}
          {page.tab === "config" && <ConfigTab key={`config-${page.refreshNonce}`} />}
        </div>
      </div>
    </AppShell>
  );
}
