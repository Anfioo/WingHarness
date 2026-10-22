import { useCallback, useEffect, useRef, useState } from "react";
import { FolderTree } from "lucide-react";
import { toast } from "sonner";
import { previewBytes, previewMetadata, type RemoteEntry } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { FileTree } from "@/components/file-preview/file-tree";
import { PreviewPane } from "@/components/file-preview/preview-pane";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { bytesToObjectUrl } from "@/lib/preview/lib/bytes";
import type { FileMetadata } from "@/lib/preview/types";
import { loadPreview } from "@/lib/preview/viewers/loadPreview";
import { objectUrlsFrom } from "@/lib/preview/viewers/previewResources";
import type { LoadState } from "@/lib/preview/viewers/previewTypes";

/**
 * Preview the files in the git-svn working copy.
 *
 * The tree is the same one the project editor reads — `project_tree`, one level
 * at a time — but nothing here writes: pick a file and it is read through
 * `preview_bytes` and handed to the viewer registry, which parses it in the
 * webview. The only backend work is reading bytes.
 *
 * The root is whatever the config names; this page neither knows nor checks it,
 * and the backend refuses anything that escapes it.
 */
export default function FilePreviewPage() {
  const { t } = useAppTranslation();
  const [payload, setPayload] = useState<FileMetadata | null>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });

  // Blob URLs made for a preview that is no longer on screen. Both kinds are
  // tracked here: the one built from the file's bytes, and any the renderers
  // made themselves (archive entries, PSD, decoded media).
  const ownedUrls = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic: a slower earlier request must not overwrite a newer selection.
  const requestRef = useRef(0);

  const releaseUrls = useCallback(() => {
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current.clear();
  }, []);

  useEffect(
    () => () => {
      abortRef.current?.abort();
      releaseUrls();
    },
    [releaseUrls]
  );

  const openFile = useCallback(
    async (entry: RemoteEntry) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const request = ++requestRef.current;

      releaseUrls();
      // The name is known before the read, so the toolbar and the loading pane
      // have something to show while the file is fetched.
      setPayload({ path: entry.path, name: entry.name, mime: "", size: entry.size ?? 0 });
      setState({ status: "loading" });

      try {
        const meta = await previewMetadata(entry.path);
        if (request !== requestRef.current) return;
        const metadata: FileMetadata = {
          path: meta.path,
          name: meta.name,
          extension: meta.extension,
          mime: meta.mime,
          size: meta.size,
          modified: meta.modified,
        };
        setPayload(metadata);

        if (meta.overCap) {
          setState({ status: "error", message: t("filePreview.tooLarge") });
          return;
        }

        const bytes = await previewBytes(entry.path);
        if (request !== requestRef.current) return;

        const url = bytesToObjectUrl(bytes, meta.mime);
        ownedUrls.current.add(url);
        const result = await loadPreview(metadata, url, controller.signal);
        if (request !== requestRef.current) return;
        for (const owned of objectUrlsFrom(result)) ownedUrls.current.add(owned);
        setState(result);
      } catch (error) {
        if (request !== requestRef.current) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    [releaseUrls, t]
  );

  const reload = useCallback(() => {
    if (payload) void openFile({ path: payload.path, name: payload.name, type: "file" });
  }, [openFile, payload]);

  const onTreeError = useCallback(
    (message: string) => toast.error(t("filePreview.treeFailed"), { description: message }),
    [t]
  );

  return (
    <AppShell>
      <section className="flex h-full w-full flex-col gap-4">
        <div className="flex min-h-0 flex-1 gap-4">
          <aside className="border-border bg-card flex w-72 shrink-0 flex-col overflow-hidden rounded-xl border shadow-sm">
            <div className="border-border flex h-10 shrink-0 items-center gap-2 border-b px-3">
              <FolderTree className="text-muted-foreground size-4" />
              <span className="text-sm font-medium">{t("filePreview.treeTitle")}</span>
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-1">
              <FileTree
                selectedPath={payload?.path ?? null}
                onSelectFile={(entry) => void openFile(entry)}
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
            <PreviewPane
              payload={payload}
              state={state}
              onReload={reload}
              reloadLabel={t("filePreview.reload")}
              emptyLabel={t("filePreview.empty")}
            />
          </section>
        </div>
      </section>
    </AppShell>
  );
}
