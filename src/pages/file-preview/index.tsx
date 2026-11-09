import { useCallback, useMemo, useRef, useState } from "react";
import { FolderTree } from "lucide-react";
import { toast } from "sonner";
import type { RemoteEntry } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { absolutePath } from "@/components/file-preview/absolute-path";
import { FileTree } from "@/components/file-preview/file-tree";
import { PreviewHost, type PreviewTarget } from "@/components/space-preview/host";
import { ProjectPicker } from "@/components/project-picker";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * Preview the files of one project, chosen at the top of the page.
 *
 * The tree is the same one the project editor reads — `project_tree`, one level
 * at a time — and the selected file is handed to `PreviewHost`, the same host
 * the project and notes tabs and the standalone preview window render. The host
 * owns the engine, the edit mode, the save and its encoding, so a file shows
 * the same way wherever it is opened.
 *
 * The tree spells its paths `/`-rooted; the backend wants an absolute Windows
 * path, so the two are joined here before the host sees them.
 */
export default function FilePreviewPage() {
  const { t } = useAppTranslation();
  const [root, setRoot] = useState("");
  const [selection, setSelection] = useState<{ path: string; name: string } | null>(null);
  // The host cannot veto a target change, so the last dirty value is kept here
  // and the page asks before switching files or projects.
  const dirtyRef = useRef(false);

  const target = useMemo<PreviewTarget | null>(
    () => (selection ? { path: absolutePath(root, selection.path), name: selection.name } : null),
    [root, selection]
  );

  const confirmDiscard = useCallback(() => {
    if (!dirtyRef.current) return true;
    return window.confirm(
      t("spacePreview.editor.discardConfirm", { defaultValue: "Discard the unsaved changes?" })
    );
  }, [t]);

  const onTreeError = useCallback(
    (message: string) => toast.error(t("filePreview.treeFailed"), { description: message }),
    [t]
  );

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        <ProjectPicker
          value={root}
          onChange={(next) => {
            if (!confirmDiscard()) return;
            setSelection(null);
            setRoot(next);
          }}
        />
        {root ? (
          <div className="flex min-h-0 flex-1 gap-4">
            <aside className="border-border bg-card flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border shadow-sm">
              <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
                <FolderTree className="text-muted-foreground size-4" />
                <span className="text-sm font-medium">{t("filePreview.treeTitle")}</span>
              </div>
              <div className="min-h-0 flex-1 overflow-auto p-1">
                {/* Keyed on the root: the tree's loaded folders belong to the
                    project it was built for, not to the one now selected. */}
                <FileTree
                  key={root}
                  selectedPath={selection?.path ?? null}
                  onSelectFile={(entry: RemoteEntry) => {
                    if (!confirmDiscard()) return;
                    setSelection({ path: entry.path, name: entry.name });
                  }}
                  onError={onTreeError}
                  labels={{
                    loading: t("filePreview.treeLoading"),
                    empty: t("filePreview.treeEmpty"),
                    failed: t("filePreview.treeFailed"),
                  }}
                />
              </div>
            </aside>

            <section className="border-border bg-card flex min-w-0 flex-1 flex-col overflow-hidden rounded-xl border shadow-sm">
              <PreviewHost
                mode="embedded"
                target={target}
                onDirtyChange={(dirty) => {
                  dirtyRef.current = dirty;
                }}
                className="min-h-0 flex-1"
              />
            </section>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
