// The config tab: the document strip with the global / project choice, the
// runtime, proxy and Java alias panels, and the read-only `[tools]` tables.
// Every write is staged as a preview and confirmed in the shared diff dialog;
// the tab reloads on mount and after a save, and never watches the files.

import { useState, type ReactNode } from "react";
import { AlertTriangle, Pencil, RefreshCw } from "lucide-react";

import type { MiseConfigDocument, MiseConfigEdit, MiseConfigToolsSection } from "@/commands";
import { ConfigDocumentEditorDialog } from "@/components/mise/config-document-editor-dialog";
import { JavaAliasPanel } from "@/components/mise/java-alias-panel";
import { ProxySettingsPanel } from "@/components/mise/proxy-settings-panel";
import { RuntimeSettingsPanel } from "@/components/mise/runtime-settings-panel";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useMiseConfig } from "@/hooks/use-mise-config";
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";

const GLOBAL_SELECT_VALUE = "global";

function Panel({
  title,
  description,
  action,
  children,
}: {
  title: ReactNode;
  description?: string;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{title}</h2>
          {description && <p className="text-muted-foreground text-xs">{description}</p>}
        </div>
        {action}
      </div>
      <div className="p-4">{children}</div>
    </section>
  );
}

function DocumentCard({ document, onEdit }: { document: MiseConfigDocument; onEdit: () => void }) {
  const { t } = useAppTranslation();
  return (
    <div className="border-border bg-muted/30 flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium">
            {document.kind === "global"
              ? t("mise.config.document.global")
              : t("mise.config.document.project")}
          </span>
          <span
            className={cn(
              "rounded-full border px-2 py-0.5 text-[11px]",
              document.exists
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600"
            )}
          >
            {document.exists ? t("mise.config.document.exists") : t("mise.config.document.missing")}
          </span>
        </div>
        <p className="text-muted-foreground font-mono text-xs break-all select-text">
          {document.path}
        </p>
      </div>
      <Button variant="outline" size="sm" onClick={onEdit}>
        <Pencil />
        {t("mise.config.document.edit")}
      </Button>
    </div>
  );
}

function ToolsPanel({ sections }: { sections: MiseConfigToolsSection[] }) {
  const { t } = useAppTranslation();
  return (
    <Panel title={t("mise.tools.title")}>
      <div className="flex flex-col gap-4">
        {sections.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mise.common.empty")}</p>
        ) : (
          sections.map((section) => (
            <div key={section.kind} className="flex flex-col gap-2">
              <h3 className="text-muted-foreground text-xs font-medium">
                {section.kind === "global"
                  ? t("mise.config.document.global")
                  : t("mise.config.document.project")}{" "}
                <code className="font-mono">[tools]</code>
              </h3>
              {section.entries.length === 0 ? (
                <p className="text-muted-foreground text-sm">{t("mise.common.empty")}</p>
              ) : (
                <div className="border-border overflow-hidden rounded-lg border">
                  <table className="w-full text-sm">
                    <thead className="bg-muted/50 text-muted-foreground text-xs">
                      <tr>
                        <th className="px-3 py-1.5 text-left font-medium">
                          {t("mise.tools.fields.id")}
                        </th>
                        <th className="px-3 py-1.5 text-left font-medium">
                          {t("mise.tools.fields.requested")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {section.entries.map((entry) => (
                        <tr key={entry.tool} className="border-border border-t">
                          <td className="px-3 py-1.5 font-mono text-xs">{entry.tool}</td>
                          <td className="px-3 py-1.5 font-mono text-xs">{entry.version}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          ))
        )}
      </div>
    </Panel>
  );
}

export default function ConfigTab() {
  const { t } = useAppTranslation();
  const config = useMiseConfig();
  const [editingDocument, setEditingDocument] = useState<MiseConfigDocument | null>(null);

  const workspace = config.workspace;
  const globalDocument = config.globalDocument;
  const projectDocument = config.projectDocument;
  const globalPath = globalDocument?.path ?? workspace?.runtimeSettings.path ?? "";

  const previewFor = (path: string) => (edit: MiseConfigEdit) => config.preview(path, edit);

  const errorBanner = config.error && (
    <div
      role="alert"
      className="border-destructive/40 bg-destructive/5 text-destructive flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-sm"
    >
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 break-words">
        {t("mise.error.load")} {t(miseErrorKey(config.error))}
      </span>
      <Button
        variant="outline"
        size="sm"
        disabled={config.loading}
        onClick={() => void config.reload()}
      >
        {t("mise.actions.retry")}
      </Button>
    </div>
  );

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-3 overflow-y-auto">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-muted-foreground text-sm">{t("mise.config.subtitle")}</p>
        <Button
          variant="outline"
          size="sm"
          disabled={config.loading || config.busy}
          onClick={() => void config.reload()}
        >
          <RefreshCw className={config.loading ? "animate-spin" : undefined} />
          {t("mise.actions.refresh")}
        </Button>
      </div>

      {errorBanner}

      {workspace === null ? (
        config.loading ? (
          <>
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-36 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </>
        ) : (
          !config.error && (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 py-16 text-sm">
              {t("mise.common.empty")}
            </div>
          )
        )
      ) : (
        <>
          <Panel
            title={t("mise.config.document.title")}
            description={t("mise.config.document.hint")}
          >
            <div className="flex flex-col gap-3">
              {globalDocument && (
                <DocumentCard
                  document={globalDocument}
                  onEdit={() => setEditingDocument(globalDocument)}
                />
              )}

              <div className="flex flex-wrap items-end gap-3">
                <div className="flex w-full max-w-sm flex-col gap-1.5">
                  <label htmlFor="mise-config-project" className="text-sm font-medium">
                    {t("mise.config.document.projectSelect")}
                  </label>
                  <Select
                    value={config.selectedProject?.path ?? GLOBAL_SELECT_VALUE}
                    onValueChange={(value) => {
                      if (value === GLOBAL_SELECT_VALUE) {
                        config.selectProject(null);
                        return;
                      }
                      const project = config.projects.find((item) => item.path === value) ?? null;
                      config.selectProject(project);
                    }}
                  >
                    <SelectTrigger id="mise-config-project" className="w-full">
                      <SelectValue placeholder={t("mise.config.document.projectPlaceholder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={GLOBAL_SELECT_VALUE}>
                        {t("mise.config.document.global")}
                      </SelectItem>
                      {config.projects.map((project) => (
                        <SelectItem key={project.path} value={project.path}>
                          {project.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                {config.selectedProject && (
                  <p className="text-muted-foreground font-mono text-xs break-all select-text">
                    {config.selectedProject.path}
                  </p>
                )}
              </div>

              {projectDocument ? (
                <DocumentCard
                  document={projectDocument}
                  onEdit={() => setEditingDocument(projectDocument)}
                />
              ) : (
                config.selectedProject && (
                  <p className="text-muted-foreground text-sm">
                    {t("mise.config.document.noProject")}
                  </p>
                )
              )}
            </div>
          </Panel>

          <RuntimeSettingsPanel
            settings={workspace.runtimeSettings}
            onPreview={previewFor(workspace.runtimeSettings.path)}
            onSave={config.save}
          />

          <ProxySettingsPanel
            settings={workspace.proxySettings}
            onPreview={previewFor(workspace.proxySettings.path)}
            onSave={config.save}
          />

          <JavaAliasPanel
            aliases={workspace.javaAliases}
            onPreview={previewFor(globalPath)}
            onSave={config.save}
          />

          <ToolsPanel sections={workspace.toolsSections} />
        </>
      )}

      {editingDocument && (
        <ConfigDocumentEditorDialog
          key={editingDocument.path}
          open
          document={editingDocument}
          onPreview={previewFor(editingDocument.path)}
          onSave={config.save}
          onOpenChange={(open) => {
            if (!open) setEditingDocument(null);
          }}
        />
      )}
    </div>
  );
}
