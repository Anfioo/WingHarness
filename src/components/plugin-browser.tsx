import { useCallback, useEffect, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ArrowLeft, ArrowRight, ExternalLink, RotateCw } from "lucide-react";
import { toast } from "sonner";
import {
  pluginsBrowserBack,
  pluginsBrowserClose,
  pluginsBrowserForward,
  pluginsBrowserNavigate,
  pluginsBrowserOpen,
  pluginsBrowserReload,
  pluginsBrowserSetBounds,
  pluginsBrowserSetVisible,
  pluginsBrowserUrl,
} from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DOCUMENT_ID } from "@/lib/document-id";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** How often to ask the page where it is. */
const URL_POLL_INTERVAL = 400;

/**
 * A plugin's own site, with the chrome that makes it usable inside the app.
 *
 * The page itself is a **native webview**, not an `<iframe>`: plugins send
 * `X-Frame-Options: DENY` (a browser then refuses to frame them), and an
 * iframe's address is unreadable across origins. The webview is an OS-level
 * view, so this component does two things an iframe would not need:
 *
 * 1. **Reserves the space.** The placeholder below keeps the app's layout
 *    honest, and its measured rectangle is what the webview is moved to. It has
 *    to be re-measured on anything that moves it — a window resize, a sidebar
 *    collapse, or a scroll of an ancestor.
 * 2. **Says when it is hidden.** CSS cannot hide a native view, so an inactive
 *    tab has to ask explicitly, or it would stay painted over the active one.
 */
export function PluginBrowser({
  id,
  name,
  initialUrl,
  active,
  host,
}: {
  id: string;
  name: string;
  /** The address the manifest declares, shown before the page reports its own. */
  initialUrl: string;
  /** Whether this pane's tab is the selected one. */
  active: boolean;
  /**
   * Label of the window this pane lives in. The native webview is attached to
   * that window, so the same plugin can be open in the main window and in a
   * plugin's own window at once without the two colliding. Defaults to the
   * window that rendered this component.
   */
  host?: string;
}) {
  const { t } = useAppTranslation();
  // Read once: the host is the window this component was rendered in, and that
  // never changes for a given mount.
  const [hostLabel] = useState(() => host ?? getCurrentWebviewWindow().label);
  const slot = useRef<HTMLDivElement>(null);
  const [address, setAddress] = useState(initialUrl);
  const [draft, setDraft] = useState(initialUrl);
  // Nothing is polled until the webview actually exists, so a failed open does
  // not turn into a stream of errors against a page that was never created.
  const [opened, setOpened] = useState(false);
  // Avoids clobbering a half-typed address when the poll returns.
  const editing = useRef(false);

  const visible = active;

  /** Sends the placeholder's current rectangle to the webview. */
  const syncBounds = useCallback(() => {
    const element = slot.current;
    if (!element) return;

    const rect = element.getBoundingClientRect();
    void pluginsBrowserSetBounds(hostLabel, id, {
      x: rect.left,
      y: rect.top,
      width: rect.width,
      height: rect.height,
    }).catch((error: unknown) => console.error("Failed to place a plugin page:", error));
  }, [hostLabel, id]);

  // Create the page once, and take it down when this pane goes away.
  useEffect(() => {
    let cancelled = false;
    const rect = slot.current?.getBoundingClientRect();

    pluginsBrowserOpen(hostLabel, DOCUMENT_ID, id, {
      x: rect?.left ?? 0,
      y: rect?.top ?? 0,
      width: rect?.width ?? 1,
      height: rect?.height ?? 1,
    })
      .then(() => {
        if (!cancelled) setOpened(true);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        console.error("Failed to open a plugin page:", error);
        toast.error(t("pluginPanel.browserFailed", { name, message: String(error) }));
      });

    return () => {
      cancelled = true;
      setOpened(false);
      void pluginsBrowserClose(hostLabel, DOCUMENT_ID, id).catch((error: unknown) =>
        console.error("Failed to close a plugin page:", error)
      );
    };
  }, [hostLabel, id]); // eslint-disable-line react-hooks/exhaustive-deps -- open once per host+id

  // Keep the page where the placeholder is. The observer catches layout changes
  // (window resize, sidebar collapse); the scroll listener catches the pane
  // being scrolled, which does not resize anything.
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

  // Show and move only while this pane is the one on screen.
  useEffect(() => {
    void pluginsBrowserSetVisible(hostLabel, id, visible).catch((error: unknown) =>
      console.error("Failed to show or hide a plugin page:", error)
    );
    if (visible) {
      syncBounds();
    }
  }, [hostLabel, id, visible, syncBounds]);

  // Follow the page's address. A client-side router moving between routes is
  // not something the host is told about, so this is a poll rather than an
  // event — the same approach the reachability probe already uses.
  useEffect(() => {
    if (!visible || !opened) return;

    let cancelled = false;
    const tick = async () => {
      try {
        const current = await pluginsBrowserUrl(hostLabel, id);
        if (cancelled) return;
        setAddress(current);
        if (!editing.current) setDraft(current);
      } catch (error) {
        // The page can be closed under us while a tab is switching; that is not
        // worth reporting.
        console.debug("Could not read a plugin page address:", error);
      }
    };

    void tick();
    const timer = setInterval(() => void tick(), URL_POLL_INTERVAL);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostLabel, id, visible, opened]);

  const go = useCallback(async (move: () => Promise<void>) => {
    try {
      await move();
    } catch (error) {
      console.error("Plugin page navigation failed:", error);
      toast.error(String(error));
    }
  }, []);

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault();
      editing.current = false;

      const target = draft.trim();
      if (!target || target === address) return;

      // The backend rejects anything off the plugin's own origin; this only
      // spares a round trip on the obvious cases.
      void go(() => pluginsBrowserNavigate(hostLabel, id, target)).then(() => syncBounds());
    },
    [address, draft, go, hostLabel, id, syncBounds]
  );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <form
        onSubmit={submit}
        className="bg-muted/20 flex h-8 shrink-0 items-center gap-1 border-b px-2"
      >
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          title={t("pluginPanel.back")}
          disabled={!visible}
          onClick={() => void go(() => pluginsBrowserBack(hostLabel, id))}
        >
          <ArrowLeft className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          title={t("pluginPanel.forward")}
          disabled={!visible}
          onClick={() => void go(() => pluginsBrowserForward(hostLabel, id))}
        >
          <ArrowRight className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          title={t("pluginPanel.reload")}
          disabled={!visible}
          onClick={() => void go(() => pluginsBrowserReload(hostLabel, id))}
        >
          <RotateCw className="size-3.5" />
        </Button>

        <Input
          value={draft}
          disabled={!visible}
          className="h-6 flex-1 px-2 font-mono text-xs"
          placeholder={t("pluginPanel.addressPlaceholder")}
          onFocus={() => {
            editing.current = true;
          }}
          onBlur={() => {
            editing.current = false;
            setDraft(address);
          }}
          onChange={(event) => setDraft(event.target.value)}
        />

        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          title={t("pluginPanel.openExternal")}
          disabled={!address}
          onClick={() => {
            if (!address) return;
            void openUrl(address).catch((error: unknown) =>
              toast.error(t("pluginPanel.openFailed", { message: String(error) }))
            );
          }}
        >
          <ExternalLink className="size-3.5" />
        </Button>
      </form>

      {/* The space the webview is moved onto. The app draws nothing here — the
          native view covers it — but its box is what the placement is measured
          from, so it has to be laid out exactly like any other pane content. */}
      <div ref={slot} className="min-h-0 flex-1" />
    </div>
  );
}
