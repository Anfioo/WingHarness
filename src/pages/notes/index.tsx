import { useEffect, useRef, useState } from "react";
import { Loader2, NotebookPen } from "lucide-react";
import { FileSystem, Workbench } from "codelet/workbench";
import { extensions as extensionsView } from "codelet/extensions/extensions";
import { markdownPreview } from "codelet/extensions/markdown";
import { search } from "codelet/extensions/search";
import { AppShell } from "@/components/app-shell";
import { PreviewOverlay } from "@/components/file-preview/preview-overlay";
import { notesWrite } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { codeletStrings, createDomTranslator, localizeExtensions } from "@/lib/editor/codelet-i18n";
import { createPreviewExtension, type PreviewOpenEvent } from "@/lib/editor/preview-extension";
import { useEditorAppearance } from "@/lib/editor/use-editor-appearance";
import { EDITOR_SURFACE_CLASS } from "@/lib/editor/typography";
import { loadWorkspace, startSync } from "./store";

/** Opens with one note so the first run is not a blank rectangle. */
const WELCOME_PATH = "/welcome.md";
const WELCOME_CONTENT = `# 欢迎使用笔记

这是一个 Markdown 笔记工作区，左侧是文件树，右侧是标签页编辑器，底部与右侧面板都可以拖拽调整。

- 新建笔记：文件树顶部的「新建文件」
- 重命名 / 删除：右键点文件
- 命令面板：\`Ctrl/Cmd + Shift + P\`
- 保存：\`Ctrl/Cmd + S\`

内容会自动写入数据目录的 \`notes\` 文件夹，是普通的 \`.md\` 文件。
`;

export default function NotesPage() {
  const { t, language } = useAppTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const workbenchRef = useRef<Workbench | null>(null);
  // The filesystem outlives the workbench: `extensions` is a mount-time option,
  // so turning the Extensions view on or off rebuilds the shell — and the open
  // tabs and unsaved buffers have to survive that.
  const fsRef = useRef<FileSystem | null>(null);
  const openRef = useRef<string[]>([]);
  const activeRef = useRef<string | null>(null);
  const { theme, prefs } = useEditorAppearance();
  const [ready, setReady] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  // The tab whose file the preview is covering the editor with, if any. Notes are Markdown
  // and stay text, so this is normally null — it is here so the two editors behave alike.
  const [preview, setPreview] = useState<PreviewOpenEvent | null>(null);

  if (!fsRef.current) fsRef.current = new FileSystem();

  // Load once: a remount — from the Extensions toggle, or a language change —
  // must not re-read disk over the buffers in memory.
  useEffect(() => {
    const fs = fsRef.current;
    if (!fs) return;
    let disposed = false;

    const init = async () => {
      try {
        await loadWorkspace(fs);
      } catch (err) {
        console.error("notes load:", err);
        if (!disposed) setLoadFailed(true);
        return;
      }
      if (disposed) return;

      const firstNote = fs.files()[0];
      if (!firstNote) {
        // First run: seed a welcome note before mounting so it opens as a tab
        // rather than appearing only after a manual refresh. Written to disk
        // now too — the reconciler would only land it after an edit.
        fs.write(WELCOME_PATH, WELCOME_CONTENT);
        await notesWrite(WELCOME_PATH, WELCOME_CONTENT);
      }
      openRef.current = fs.files().slice(0, 1);
      activeRef.current = openRef.current[0] ?? null;
      setReady(true);
    };

    void init();
    const unsubscribeSync = startSync(fs);
    return () => {
      disposed = true;
      unsubscribeSync();
    };
  }, []);

  // Mount the shell once the notes are loaded, and again whenever the extension
  // set or the language changes — mount-time options both, so a rebuild is the
  // only way to change either.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !ready || !fsRef.current) return;

    const fs = fsRef.current;
    const strings = codeletStrings(language);
    const extensions = [
      search,
      ...(prefs.extensionsView ? [extensionsView] : []),
      markdownPreview,
      createPreviewExtension({
        displayName: t("filePreview.title"),
        onOpen: setPreview,
        onClose: (path) => setPreview((current) => (current?.path === path ? null : current)),
      }),
    ];
    const workbench = new Workbench({
      parent: host,
      fs,
      theme,
      open: openRef.current,
      active: activeRef.current ?? undefined,
      onOpen: (open, active) => {
        openRef.current = open;
        activeRef.current = active;
      },
      extensions: localizeExtensions(extensions, strings),
    });
    workbenchRef.current = workbench;
    // What the extensions did not contribute — menus, placeholders, the status
    // bar — is rewritten in place for as long as the shell stands.
    const domTranslator = strings ? createDomTranslator(host, strings) : null;
    return () => {
      domTranslator?.dispose();
      workbench.destroy();
      workbenchRef.current = null;
      setPreview(null);
    };
    // `theme` is applied by the effect below, so it is deliberately not a
    // dependency here — it would remount the shell on every light/dark flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only on the extension set
  }, [ready, prefs.extensionsView, language]);

  // The theme may resolve after the workbench mounts (the app's dark class is
  // applied in a provider effect) and changes again on a settings edit.
  useEffect(() => {
    workbenchRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <AppShell>
      <section className="border-border relative flex h-full min-h-[60vh] flex-1 flex-col overflow-hidden rounded-xl border">
        {/* Mounted always so the ref is set before init runs; the workbench
            fills it once the notes have loaded. `editor-surface` is what the
            typography override attaches to. */}
        <div ref={hostRef} className={`min-h-0 flex-1 ${EDITOR_SURFACE_CLASS}`} />
        {(!ready || loadFailed) && (
          <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
            {loadFailed ? (
              <>
                <NotebookPen className="text-muted-foreground size-6" />
                <p className="text-destructive">{t("notes.loadFailed")}</p>
              </>
            ) : (
              <>
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
                <span className="text-muted-foreground">{t("notes.loading")}</span>
              </>
            )}
          </div>
        )}
        {preview && <PreviewOverlay target={preview} />}
      </section>
    </AppShell>
  );
}
