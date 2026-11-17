import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Code2, RotateCw } from "lucide-react";
import { toast } from "sonner";
import {
  codegBrowserApplyTheme,
  codegBrowserClose,
  codegBrowserDevtools,
  codegBrowserNavigate,
  codegBrowserOpen,
  codegBrowserReload,
  codegBrowserSetBounds,
  codegBrowserSetVisible,
  codegBrowserUrl,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { resolveMode, useTheme } from "@/components/theme-provider";
import { DEV_BUILD } from "@/lib/dev-flag";
import { DOCUMENT_ID, newRunId } from "@/lib/document-id";
import { buildCodegTheme } from "@/lib/codeg/theme";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** How often to ask the page where it is. */
const URL_POLL_INTERVAL = 400;

/** How long to wait for a burst of appearance changes to settle. */
const THEME_DEBOUNCE = 100;

/** Emitted by the backend when the page asks for an address it may not open. */
const EXTERNAL_LINK_EVENT = "codeg-external-link";

/** The path of an address, or `null` when it cannot be read. */
function pathOf(address: string): string | null {
  try {
    return new URL(address).pathname;
  } catch {
    return null;
  }
}

/**
 * Codeg's own page, as a **native webview** inside this window.
 *
 * The page is not an iframe: it is a whole app with its own router, and the app's
 * tab bar stands in for the browser tabs it would otherwise ask for. That makes
 * this component a thin shell around one webview — the same one for the window's
 * whole life, moved and shown rather than recreated:
 *
 * 1. **Reserves the space.** The placeholder keeps the layout honest, and its
 *    measured rectangle is where the webview is moved. It is re-measured on
 *    anything that moves it: a window resize, a sidebar collapse, a scroll.
 * 2. **Says when it is hidden.** CSS cannot hide an OS-level view, so a page that
 *    went off screen (an inactive tab, a cached page behind another) has to say
 *    so, or it would stay painted over whatever came next.
 * 3. **Reports where the page went.** Codeg navigates with its own router, which
 *    the host is not told about, so the address is polled; `onRoute` is what turns
 *    it into a tab.
 * 4. **Follows the app's appearance.** The palette is read from the document and
 *    pushed into the page's storage, so light/dark and the colour preset follow
 *    without a reload.
 */
export function CodegBrowser({
  route,
  active,
  onRoute,
  host,
}: {
  /** The Codeg route this pane should show. */
  route: string;
  /** Whether this pane is the one on screen. */
  active: boolean;
  /** Called with the path the page is actually on. */
  onRoute: (path: string) => void;
  /**
   * Label of the window this pane lives in. The native webview is attached to
   * that window; defaults to the window that rendered this component.
   */
  host?: string;
}) {
  const { t } = useAppTranslation();
  const { theme, preset } = useTheme();
  const [hostLabel] = useState(() => host ?? getCurrentWebviewWindow().label);
  const slot = useRef<HTMLDivElement>(null);
  // Nothing is placed or polled until the webview exists, so a failed open does
  // not turn into a stream of errors against a page that was never created.
  const [opened, setOpened] = useState(false);
  // The route this component last asked for, so the poll does not report it back
  // as a navigation the user made.
  const asked = useRef(route);
  const reported = useRef<string | null>(null);

  const visible = active;

  /** Sends the placeholder's current rectangle to the webview. */
  const syncBounds = useCallback(() => {
    const element = slot.current;
    if (!element || !opened) return;

    const rect = element.getBoundingClientRect();
    void codegBrowserSetBounds(hostLabel, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }).catch((error: unknown) => console.error("Failed to place the Codeg page:", error));
  }, [hostLabel, opened]);

  // Open the page once per host, and take it down when this pane goes away.
  useEffect(() => {
    let cancelled = false;
    const rect = slot.current?.getBoundingClientRect();
    // Identifies this run of the effect, and with it this page's ownership on the
    // backend. React runs the effect again on a remount and on a development
    // build's double-invoke; that second run reopens the page and claims it, and
    // the close below is scoped to this run so the older cleanup cannot take down
    // the page the newer run is showing.
    const run = newRunId();

    codegBrowserOpen(
      hostLabel,
      DOCUMENT_ID,
      run,
      asked.current,
      {
        x: rect?.left ?? 0,
        y: rect?.top ?? 0,
        width: rect?.width ?? 1,
        height: rect?.height ?? 1,
      },
      // Read now rather than from the render: the mode class and the preset's
      // variables are applied by a layout effect, so only an effect sees them.
      buildCodegTheme(preset, resolveMode(theme))
    )
      .then(() => {
        if (!cancelled) setOpened(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to open the Codeg page:", error);
        toast.error(t("codeg.page.openFailed", { message: String(error) }));
      });

    return () => {
      cancelled = true;
      setOpened(false);
      reported.current = null;
      void codegBrowserClose(hostLabel, DOCUMENT_ID, run).catch((error: unknown) =>
        console.error("Failed to close the Codeg page:", error)
      );
    };
  }, [hostLabel]); // eslint-disable-line react-hooks/exhaustive-deps -- open once per host

  // Keep the page where the placeholder is. The observer catches layout changes
  // (window resize, sidebar collapse); the scroll listener catches the pane being
  // scrolled, which does not resize anything.
  useEffect(() => {
    const element = slot.current;
    if (!element) return;

    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(syncBounds);
    };

    const observer = new ResizeObserver(schedule);
    observer.observe(element);
    window.addEventListener("resize", schedule);
    document.addEventListener("scroll", schedule, true);

    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener("resize", schedule);
      document.removeEventListener("scroll", schedule, true);
    };
  }, [syncBounds]);

  // Show and move only while this pane is the one on screen. Runs again once the
  // page exists, because until the open call has answered there is nothing to
  // show or hide.
  useEffect(() => {
    if (!opened) return;

    void codegBrowserSetVisible(hostLabel, visible).catch((error: unknown) =>
      console.error("Failed to show or hide the Codeg page:", error)
    );
    if (visible) syncBounds();
  }, [hostLabel, visible, opened, syncBounds]);

  // Report where the page is. A client-side router moving between routes is not
  // something the host is told about, so this is a poll.
  useEffect(() => {
    if (!visible || !opened) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const current = await codegBrowserUrl(hostLabel);
        if (cancelled) return;
        const path = pathOf(current);
        if (!path || path === reported.current) return;
        reported.current = path;
        onRoute(path);
      } catch (error) {
        // The page can be closed under us while a tab is switching; that is not
        // worth reporting.
        console.debug("Could not read the Codeg address:", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), URL_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostLabel, visible, opened, onRoute]);

  // Go where the pane's tab says, without reloading the page: it is the same
  // Codeg, and its own router is what moves it.
  useEffect(() => {
    if (!opened || route === asked.current) return;
    asked.current = route;

    void codegBrowserNavigate(hostLabel, route).catch((error: unknown) => {
      console.error("Codeg navigation failed:", error);
      toast.error(String(error));
    });
  }, [hostLabel, route, opened]);

  // Follow the app's light/dark mode and colour preset. Debounced: a preset
  // switch writes a couple of dozen variables, and the page should be told once.
  useEffect(() => {
    if (!opened) return;

    const timer = setTimeout(() => {
      void codegBrowserApplyTheme(hostLabel, buildCodegTheme(preset, resolveMode(theme))).catch(
        (error: unknown) => console.error("Failed to repaint the Codeg page:", error)
      );
    }, THEME_DEBOUNCE);
    return () => clearTimeout(timer);
  }, [hostLabel, opened, preset, theme]);

  // A link to somewhere else is the user's browser's business: the page may not
  // leave the Codeg origin, so the backend reports those attempts here.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void listen<string>(EXTERNAL_LINK_EVENT, (event) => {
      void openUrl(event.payload).catch((error: unknown) =>
        toast.error(t("codeg.page.openLinkFailed", { message: String(error) }))
      );
    }).then((dispose) => {
      if (cancelled) dispose();
      else unlisten = dispose;
    });

    return () => {
      cancelled = true;
      if (unlisten) unlisten();
    };
  }, [t]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="bg-muted/20 flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          title={t("codeg.page.reload")}
          disabled={!visible}
          onClick={() =>
            void codegBrowserReload(hostLabel).catch((error: unknown) => toast.error(String(error)))
          }
        >
          <RotateCw className="size-3.5" />
        </Button>

        {/* Dev-only, like the window menu's entry: the page is an OS-level view
            with no DOM the app can read, so its inspector is the only way to see
            what the embedded Codeg is holding. */}
        {DEV_BUILD && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-1.5"
            title={t("codeg.page.devtools")}
            disabled={!visible}
            onClick={() =>
              void codegBrowserDevtools(hostLabel).catch((error: unknown) =>
                toast.error(String(error))
              )
            }
          >
            <Code2 className="size-3.5" />
          </Button>
        )}

        <span className="text-muted-foreground truncate px-1 font-mono text-[11px]">{route}</span>
      </div>

      {/* The space the webview is moved onto. The app draws nothing here — the
          native view covers it — but its box is what the placement is measured
          from, so it has to be laid out like any other pane content. */}
      <div ref={slot} className="min-h-0 flex-1" />
    </div>
  );
}
