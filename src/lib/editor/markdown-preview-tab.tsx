import { useEffect, useMemo, useRef, useState } from "react";
import { PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { extractHeadings } from "@/features/md-editor/outline/extract";
import { OutlinePanel } from "@/features/md-editor/outline/outline";
import { PreviewPane } from "@/features/md-editor/preview/pane";
import { isDocumentTooLarge, renderMarkdown } from "@/features/md-editor/preview/render";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { useMarkdownPreviewDocs } from "./markdown-preview-docs";

/** Typing settles before the document is rendered again. */
const RENDER_DEBOUNCE_MS = 150;
/** Reading measure, matching the Markdown editor's default content width. */
const CONTENT_MAX_WIDTH = 860;
/** How close to the top edge a heading counts as the one being read. */
const ACTIVE_HEADING_OFFSET = 24;

/**
 * A Markdown file's reading tab: the document outline beside the rendered text.
 *
 * The renderer is the Markdown editor's own (`renderMarkdown` + `PreviewPane`),
 * so this needs no network: marked, KaTeX, highlight.js and Mermaid all ship with
 * the app. The source comes from the preview extension's store, which follows the
 * workbench document as it is edited.
 */
export default function MarkdownPreviewTab({
  path,
  root,
}: {
  /** The document's path as codelet spells it, `/`-rooted. */
  path: string;
  /** Absolute directory the path is relative to; images resolve against it. */
  root: string;
}) {
  const { t } = useAppTranslation();
  const live = useMarkdownPreviewDocs((state) => state.docs[path] ?? "");
  const source = useDebounced(live);
  // `renderMarkdown` tags relative images with an absolute path for `assets.ts`,
  // which reads it through the backend — so the document needs its absolute path.
  const docPath = useMemo(() => joinRoot(root, path), [root, path]);

  const tooLarge = useMemo(() => isDocumentTooLarge(source), [source]);
  const html = useMemo(
    () => (tooLarge ? "" : renderMarkdown(source, { docPath })),
    [source, docPath, tooLarge]
  );
  const headings = useMemo(() => extractHeadings(source), [source]);

  const [outlineVisible, setOutlineVisible] = useState(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  // The heading the reader is under, from the headings' own positions. The
  // rendered blocks carry source-line anchors, but the outline works in ids.
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;

    const update = () => {
      const top = container.getBoundingClientRect().top;
      let current: string | null = null;
      for (const heading of Array.from(
        container.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6")
      )) {
        if (heading.getBoundingClientRect().top - top > ACTIVE_HEADING_OFFSET) break;
        current = heading.id;
      }
      setActiveId(current);
    };

    update();
    container.addEventListener("scroll", update, { passive: true });
    return () => container.removeEventListener("scroll", update);
  }, [html]);

  const jump = (_line: number, id: string) => {
    const container = scrollRef.current;
    const heading = container?.querySelector<HTMLElement>(`[id="${CSS.escape(id)}"]`);
    heading?.scrollIntoView({ block: "start" });
  };

  return (
    <div className="flex h-full min-h-0">
      {outlineVisible ? (
        <aside className="border-border w-56 shrink-0 overflow-hidden border-r">
          <OutlinePanel headings={headings} activeId={activeId} onJump={jump} />
        </aside>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-auto">
          <div className="mx-auto px-8 py-6" style={{ maxWidth: CONTENT_MAX_WIDTH }}>
            <PreviewPane html={html} docPath={docPath} tooLarge={tooLarge} />
          </div>
        </div>
        {/* Floated so it stays in reach while the document scrolls, and inside the
            content's own padding so it never sits over the text column. */}
        <button
          type="button"
          title={t(outlineVisible ? "mdEditor.outline.hide" : "mdEditor.outline.show")}
          aria-label={t(outlineVisible ? "mdEditor.outline.hide" : "mdEditor.outline.show")}
          onClick={() => setOutlineVisible((visible) => !visible)}
          className={cn(
            "text-muted-foreground hover:text-foreground hover:bg-muted border-border bg-background/80 absolute top-3 right-3 grid size-7 place-items-center rounded-md border backdrop-blur transition-colors",
            outlineVisible && "text-foreground"
          )}
        >
          {outlineVisible ? (
            <PanelLeftClose className="size-4" />
          ) : (
            <PanelLeftOpen className="size-4" />
          )}
        </button>
      </div>
    </div>
  );
}

/** `C:\notes` + `/a/b.md` → `C:\notes/a/b.md`, which both the renderer and the backend accept. */
function joinRoot(root: string, path: string): string {
  if (!root) return path;
  const base = root.replace(/[\\/]+$/, "");
  const relative = path.replace(/^\/+/, "");
  return `${base}/${relative}`;
}

function useDebounced(value: string): string {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), RENDER_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [value]);
  return settled;
}
