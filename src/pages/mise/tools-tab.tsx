// The tools tab: the list and detail two-column workspace, the install dialog
// and the shared preview / progress dialogs. All data and action state live in
// `useMiseTools`; this file only assembles them.

import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { useState } from "react";

import type { MiseTool } from "@/commands";
import { ActionPreviewDialog } from "@/components/mise/action-preview-dialog";
import { ActionProgressDialog } from "@/components/mise/action-progress-dialog";
import { InstallToolDialog } from "@/components/mise/install-tool-dialog";
import { ToolDetail } from "@/components/mise/tool-detail";
import { ToolList } from "@/components/mise/tool-list";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMiseTools } from "@/hooks/use-mise-tools";
import { affectedFilesForScript, uninstallToolScript, upgradeScript } from "@/lib/mise/commands";

function globalConfigPath(tool: MiseTool): string | undefined {
  return tool.sourceKind === "global" ? (tool.sourcePath ?? undefined) : undefined;
}

export default function ToolsTab() {
  const { t } = useAppTranslation();
  const tools = useMiseTools();
  const [installOpen, setInstallOpen] = useState(false);

  const current = tools.detail ?? tools.selectedTool;

  const previewUpgrade = () => {
    if (!current?.updateVersion) return;

    const version = current.updateVersion;
    const script = upgradeScript(current.id, version, current.sourceKind);
    tools.previewAction({
      title: `${t("mise.tools.action.upgrade")} ${current.id}@${version}`,
      summary: t("mise.tools.fields.updateAvailable", { version }),
      command: script,
      level: "healthy",
      affectedFiles: affectedFilesForScript(script, globalConfigPath(current)),
      confirmLabel: t("mise.tools.action.upgrade"),
    });
  };

  const previewUninstallTool = () => {
    if (!current) return;

    const script = uninstallToolScript(current.id);
    tools.previewAction({
      title: `${t("mise.tools.action.uninstallTool")} ${current.id}`,
      summary: t("mise.tools.uninstall.toolDescription", { tool: current.id }),
      command: script,
      level: "warning",
      affectedFiles: affectedFilesForScript(script, globalConfigPath(current)),
      confirmLabel: t("mise.tools.uninstall.confirm"),
    });
  };

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t("mise.tools.subtitle")}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={tools.loading || tools.busy}
            onClick={() => void tools.reload()}
          >
            <RefreshCw className={tools.loading ? "animate-spin" : undefined} />
            {t("mise.actions.refresh")}
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={tools.busy}
            onClick={() => setInstallOpen(true)}
          >
            <Plus />
            {t("mise.tools.install.title")}
          </Button>
          {current?.updateVersion && (
            <Button size="sm" disabled={tools.busy} onClick={previewUpgrade}>
              {t("mise.tools.action.upgrade")}
            </Button>
          )}
          {current && (
            <Button
              variant="outline"
              size="sm"
              disabled={tools.busy}
              onClick={previewUninstallTool}
            >
              <Trash2 />
              {t("mise.tools.action.uninstallTool")}
            </Button>
          )}
        </div>
      </div>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[300px_minmax(0,1fr)]">
        <ToolList
          tools={tools.tools}
          loading={tools.loading}
          error={tools.error}
          selectedId={tools.selectedId}
          onSelect={tools.select}
          onRefresh={() => void tools.reload()}
        />
        <ToolDetail
          tool={tools.detail}
          loading={tools.detailLoading}
          error={tools.detailError}
          onCancel={tools.cancelDetail}
          onRetry={tools.retryDetail}
          onPreviewAction={tools.previewAction}
        />
      </div>

      <InstallToolDialog
        open={installOpen}
        onOpenChange={setInstallOpen}
        suggestions={
          tools.detail ? { tool: tools.detail.id, versions: tools.detail.remoteVersions } : null
        }
        onPreview={(request) => {
          setInstallOpen(false);
          tools.previewAction(request);
        }}
      />

      <ActionPreviewDialog
        open={tools.action !== null}
        title={tools.action?.title ?? ""}
        summary={tools.action?.summary ?? ""}
        command={tools.action?.command ?? ""}
        level={tools.action?.level ?? "info"}
        affectedFiles={tools.action?.affectedFiles}
        impactScope={tools.action?.impactScope}
        riskNotes={tools.action?.riskNotes}
        confirmLabel={tools.action?.confirmLabel ?? t("mise.tools.action.preview")}
        busy={tools.busy}
        onConfirm={tools.confirmAction}
        onOpenChange={(open) => {
          if (!open) tools.closePreview();
        }}
      />

      <ActionProgressDialog
        open={tools.progress !== null}
        title={tools.progress?.title ?? ""}
        totalCommands={tools.progress?.totalCommands ?? 0}
        completedCommands={tools.progress?.completedCommands ?? 0}
        currentCommand={tools.progress?.currentCommand ?? ""}
        commandIndex={tools.progress?.commandIndex ?? 0}
        logs={tools.progress?.logs ?? []}
        status={tools.progress?.status ?? "running"}
        errorCode={tools.progress?.errorCode ?? null}
        onOpenChange={(open) => {
          if (!open) tools.closeProgress();
        }}
      />
    </div>
  );
}
