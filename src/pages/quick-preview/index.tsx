import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { FolderTree, ScanEye } from "lucide-react";
import { toast } from "sonner";
import { setActiveProject, type RemoteEntry } from "@/commands";
import { FileTree } from "@/components/file-preview/file-tree";
import { PreviewTab } from "@/components/file-preview/preview-tab";
import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  QUICK_PREVIEW_OPEN_EVENT,
  quickPreviewTargetFromUrl,
  type QuickPreviewTarget,
} from "@/lib/quick-preview";
import { useRouter } from "@/lib/router";

/**
 * The quick look: one file or one folder from the file preview page, shown in a
 * window of its own so the page itself can stay where it is.
 *
 * It is transient on purpose — nothing here is stored, and closing the window
 * destroys it. A file fills the window with the preview pane alone; a folder
 * shows the file tree with the preview beside it, which is the file preview page
 * without its project picker.
 *
 * The target arrives in the URL the window is created with, and again as
 * `quick-preview-open` when a window that is already open is reused.
 */
export default function QuickPreviewWindow() {
  const { t } = useAppTranslation();
  const { search } = useRouter();
  const [target, setTarget] = useState<QuickPreviewTarget | null>(() =>
    quickPreviewTargetFromUrl(search)
  );
  const [selected, setSelected] = useState<RemoteEntry | null>(null);
  // The tree reads through the command context, which is set per webview; it
  // only mounts once this window's context points at the target's project.
  const [readyRoot, setReadyRoot] = useState<string | null>(null);

  useEffect(() => {
    const unlisten = listen<QuickPreviewTarget>(QUICK_PREVIEW_OPEN_EVENT, (event) => {
      setTarget(event.payload);
    });
    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  useEffect(() => {
    if (!target) {
      setReadyRoot(null);
      setSelected(null);
      return;
    }
    setActiveProject(target.root);
    setReadyRoot(target.root);
    // A folder is shown selected (and expanded) before any file is chosen.
    setSelected(
      target.kind === "directory"
        ? { path: target.path, name: target.name, type: "directory" }
        : null
    );
  }, [target]);

  const title = target?.name || t("quickPreview.title");

  return (
    <WindowFrame
      titleBar={<TitleBar title={title} showPin showMaximize />}
      contentClassName="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      {!target ? (
        <QuickPreviewEmpty />
      ) : target.kind === "file" ? (
        <PreviewTab
          key={`${target.root}:${target.path}`}
          path={target.path}
          name={target.name}
          root={target.root}
        />
      ) : readyRoot === target.root ? (
        <div className="flex min-h-0 flex-1">
          <aside className="border-border flex w-64 shrink-0 flex-col border-r">
            <div className="border-border flex h-9 shrink-0 items-center gap-2 border-b px-3">
              <FolderTree className="text-muted-foreground size-3.5" />
              <span className="text-xs font-medium">{t("filePreview.treeTitle")}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              <FileTree
                key={target.path}
                selectedPath={selected?.path ?? null}
                revealPath={target.path}
                onSelect={setSelected}
                onError={(message) =>
                  toast.error(t("filePreview.treeFailed"), { description: message })
                }
                labels={{
                  loading: t("filePreview.treeLoading"),
                  empty: t("filePreview.treeEmpty"),
                  failed: t("filePreview.treeFailed"),
                }}
              />
            </div>
          </aside>
          <section className="flex min-w-0 flex-1 flex-col">
            {selected?.type === "file" ? (
              <PreviewTab
                key={selected.path}
                path={selected.path}
                name={selected.name}
                root={target.root}
              />
            ) : (
              <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 p-8 text-center text-sm">
                <ScanEye className="size-6" />
                <span>{t("filePreview.empty")}</span>
              </div>
            )}
          </section>
        </div>
      ) : null}
    </WindowFrame>
  );
}

/** Shown when the window was opened without a target in its URL. */
function QuickPreviewEmpty() {
  const { t } = useAppTranslation();

  return (
    <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <ScanEye className="size-7" />
      <div>
        <p className="text-foreground text-sm font-medium">{t("quickPreview.emptyTitle")}</p>
        <p className="mx-auto mt-1 max-w-sm text-xs">{t("quickPreview.emptyDescription")}</p>
      </div>
      <p className="text-xs">{t("quickPreview.hint")}</p>
    </div>
  );
}
