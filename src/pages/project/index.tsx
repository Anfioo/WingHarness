import { useEffect, useRef, useState } from "react";
import { FolderKanban, Loader2 } from "lucide-react";
import { Workbench } from "codelet/workbench";
import { remote } from "codelet/extensions/remote";
import { extensions as extensionsView } from "codelet/extensions/extensions";
import { markdownPreview } from "codelet/extensions/markdown";
import { search } from "codelet/extensions/search";
import { getConfig } from "@/commands";
import { AppShell } from "@/components/app-shell";
import { PreviewOverlay } from "@/components/file-preview/preview-overlay";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { codeletStrings, createDomTranslator, localizeExtensions } from "@/lib/editor/codelet-i18n";
import { createPreviewExtension, type PreviewOpenEvent } from "@/lib/editor/preview-extension";
import { useEditorAppearance } from "@/lib/editor/use-editor-appearance";
import { createProjectTransport } from "@/lib/editor/project-transport";
import { EDITOR_SURFACE_CLASS } from "@/lib/editor/typography";

/**
 * The project, opened as an editor.
 *
 * The same codelet `Workbench` the notes page mounts, with one difference that
 * matters: the files come from `codelet/extensions/remote` reading on demand
 * rather than from an in-memory filesystem loaded up front. A project can hold
 * `.git`, `node_modules` and build output — far too much to read into a page —
 * so the tree is fetched one level at a time, and `.git` is never served.
 *
 * The root is whatever `workspace.root` holds, resolved and confined in Rust;
 * this page neither knows nor checks the path. With no root configured there is
 * nothing to open, so the page says so instead of mounting the shell.
 */
export default function ProjectPage() {
  const { t, language } = useAppTranslation();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const workbenchRef = useRef<Workbench | null>(null);
  const { theme, prefs } = useEditorAppearance();
  // `null` until the config has been read, then the configured project root —
  // `""` meaning none has been chosen yet.
  const [root, setRoot] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The tab whose file the preview is covering the editor with, if any.
  const [preview, setPreview] = useState<PreviewOpenEvent | null>(null);

  // Whether there is a project at all is a question for the config rather than
  // for the transport: with no root, the transport's own failure reads as a
  // broken page instead of as nothing having been chosen yet.
  useEffect(() => {
    let disposed = false;
    void getConfig()
      .then(({ config }) => {
        if (!disposed) setRoot(config.workspace.root.trim());
      })
      .catch((err) => {
        console.error("project config:", err);
        if (!disposed) setError(t("projectPage.openFailed"));
      });
    return () => {
      disposed = true;
    };
  }, [t]);

  // Mount the shell once, and again when the Extensions view is toggled or the
  // language changes — both the extension set and the shell's wording are
  // mount-time options, and only a rebuild can change either. The remote
  // extension re-reads the tree on each mount, so no unsaved state is lost by
  // the rebuild.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    // Still reading the config, or there is no project to read from.
    if (!root) return;

    let disposed = false;
    let domTranslator: { dispose: () => void } | null = null;
    const transport = createProjectTransport();
    const extensions = [
      search,
      ...(prefs.extensionsView ? [extensionsView] : []),
      markdownPreview,
      remote({
        url: "tauri://project",
        transport,
        // The project's own `.git` is never served, matching the backend.
        exclude: [".git"],
        // Names on expand, bodies on open — the lazy end of the protocol.
        preload: "none",
        watch: false,
      }),
      // Formats the text editor can only render as gibberish are claimed here, and their
      // tabs become a preview drawn by the host instead — see `preview-extension`.
      createPreviewExtension({
        displayName: t("filePreview.title"),
        onOpen: setPreview,
        onClose: (path) => setPreview((current) => (current?.path === path ? null : current)),
      }),
    ];
    // Nothing to translate in English, and then the extensions go in as they
    // came — which is what keeps the untranslated page free of copies.
    const strings = codeletStrings(language);

    try {
      const workbench = new Workbench({
        parent: host,
        theme,
        extensions: localizeExtensions(extensions, strings),
      });
      workbenchRef.current = workbench;
      // Started after the shell is up: what the extensions did not contribute —
      // menus, placeholders, the status bar — is rewritten in place, and stays
      // rewritten for as long as the shell stands.
      domTranslator = strings ? createDomTranslator(host, strings) : null;
      setReady(true);
    } catch (err) {
      console.error("project mount:", err);
      if (!disposed) setError(t("projectPage.openFailed"));
    }

    return () => {
      disposed = true;
      domTranslator?.dispose();
      workbenchRef.current?.destroy();
      workbenchRef.current = null;
      // The shell took the panels down with it; the overlay it was covering must not
      // outlive the tab it belonged to.
      setPreview(null);
    };
    // `theme` is applied by the effect below, so it is deliberately not a
    // dependency — it would remount the shell on every light/dark flip.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remount only on the extension set
  }, [root, prefs.extensionsView, language, t]);

  // The theme may resolve after the workbench mounts (the app's dark class is
  // applied in a provider effect) and changes again on a settings edit.
  useEffect(() => {
    workbenchRef.current?.setTheme(theme);
  }, [theme]);

  return (
    <AppShell>
      <section className="border-border relative flex h-full min-h-[60vh] flex-1 flex-col overflow-hidden rounded-xl border">
        {/* Mounted always so the ref is set before the workbench builds.
            `editor-surface` is what the typography override attaches to. */}
        <div ref={hostRef} className={`min-h-0 flex-1 ${EDITOR_SURFACE_CLASS}`} />
        {!ready && (
          <div className="bg-background absolute inset-0 flex flex-col items-center justify-center gap-2 text-sm">
            {error ? (
              <>
                <FolderKanban className="text-muted-foreground size-6" />
                <p className="text-destructive max-w-md text-center">{error}</p>
              </>
            ) : root === "" ? (
              <>
                <FolderKanban className="text-muted-foreground size-6" />
                <p className="max-w-md text-center">{t("projectPage.notConfigured")}</p>
                <p className="text-muted-foreground max-w-md text-center text-xs">
                  {t("projectPage.notConfiguredHint")}
                </p>
              </>
            ) : (
              <>
                <Loader2 className="text-muted-foreground size-4 animate-spin" />
                <span className="text-muted-foreground">{t("projectPage.loading")}</span>
              </>
            )}
          </div>
        )}
        {preview && <PreviewOverlay target={preview} />}
      </section>
    </AppShell>
  );
}
