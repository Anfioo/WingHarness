import { useEffect, useMemo, useRef } from "react";
import type { JSX, MouseEvent } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { toast } from "sonner";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { resolveAssets } from "./assets";
import { renderDiagrams, type DiagramTheme } from "./diagram";
// KaTeX ships its own layout rules; our overrides in `preview.css` come after.
import "katex/dist/katex.min.css";
import "./preview.css";

const EXTERNAL_LINK = /^(?:https?:|mailto:)/i;
/** Fired (bubbling) on the `<article>` after the images and diagrams are laid out. */
export const ASSETS_RESOLVED_EVENT = "md-preview-assets-resolved";

/** Diagrams are rebuilt only after typing pauses; the source cache makes it cheap. */
const DIAGRAM_DEBOUNCE_MS = 120;

export interface PreviewPaneProps {
  /** Output of `renderMarkdown`, already sanitized. */
  html: string;
  /** Path of the document, used to resolve the images the renderer tagged. */
  docPath: string | null;
  /** Set by the page when `isDocumentTooLarge(source)` is true. */
  tooLarge?: boolean;
}

/**
 * The rendered document. Links are intercepted so the webview never navigates:
 * external ones go to the OS browser, `#anchor` scrolls inside the preview and
 * document-relative links only explain that they are unsupported.
 */
export function PreviewPane({ html, docPath, tooLarge = false }: PreviewPaneProps): JSX.Element {
  const { t } = useAppTranslation();
  const articleRef = useRef<HTMLElement | null>(null);
  const empty = html.trim() === "";
  // React compares `dangerouslySetInnerHTML` by object identity, so a fresh
  // `{ __html }` object rewrites the article on every parent re-render — even
  // when the markup is unchanged — which throws away the injected diagrams.
  const innerHtml = useMemo(() => ({ __html: html }), [html]);

  useEffect(() => {
    const container = articleRef.current;
    if (!container || tooLarge || empty) return;
    let cancelled = false;

    const timer = window.setTimeout(() => {
      void (async () => {
        try {
          await resolveAssets(container, docPath);
          if (cancelled) return;
          await renderDiagrams(container, { theme: currentTheme(), output: "svg" });
        } catch (error) {
          console.error("Failed to prepare the preview", error);
        } finally {
          if (!cancelled && container.isConnected) {
            // Images and diagrams change the layout, so the scroll samples are stale now.
            container.dispatchEvent(new CustomEvent(ASSETS_RESOLVED_EVENT, { bubbles: true }));
          }
        }
      })();
    }, DIAGRAM_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [html, docPath, tooLarge, empty]);

  // Diagrams bake the theme colors into their SVG, so a light/dark flip has to
  // render them again. The renderer caches per theme, so this stays cheap.
  useEffect(() => {
    const container = articleRef.current;
    if (!container || tooLarge || empty) return;
    let cancelled = false;
    let theme = currentTheme();

    const observer = new MutationObserver(() => {
      const next = currentTheme();
      if (next === theme) return;
      theme = next;
      void (async () => {
        try {
          await renderDiagrams(container, { theme: next, output: "svg" });
        } catch (error) {
          console.error("Failed to re-render the diagrams for the new theme", error);
        } finally {
          if (!cancelled && container.isConnected) {
            container.dispatchEvent(new CustomEvent(ASSETS_RESOLVED_EVENT, { bubbles: true }));
          }
        }
      })();
    });
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    return () => {
      cancelled = true;
      observer.disconnect();
    };
  }, [html, tooLarge, empty]);

  if (tooLarge) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        {t("mdEditor.preview.tooLarge")}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="text-muted-foreground flex h-full items-center justify-center p-6 text-sm">
        {t("mdEditor.preview.empty")}
      </div>
    );
  }

  function handleClick(event: MouseEvent<HTMLElement>): void {
    const target = event.target as HTMLElement | null;
    const anchor = target?.closest("a[href]");
    if (!anchor) return;

    const href = anchor.getAttribute("href") ?? "";
    event.preventDefault();

    if (href.startsWith("#")) {
      const id = decodeAnchor(href.slice(1));
      const heading = articleRef.current?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
      heading?.scrollIntoView({ block: "start" });
      return;
    }

    if (EXTERNAL_LINK.test(href)) {
      void openUrl(href).catch(() => toast.error(t("mdEditor.error.unsupported")));
      return;
    }

    toast.info(t("mdEditor.preview.linkUnsupported"));
  }

  return (
    <article
      ref={articleRef}
      className="md-preview"
      onClick={handleClick}
      dangerouslySetInnerHTML={innerHtml}
    />
  );
}

function decodeAnchor(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/** The app toggles `dark` on the root element; Mermaid needs one of two themes. */
function currentTheme(): DiagramTheme {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}
