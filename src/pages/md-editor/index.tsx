import { useCallback, useEffect, useMemo, useRef } from "react";
import type { CSSProperties } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { EditorView } from "@codemirror/view";
import { FileText } from "lucide-react";
import {
  Group,
  Separator,
  Panel,
  type GroupImperativeHandle,
  type Layout,
  type LayoutChangedMeta,
} from "react-resizable-panels";
import { AppShell } from "@/components/app-shell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EditorContextMenu, PreviewContextMenu } from "@/features/md-editor/context-menu";
import { CmHost } from "@/features/md-editor/editor/cm-host";
import type { MdFileCommand } from "@/features/md-editor/editor/keymap";
import { getActiveView } from "@/features/md-editor/editor/view-registry";
import { ExportMenu } from "@/features/md-editor/export/export-menu";
import { extractHeadings, type OutlineHeading } from "@/features/md-editor/outline/extract";
import { OutlinePanel } from "@/features/md-editor/outline/outline";
import { ASSETS_RESOLVED_EVENT, PreviewPane } from "@/features/md-editor/preview/pane";
import { isDocumentTooLarge, renderMarkdown } from "@/features/md-editor/preview/render";
import {
  buildSamples,
  computeLine,
  computeTarget,
  type ScrollSample,
} from "@/features/md-editor/preview/scroll-sync";
import { Toolbar } from "@/features/md-editor/toolbar/toolbar";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { interfaceFontStack } from "@/lib/fonts/stack";
import { cn } from "@/lib/utils";
import { StatusBar } from "./status-bar";
import { TabBar } from "./tab-bar";
import {
  confirmDiscardAll,
  getTabScrollTop,
  useMdEditorStore,
  type MdPromptChoice,
  type MdPromptRequest,
} from "./store";
import type { MdCursor, ViewMode } from "./types";

const VIEW_MODES: ViewMode[] = ["read", "source", "split"];

/** How long a sync-driven scroll is ignored on the other side, to stop ping-pong. */
const SYNC_LOCK_MS = 120;

/** Heading whose section contains `line` (1-based), or null before the first one. */
function headingAt(headings: OutlineHeading[], line: number): string | null {
  let current: string | null = null;
  for (const heading of headings) {
    if (heading.line + 1 > line) break;
    current = heading.id;
  }
  return current;
}

function ViewSwitcher(props: {
  mode: ViewMode;
  disabled: boolean;
  onChange(mode: ViewMode): void;
}) {
  const { t } = useAppTranslation();
  const labels: Record<ViewMode, string> = {
    read: t("mdEditor.view.read"),
    source: t("mdEditor.view.source"),
    split: t("mdEditor.view.split"),
  };

  return (
    <div className="bg-muted flex items-center gap-0.5 rounded-md p-0.5" role="group">
      {VIEW_MODES.map((mode) => (
        <button
          key={mode}
          type="button"
          disabled={props.disabled}
          aria-pressed={props.mode === mode}
          onClick={() => props.onChange(mode)}
          className={cn(
            "rounded-sm px-2 py-0.5 text-xs",
            props.mode === mode
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
            props.disabled && "pointer-events-none opacity-50"
          )}
        >
          {labels[mode]}
        </button>
      ))}
    </div>
  );
}

function EmptyState() {
  const { t } = useAppTranslation();
  const recent = useMdEditorStore((state) => state.recent);
  const newUntitled = useMdEditorStore((state) => state.newUntitled);
  const openPicker = useMdEditorStore((state) => state.openPicker);
  const openFile = useMdEditorStore((state) => state.openFile);

  return (
    <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 p-8 text-center">
      <span className="bg-muted text-muted-foreground rounded-lg p-2.5">
        <FileText className="size-5" />
      </span>
      <div>
        <p className="text-sm font-medium">{t("mdEditor.empty.title")}</p>
        <p className="text-muted-foreground mt-1 max-w-md text-xs">
          {t("mdEditor.empty.description")}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={() => void openPicker()}>
          {t("mdEditor.empty.open")}
        </Button>
        <Button size="sm" variant="outline" onClick={newUntitled}>
          {t("mdEditor.empty.new")}
        </Button>
      </div>
      {recent.length > 0 && (
        <div className="mt-4 w-full max-w-sm text-left">
          <p className="text-muted-foreground mb-1 px-2 text-xs">{t("mdEditor.empty.recent")}</p>
          <ul className="space-y-0.5">
            {recent.slice(0, 5).map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  disabled={entry.missing}
                  title={
                    entry.missing ? t("mdEditor.error.notFound", { path: entry.path }) : entry.path
                  }
                  onClick={() => void openFile(entry.path)}
                  className="hover:bg-accent/50 w-full truncate rounded-sm px-2 py-1 text-xs disabled:opacity-50"
                >
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function PromptDialog(props: { prompt: MdPromptRequest; onAnswer(choice: MdPromptChoice): void }) {
  const { t } = useAppTranslation();

  const { prompt, onAnswer } = props;
  const unsaved = prompt.kind === "unsaved";

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onAnswer(unsaved ? "cancel" : "discard");
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {unsaved ? t("mdEditor.tab.unsavedTitle") : t("mdEditor.error.conflictExternalChange")}
          </DialogTitle>
          <DialogDescription>
            {t(
              unsaved
                ? "mdEditor.dialog.unsavedDescription"
                : "mdEditor.dialog.conflictDescription",
              {
                name: prompt.name,
              }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          {unsaved ? (
            <>
              <Button variant="outline" onClick={() => onAnswer("cancel")}>
                {t("mdEditor.dialog.cancel")}
              </Button>
              <Button variant="destructive" onClick={() => onAnswer("discard")}>
                {t("mdEditor.dialog.discard")}
              </Button>
              <Button onClick={() => onAnswer("save")}>{t("mdEditor.dialog.save")}</Button>
            </>
          ) : (
            <>
              <Button variant="outline" onClick={() => onAnswer("discard")}>
                {t("mdEditor.dialog.discard")}
              </Button>
              <Button variant="outline" onClick={() => onAnswer("saveAs")}>
                {t("mdEditor.dialog.saveAs")}
              </Button>
              <Button variant="destructive" onClick={() => onAnswer("overwrite")}>
                {t("mdEditor.dialog.overwrite")}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The Markdown editor page: tabs, the CodeMirror host and the reading pane. */
export default function MdEditorPage() {
  const tabs = useMdEditorStore((state) => state.tabs);
  const activeId = useMdEditorStore((state) => state.activeId);
  const settings = useMdEditorStore((state) => state.settings);
  const recent = useMdEditorStore((state) => state.recent);
  const savingIds = useMdEditorStore((state) => state.savingIds);
  const prompt = useMdEditorStore((state) => state.prompt);

  const openFile = useMdEditorStore((state) => state.openFile);
  const closeTab = useMdEditorStore((state) => state.closeTab);
  const setContent = useMdEditorStore((state) => state.setContent);
  const setViewMode = useMdEditorStore((state) => state.setViewMode);
  const setCursor = useMdEditorStore((state) => state.setCursor);
  const setScrollTop = useMdEditorStore((state) => state.setScrollTop);
  const setSplitRatio = useMdEditorStore((state) => state.setSplitRatio);
  const answerPrompt = useMdEditorStore((state) => state.answerPrompt);

  const activeTab = tabs.find((tab) => tab.id === activeId) ?? null;
  const activeTabId = activeTab?.id ?? null;
  const mode = activeTab?.viewMode ?? settings.view.defaultMode;
  const saving = activeTabId ? savingIds[activeTabId] === true : false;
  const content = activeTab?.content ?? "";
  const docPath = activeTab?.path ?? null;

  const tooLarge = useMemo(() => isDocumentTooLarge(content), [content]);

  // Rendering is pure, so the HTML follows the buffer; in source mode there is
  // nothing to see, and rendering on every keystroke would be wasted work.
  const html = useMemo(() => {
    if (mode === "source" || tooLarge) return "";
    return renderMarkdown(content, { docPath });
  }, [content, docPath, mode, tooLarge]);

  const headings = useMemo(() => extractHeadings(content), [content]);
  const cursorLine = activeTab?.cursor.line ?? 1;
  const activeHeadingId = useMemo(() => headingAt(headings, cursorLine), [headings, cursorLine]);

  const previewStyle = useMemo<CSSProperties>(
    () =>
      ({
        maxWidth: settings.appearance.contentWidth,
        fontFamily: settings.appearance.fontFamily || undefined,
        fontSize: settings.appearance.fontSize,
        lineHeight: settings.appearance.lineHeight,
        "--md-code-font": settings.appearance.codeFontFamily || undefined,
      }) as CSSProperties,
    [settings.appearance]
  );

  // The editor theme reads its typography from these variables; setting them on
  // the wrapper lets CodeMirror's own stylesheet pick them up by inheritance.
  const editorStyle = useMemo<CSSProperties>(
    () =>
      ({
        "--md-editor-font-family": settings.appearance.fontFamily
          ? interfaceFontStack(settings.appearance.fontFamily)
          : undefined,
        "--md-editor-font-size": `${settings.appearance.fontSize}px`,
        "--md-editor-line-height": String(settings.appearance.lineHeight),
      }) as CSSProperties,
    [settings.appearance]
  );

  const groupRef = useRef<GroupImperativeHandle | null>(null);
  const closingRef = useRef(false);
  const previewRef = useRef<HTMLDivElement | null>(null);
  const samplesRef = useRef<ScrollSample[]>([]);
  /** Timestamps of the last programmatic scroll in each direction. */
  const syncRef = useRef({ editor: 0, preview: 0 });

  const rebuildSamples = useCallback(() => {
    const container = previewRef.current;
    samplesRef.current = container ? buildSamples(container) : [];
  }, []);

  // The sample points go stale whenever the rendered blocks change, the view
  // mode changes the pane width, or images push the content down.
  useEffect(() => {
    rebuildSamples();
  }, [html, mode, rebuildSamples]);

  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    container.addEventListener(ASSETS_RESOLVED_EVENT, rebuildSamples);
    return () => container.removeEventListener(ASSETS_RESOLVED_EVENT, rebuildSamples);
  }, [rebuildSamples, activeTabId]);

  useEffect(() => {
    const container = previewRef.current;
    if (!container) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(rebuildSamples);
    });
    observer.observe(container);
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rebuildSamples, activeTabId]);

  const handleEditorScroll = (top: number) => {
    if (!activeTab) return;
    // The hidden editor reports a zero offset when read mode collapses it.
    if (mode !== "read") setScrollTop(activeTab.id, top);
    if (mode !== "split") return;

    const now = Date.now();
    if (now - syncRef.current.preview < SYNC_LOCK_MS) return;
    const container = previewRef.current;
    const samples = samplesRef.current;
    const view = getActiveView();
    if (!container || !view || samples.length === 0) return;

    const block = view.lineBlockAtHeight(top);
    const line = view.state.doc.lineAt(block.from).number - 1;
    syncRef.current.editor = now;
    container.scrollTop = computeTarget(samples, line);
  };

  const handlePreviewScroll = () => {
    if (mode !== "split" || !activeTab) return;

    const now = Date.now();
    if (now - syncRef.current.editor < SYNC_LOCK_MS) return;
    const container = previewRef.current;
    const samples = samplesRef.current;
    const view = getActiveView();
    if (!container || !view || samples.length === 0) return;

    const line = computeLine(samples, container.scrollTop);
    const target = view.state.doc.line(Math.min(Math.max(line + 1, 1), view.state.doc.lines)).from;
    syncRef.current.preview = now;
    view.dispatch({ effects: EditorView.scrollIntoView(target, { y: "start" }) });
  };

  const handleJump = (line: number, id: string) => {
    const view = getActiveView();
    if (view) {
      const target = view.state.doc.line(
        Math.min(Math.max(line + 1, 1), view.state.doc.lines)
      ).from;
      // Read mode collapses the editor; move the caret without scrolling it.
      view.dispatch({ selection: { anchor: target }, scrollIntoView: mode !== "read" });
      if (mode !== "read") view.focus();
    }

    // Both panes move on purpose; the scroll events that follow are our own.
    syncRef.current.editor = Date.now();
    syncRef.current.preview = Date.now();
    const heading = previewRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    heading?.scrollIntoView({ block: "start" });
  };

  // Captured during render so the restore effect below still sees the stored
  // caret after the editor's own state swap reported a transient position.
  const cursorSnapshotRef = useRef<{ id: string; cursor: MdCursor } | null>(null);
  cursorSnapshotRef.current = activeTab ? { id: activeTab.id, cursor: activeTab.cursor } : null;

  const initialLayoutRef = useRef<Layout | null>(null);
  if (initialLayoutRef.current === null) {
    const ratio = settings.view.splitRatio * 100;
    initialLayoutRef.current = { editor: ratio, preview: 100 - ratio };
  }

  const handleCommand = useCallback((command: MdFileCommand) => {
    const state = useMdEditorStore.getState();
    const id = state.activeId;
    switch (command) {
      case "save":
        if (id) void state.save(id);
        break;
      case "saveAs":
        if (id) void state.saveAs(id);
        break;
      case "open":
        void state.openPicker();
        break;
      case "new":
        state.newUntitled();
        break;
      case "close":
        if (id) void state.closeTab(id);
        break;
    }
  }, []);

  // The settings are edited in the settings window, and the store outlives this
  // page: re-read them on every mount, and again whenever that window writes a
  // new set, so a change reaches an already-open editor without a restart.
  useEffect(() => {
    const store = useMdEditorStore.getState();
    void store.bootstrap().then(() => store.loadSettings());

    let disposed = false;
    let unlisten: (() => void) | undefined;
    void listen("md-editor-settings-changed", () => {
      void useMdEditorStore.getState().loadSettings();
    }).then((fn) => {
      if (disposed) fn();
      else unlisten = fn;
    });

    return () => {
      disposed = true;
      unlisten?.();
      void useMdEditorStore.getState().flushSession();
    };
  }, []);

  // Closing the window asks about every dirty tab first; cancelling any of them
  // keeps the window open with all buffers intact.
  useEffect(() => {
    const appWindow = getCurrentWindow();
    let unlisten: (() => void) | undefined;
    let disposed = false;

    void appWindow
      .onCloseRequested(async (event) => {
        if (closingRef.current) return;
        const state = useMdEditorStore.getState();
        const dirty = state.tabs.some((tab) => tab.content !== tab.savedContent);
        if (!dirty) {
          await state.flushSession();
          return;
        }

        event.preventDefault();
        closingRef.current = true;
        try {
          const proceed = await confirmDiscardAll();
          if (!proceed) return;
          await useMdEditorStore.getState().flushSession();
          await appWindow.destroy();
        } finally {
          closingRef.current = false;
        }
      })
      .then((fn) => {
        if (disposed) fn();
        else unlisten = fn;
      });

    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // The split follows the view mode: the editor is collapsed in read mode and
  // the preview in source mode, without either being unmounted.
  useEffect(() => {
    const handle = groupRef.current;
    if (!handle) return;
    const ratio = settings.view.splitRatio * 100;
    if (mode === "read") handle.setLayout({ editor: 0, preview: 100 });
    else if (mode === "source") handle.setLayout({ editor: 100, preview: 0 });
    else handle.setLayout({ editor: ratio, preview: 100 - ratio });
  }, [mode, settings.view.splitRatio]);

  // Restore the caret and the scroll offset whenever the active tab changes.
  useEffect(() => {
    const snapshot = cursorSnapshotRef.current;
    if (!snapshot) return;
    const view = getActiveView();
    if (!view) return;

    const doc = view.state.doc;
    const line = doc.line(Math.min(Math.max(snapshot.cursor.line, 1), doc.lines));
    const head = Math.min(line.from + Math.max(snapshot.cursor.column - 1, 0), line.to);
    view.dispatch({ selection: { anchor: head }, scrollIntoView: false });
    view.scrollDOM.scrollTop = getTabScrollTop(snapshot.id);
  }, [activeTabId, mode]);

  const handleLayoutChanged = (layout: Layout, meta: LayoutChangedMeta) => {
    if (mode !== "split" || !meta.isUserInteraction) return;
    const ratio = layout.editor;
    if (typeof ratio !== "number" || ratio <= 5 || ratio >= 95) return;
    setSplitRatio(ratio / 100);
  };

  return (
    <AppShell>
      <div className="@container flex h-full min-h-0 w-full min-w-0 flex-1 flex-col">
        <TabBar
          tabs={tabs}
          activeId={activeId}
          recent={recent}
          onSelect={(id) => useMdEditorStore.getState().setActive(id)}
          onClose={(id) => void closeTab(id)}
          onNew={() => useMdEditorStore.getState().newUntitled()}
          onOpen={() => void useMdEditorStore.getState().openPicker()}
          onOpenRecent={(path) => void openFile(path)}
        >
          <ViewSwitcher
            mode={mode}
            disabled={!activeTab}
            onChange={(next) => {
              if (activeTab) setViewMode(activeTab.id, next);
            }}
          />
        </TabBar>

        <div className="flex shrink-0 items-stretch">
          <div className="min-w-0 flex-1">
            <Toolbar />
          </div>
          <div className="bg-background flex items-center border-b px-2">
            <ExportMenu />
          </div>
        </div>

        <div className="flex min-h-0 flex-1">
          {activeTab && settings.view.outlineVisible && (
            // The outline yields to the panes: clamped to the page's width, and
            // dropped entirely once the page is too narrow to share.
            <aside
              className="min-w-0 shrink-0 overflow-hidden border-r @max-[720px]:hidden"
              style={{ width: `min(${settings.view.outlineWidth}px, 40%)` }}
            >
              <OutlinePanel headings={headings} activeId={activeHeadingId} onJump={handleJump} />
            </aside>
          )}
          {activeTab ? (
            <div className="min-h-0 min-w-0 flex-1">
              <Group
                id="md-editor-split"
                className="h-full"
                groupRef={groupRef}
                defaultLayout={initialLayoutRef.current}
                onLayoutChanged={handleLayoutChanged}
              >
                <Panel id="editor" minSize="0" className="h-full min-w-0 overflow-hidden">
                  <div
                    className={cn("h-full min-h-0", mode === "read" && "hidden")}
                    style={editorStyle}
                  >
                    <EditorContextMenu>
                      <CmHost
                        docKey={activeTab.id}
                        doc={activeTab.content}
                        readOnly={mode === "read"}
                        onChange={(value) => setContent(activeTab.id, value)}
                        onCursor={(cursor) => setCursor(activeTab.id, cursor)}
                        onScroll={handleEditorScroll}
                        behavior={settings.behavior}
                        onCommand={handleCommand}
                      />
                    </EditorContextMenu>
                  </div>
                </Panel>
                <Separator disabled={mode !== "split"} className="bg-border w-px" />
                <Panel id="preview" minSize="0" className="h-full min-w-0 overflow-hidden">
                  <div className={cn("h-full min-h-0", mode === "source" && "hidden")}>
                    <div
                      ref={previewRef}
                      onScroll={handlePreviewScroll}
                      className="h-full overflow-auto"
                    >
                      <div className="mx-auto px-8 py-6" style={previewStyle}>
                        <PreviewContextMenu>
                          <PreviewPane html={html} docPath={docPath} tooLarge={tooLarge} />
                        </PreviewContextMenu>
                      </div>
                    </div>
                  </div>
                </Panel>
              </Group>
            </div>
          ) : (
            <EmptyState />
          )}
        </div>

        <StatusBar tab={activeTab} saving={saving} />

        {prompt && <PromptDialog key={prompt.id} prompt={prompt} onAnswer={answerPrompt} />}
      </div>
    </AppShell>
  );
}
