import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FolderTree } from "lucide-react";
import { toast } from "sonner";
import {
  previewBytes,
  previewMetadata,
  projectRead,
  projectWrite,
  type RemoteEntry,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { CodeEditor } from "@/components/code-editor";
import { FileTree } from "@/components/file-preview/file-tree";
import { PreviewPane } from "@/components/file-preview/preview-pane";
import { ProjectPicker } from "@/components/project-picker";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useFilePreviewConfig } from "@/hooks/use-file-preview-config";
import { useShortcutConfig } from "@/hooks/use-shortcut-config";
import { languageOf } from "@/lib/git-core/highlight";
import { openQuickPreview } from "@/lib/quick-preview";
import { DoublePressTracker, isEditableTarget, shortcutMatchesEvent } from "@/lib/shortcut-spec";
import { bytesToObjectUrl } from "@/lib/preview/lib/bytes";
import type { FileMetadata } from "@/lib/preview/types";
import { loadPreview } from "@/lib/preview/viewers/loadPreview";
import { objectUrlsFrom } from "@/lib/preview/viewers/previewResources";
import { resolveViewer } from "@/lib/preview/viewers/registry";
import type { LoadState } from "@/lib/preview/viewers/previewTypes";

/**
 * Preview the files of one project, chosen at the top of the page.
 *
 * The tree is the same one the project editor reads — `project_tree`, one level
 * at a time — and the preview is read through `preview_bytes` and handed to the
 * viewer registry, which parses it in the webview. Text-like files can also be
 * edited here: the editor reads the raw text through `project_read` (not the
 * rendered preview — Markdown is shown as HTML, JSON is re-indented) and writes
 * it back through `project_write`, whose etag refuses a write over a file that
 * changed on disk in the meantime.
 *
 * The root comes from the page's project picker; the backend refuses anything
 * that escapes it.
 */
export default function FilePreviewPage() {
  const { t } = useAppTranslation();
  const config = useFilePreviewConfig();
  const shortcuts = useShortcutConfig();
  const [root, setRoot] = useState("");
  const [payload, setPayload] = useState<FileMetadata | null>(null);
  // The entry the tree marks, file or folder: a quick look can be opened on
  // either, so the selection is wider than the file on screen.
  const [selected, setSelected] = useState<RemoteEntry | null>(null);
  const [state, setState] = useState<LoadState>({ status: "idle" });
  const [overCap, setOverCap] = useState(false);

  // Editing: the raw text, the tag it was read with, and whether it is back on
  // disk. `dirty` is derived — typing a file back to its original text is not a
  // change.
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState("");
  const [original, setOriginal] = useState("");
  const [etag, setEtag] = useState<string | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const dirty = editing && text !== original;

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
      setOverCap(false);
      // The name is known before the read, so the toolbar and the loading pane
      // have something to show while the file is fetched.
      setPayload({ path: entry.path, name: entry.name, mime: "", size: entry.size ?? 0 });
      setState({ status: "loading" });

      try {
        const meta = await previewMetadata(entry.path, root);
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
          setOverCap(true);
          setState({ status: "error", message: t("filePreview.tooLarge") });
          return;
        }

        const bytes = await previewBytes(entry.path, root);
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
    [releaseUrls, root, t]
  );

  /**
   * The quick look's in-app trigger.
   *
   * It is matched here rather than registered with the OS: Space and a double
   * Ctrl are not combinations the global-shortcut plugin can hold without
   * taking them from every other program. Escape and typing are left alone —
   * the listener is capture-phase so the tree's own Space activation does not
   * fire first.
   */
  const selectedRef = useRef<RemoteEntry | null>(null);
  selectedRef.current = selected;
  useEffect(() => {
    if (!root || !shortcuts.quickPreview) return;
    const tracker = new DoublePressTracker();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || isEditableTarget(event.target)) return;
      if (!shortcutMatchesEvent(shortcuts.quickPreview, event, tracker)) return;
      const entry = selectedRef.current;
      if (!entry) return;
      event.preventDefault();
      event.stopPropagation();
      void openQuickPreview({
        root,
        path: entry.path,
        name: entry.name,
        kind: entry.type,
      }).catch((error: unknown) => {
        toast.error(t("quickPreview.openFailed"), {
          description: error instanceof Error ? error.message : String(error),
        });
      });
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [root, shortcuts.quickPreview, t]);

  const reload = useCallback(() => {
    if (payload) void openFile({ path: payload.path, name: payload.name, type: "file" });
  }, [openFile, payload]);

  /**
   * Leaves edit mode, asking first when there is text to lose. Returns false
   * when the user says no, so the caller can cancel the navigation too.
   */
  const leaveEdit = useCallback(() => {
    if (!editing) return true;
    if (dirty && !window.confirm(t("filePreview.discardConfirm"))) return false;
    setEditing(false);
    return true;
  }, [dirty, editing, t]);

  const startEdit = useCallback(async () => {
    if (!payload) return;
    try {
      const result = await projectRead(payload.path, root);
      setText(result.text);
      setOriginal(result.text);
      setEtag(result.etag);
      setEditing(true);
    } catch (error) {
      toast.error(t("filePreview.editFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    }
  }, [payload, root, t]);

  const saveEdit = useCallback(async () => {
    if (!payload || saving || text === original) return;
    setSaving(true);
    try {
      await projectWrite(payload.path, text, etag, root);
      setEditing(false);
      toast.success(t("filePreview.saved"));
      // Read it back through the viewer path: the preview should show what is
      // on disk now, not what the editor happens to hold.
      void openFile({ path: payload.path, name: payload.name, type: "file" });
    } catch (error) {
      toast.error(t("filePreview.saveFailed"), {
        description: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setSaving(false);
    }
  }, [etag, openFile, original, payload, root, saving, t, text]);

  const cancelEdit = useCallback(() => {
    leaveEdit();
  }, [leaveEdit]);

  /**
   * Text-like means the viewer treats the file as text, or the fallback found
   * decodable text under an extension nobody claimed. Anything rendered from a
   * structured format (HTML, sheets, documents) is left alone. Waiting for a
   * ready state also keeps the pencil away from a file that is still being read
   * — it may yet turn out to be past the threshold.
   */
  const canEdit = useMemo(() => {
    if (!payload || overCap || state.status !== "ready") return false;
    if (resolveViewer(payload.name).editable) return true;
    return state.content.kind === "text";
  }, [payload, overCap, state]);

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
            if (!leaveEdit()) return;
            releaseUrls();
            setPayload(null);
            setSelected(null);
            setOverCap(false);
            setState({ status: "idle" });
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
                  selectedPath={selected?.path ?? null}
                  onSelect={(entry) => {
                    if (entry.type === "directory") {
                      // A folder is only the quick look's target; the file on
                      // screen stays where it is.
                      setSelected(entry);
                      return;
                    }
                    if (!leaveEdit()) return;
                    setSelected(entry);
                    void openFile(entry);
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
              <PreviewPane
                payload={payload}
                state={state}
                onReload={reload}
                reloadLabel={t("filePreview.reload")}
                emptyLabel={t("filePreview.empty")}
                highlight={config.highlight}
                onEdit={canEdit ? () => void startEdit() : undefined}
                editLabel={t("filePreview.edit")}
                editing={editing}
                dirty={dirty}
                dirtyLabel={t("filePreview.dirty")}
                saving={saving}
                onSave={() => void saveEdit()}
                saveLabel={saving ? t("filePreview.saving") : t("filePreview.save")}
                onCancel={cancelEdit}
                cancelLabel={t("filePreview.cancel")}
                editor={
                  <CodeEditor
                    value={text}
                    language={payload ? languageOf(payload.path) : null}
                    highlight={config.highlight}
                    onChange={setText}
                    onSave={() => void saveEdit()}
                    ariaLabel={payload?.name ?? ""}
                    className="h-full"
                  />
                }
              />
            </section>
          </div>
        ) : null}
      </section>
    </AppShell>
  );
}
