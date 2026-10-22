import { useCallback, useEffect, useRef, useState } from "react";
import { previewBytes, previewMetadata } from "@/commands";
import { PreviewPane } from "@/components/file-preview/preview-pane";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { PreviewOpenEvent } from "@/lib/editor/preview-extension";
import { bytesToObjectUrl } from "@/lib/preview/lib/bytes";
import type { FileMetadata } from "@/lib/preview/types";
import { loadPreview } from "@/lib/preview/viewers/loadPreview";
import { objectUrlsFrom } from "@/lib/preview/viewers/previewResources";
import type { LoadState } from "@/lib/preview/viewers/previewTypes";

/**
 * The preview a codelet tab asked for, drawn over the editor.
 *
 * The reader's own view of the file. It covers the workbench while it is up, so the tab's
 * own frame — and the toolbar that would sit over it — is never seen; the close button is
 * what goes back to the editor, and it closes the tab the same way clicking the tab's ×
 * does.
 *
 * The loading is the File Preview page's, step for step: metadata, then bytes, then the
 * viewer registry. That page renders the same `PreviewPane`, so a file here and the same
 * file there look alike.
 */
export function PreviewOverlay({ target }: { target: PreviewOpenEvent | null }) {
  const { t } = useAppTranslation();
  const [payload, setPayload] = useState<FileMetadata | null>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  // Bumped by the reload button; the load effect reads it so a retry re-runs.
  const [attempt, setAttempt] = useState(0);
  // Blob URLs made for a preview that is no longer on screen — the one built from the
  // file's bytes, and any the renderers made themselves.
  const ownedUrls = useRef<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const path = target?.path ?? null;
  const name = target?.name ?? "";

  const releaseUrls = useCallback(() => {
    for (const url of ownedUrls.current) URL.revokeObjectURL(url);
    ownedUrls.current.clear();
  }, []);

  useEffect(() => {
    if (!path) return;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    let cancelled = false;

    releaseUrls();
    // The name is known before the read, so the toolbar and the loading pane have something
    // to show while the file is fetched.
    setPayload({ path, name, mime: "", size: 0 });
    setState({ status: "loading" });

    void (async () => {
      try {
        const meta = await previewMetadata(path);
        if (cancelled) return;
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

        const bytes = await previewBytes(path);
        if (cancelled) return;

        const url = bytesToObjectUrl(bytes, meta.mime);
        ownedUrls.current.add(url);
        const result = await loadPreview(metadata, url, controller.signal);
        if (cancelled) return;
        for (const owned of objectUrlsFrom(result)) ownedUrls.current.add(owned);
        setState(result);
      } catch (error) {
        if (cancelled) return;
        if (error instanceof DOMException && error.name === "AbortError") return;
        setState({
          status: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
      releaseUrls();
    };
  }, [path, name, attempt, releaseUrls, t]);

  if (!target) return null;

  return (
    <div className="bg-background absolute inset-0 z-10 flex min-h-0 flex-col">
      <PreviewPane
        payload={payload}
        state={state}
        onReload={() => setAttempt((count) => count + 1)}
        reloadLabel={t("filePreview.reload")}
        emptyLabel={t("filePreview.empty")}
        onClose={target.close}
        closeLabel={t("filePreview.close")}
      />
    </div>
  );
}
