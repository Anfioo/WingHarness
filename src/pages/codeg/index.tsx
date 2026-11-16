import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { AlertTriangle, Loader2, Play, RotateCw, Square } from "lucide-react";
import { toast } from "sonner";
import {
  codegBrowserCloseAll,
  codegBrowserReload,
  codegSetLanguage,
  codegStart,
  codegState,
  codegStop,
  CODEG_STATUS_EVENT,
  type CodegServerStatus,
  type CodegView,
} from "@/commands";
import { AppShell } from "@/components/app-shell";
import { CodegBrowser } from "@/components/codeg-browser";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { DOCUMENT_ID } from "@/lib/document-id";
import { usePageActive } from "@/lib/page-active";
import { cn } from "@/lib/utils";

/** Where a visit starts: Codeg's chat home. */
const CHAT_HOME = "/workspace";

/** Codeg's own language code for the app's language. */
function codegLanguage(language: string): string {
  return language.startsWith("zh") ? "zh_cn" : "en";
}

export default function CodegPage() {
  const { t, language } = useAppTranslation();
  const [host] = useState(() => getCurrentWebviewWindow().label);
  const [view, setView] = useState<CodegView | null>(null);
  const [busy, setBusy] = useState(false);
  /** The last failure, shown next to the status instead of a spinner forever. */
  const [failure, setFailure] = useState<string | null>(null);
  /** Whether Codeg's stored language has been brought in line with the app's. */
  const [languageReady, setLanguageReady] = useState(false);
  const started = useRef(false);
  /** The language written to Codeg last, so one change is one write. */
  const appliedLanguage = useRef<string | null>(null);
  const pageActive = usePageActive();

  const status: CodegServerStatus = view?.server ?? { status: "stopped" };
  const ready = status.status === "ready";

  /**
   * The tab label for a route: translated where the route is a known one, and the
   * route itself otherwise — a settings section is named by Codeg's own path
   * segment, which is the only wording that exists for it.
   */
  const routeLabel = (path: string): string => {
    if (path === CHAT_HOME) return t("codeg.tabs.chat");
    if (path === "/settings") return t("codeg.tabs.settings");
    if (path.startsWith("/settings/")) {
      return `${t("codeg.tabs.settings")} · ${path.slice("/settings/".length)}`;
    }
    return path;
  };

  /** Brings the server up, reporting why when it will not. */
  const start = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await codegStart();
      setView((current) => (current ? { ...current, server: next } : current));
      if (next.status === "failed") setFailure(next.message);
    } catch (error) {
      console.error("Failed to start the Codeg server:", error);
      setFailure(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  // Read the configuration and the server's state on arrival, and start the
  // server if it is not up: the defaults are meant to just work, so nobody
  // should have to go to the settings window to press a button first.
  useEffect(() => {
    let cancelled = false;

    codegState()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        if (next.server.status === "ready" || started.current) return;
        started.current = true;
        void start();
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to read the Codeg state:", error);
        setFailure(String(error));
      });

    return () => {
      cancelled = true;
    };
  }, [start]);

  // The server can move while this page is on screen — restarted from the
  // settings window, stopped, or a crash. Told rather than polled, so the pane
  // turns into the error instead of keeping a dead server's page on top of it.
  useEffect(() => {
    const unlisten = listen<CodegServerStatus>(CODEG_STATUS_EVENT, (event) => {
      const next = event.payload;
      setView((current) => (current ? { ...current, server: next } : current));
      setFailure(next.status === "failed" ? next.message : null);
    });

    return () => {
      void unlisten.then((stop) => stop());
    };
  }, []);

  // Codeg keeps its language in its own database, so the app's language has to
  // be written there before the page is opened — the page reads it once, at
  // boot. Every language the app moves to reloads whatever page is open.
  useEffect(() => {
    if (!ready) return;
    const target = codegLanguage(language);
    // A re-render must not write the same language twice: the write of the run
    // that got superseded could be the one that lands last.
    if (appliedLanguage.current === target) return;
    appliedLanguage.current = target;

    codegSetLanguage(target)
      .then(() => {
        setLanguageReady(true);
        // Reloaded unconditionally: the codeg page only reads the language at
        // boot, and nothing is open on the first visit, which is not a failure.
        void codegBrowserReload(host).catch((error: unknown) =>
          console.debug("The Codeg page was not open to reload:", error)
        );
      })
      .catch((error: unknown) => {
        appliedLanguage.current = null;
        // The page can still be used — it will just keep its own language.
        console.error("Failed to set the Codeg language:", error);
        toast.error(t("codeg.page.languageFailed", { message: String(error) }));
        setLanguageReady(true);
      });
  }, [ready, language, host, t]);

  // The sidebar navigates with plain links, so leaving this page is a full
  // document load and no React cleanup runs. The page's webview belongs to the
  // window, so without this it would outlive the page that asked for it.
  useEffect(() => {
    const closePages = () =>
      void codegBrowserCloseAll(host, DOCUMENT_ID).catch((error: unknown) =>
        console.error("Failed to close the Codeg page:", error)
      );

    window.addEventListener("pagehide", closePages);
    return () => window.removeEventListener("pagehide", closePages);
  }, [host]);

  // Tabs: one per Codeg route visited, in the order they were visited. The page
  // reports its own route, so opening Codeg's settings from inside adds a tab.
  const [visited, setVisited] = useState<string[]>([CHAT_HOME]);
  const [route, setRoute] = useState(CHAT_HOME);

  const onRoute = useCallback((path: string) => {
    setRoute(path);
    setVisited((current) => (current.includes(path) ? current : [...current, path]));
  }, []);

  const stop = useCallback(async () => {
    setBusy(true);
    setFailure(null);
    try {
      const next = await codegStop();
      setView((current) => (current ? { ...current, server: next } : current));
      setLanguageReady(false);
    } catch (error) {
      console.error("Failed to stop the Codeg server:", error);
      toast.error(String(error));
    } finally {
      setBusy(false);
    }
  }, []);

  const chrome = (
    <section className="flex h-full min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
      <div className="bg-muted/40 flex h-10 shrink-0 items-center gap-1 border-b px-2">
        <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
          {visited.map((path) => (
            <button
              key={path}
              type="button"
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded px-2.5 text-xs transition-colors",
                path === route
                  ? "bg-background font-medium shadow-sm"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground"
              )}
              onClick={() => setRoute(path)}
            >
              <span className="max-w-48 truncate">{routeLabel(path)}</span>
            </button>
          ))}
        </div>

        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          title={t("codeg.page.restart")}
          disabled={busy}
          onClick={() => void start()}
        >
          <RotateCw className={cn("size-3.5", busy && "animate-spin")} />
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          title={t("codeg.page.stop")}
          disabled={busy}
          onClick={() => void stop()}
        >
          <Square className="size-3.5" />
        </Button>
      </div>

      {/* One pane, one webview: moving between tabs navigates the page rather
          than stacking a second copy of Codeg. */}
      <div className="relative min-h-0 flex-1">
        {languageReady ? (
          <CodegBrowser host={host} route={route} active={pageActive} onRoute={onRoute} />
        ) : (
          <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t("codeg.page.loading")}
          </div>
        )}
      </div>
    </section>
  );

  // Not up yet: say what it is doing, and why when it failed. A failure is a
  // configuration mistake more often than not, so the message says where to look.
  if (!ready) {
    const failed = failure !== null || status.status === "failed";
    const message = failure ?? (status.status === "failed" ? status.message : null);
    const running = busy || status.status === "starting";
    const label = failed
      ? t("codeg.page.failed")
      : running
        ? t("codeg.page.starting")
        : t("codeg.page.stopped");

    return (
      <AppShell>
        <section className="border-border flex flex-1 items-center justify-center rounded-lg border border-dashed p-8">
          <div className="max-w-xl space-y-4 text-center">
            <div className="flex items-center justify-center gap-2 text-sm font-medium">
              {failed ? (
                <AlertTriangle className="text-destructive size-4" />
              ) : running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="text-muted-foreground size-4" />
              )}
              {label}
            </div>

            {message && (
              <p className="bg-muted text-muted-foreground max-h-40 overflow-auto rounded-md p-3 text-left font-mono text-[11px] whitespace-pre-wrap">
                {message}
              </p>
            )}

            <p className="text-muted-foreground text-xs">{t("codeg.page.hint")}</p>

            <div className="flex items-center justify-center gap-2">
              <Button size="sm" disabled={busy} onClick={() => void start()}>
                <Play />
                {t("codeg.page.start")}
              </Button>
              {view && (
                <span className="text-muted-foreground font-mono text-[11px]">
                  {view.settings.url}
                </span>
              )}
            </div>
          </div>
        </section>
      </AppShell>
    );
  }

  return <AppShell>{chrome}</AppShell>;
}
