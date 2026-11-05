// Mermaid diagram rendering.
//
// `mermaid` is imported lazily: a document with no diagram never pays for the
// chunk. Rendered SVGs are cached by theme + output + source, because the
// preview re-runs on every keystroke and on every theme flip.

import i18n from "@/i18n";

export type DiagramTheme = "light" | "dark";
export type DiagramOutput = "svg" | "image";

export interface DiagramOptions {
  theme: DiagramTheme;
  /** `svg` feeds the preview and the HTML export; `image` feeds the long image and the PDF. */
  output: DiagramOutput;
}

type MermaidApi = typeof import("mermaid").default;

const MAX_SOURCE_LENGTH = 50_000;
const MAX_DIAGRAMS = 50;
const CACHE_LIMIT = 32;
const FONT_WAIT_MS = 1_500;
const RETRY_DELAY_MS = 1_200;

const CONTAINER_CLASS = "md-diagram";
const ERROR_CLASS = "md-diagram-error";
const MERMAID_BLOCK_CLASS = "md-mermaid";

let loader: Promise<MermaidApi> | null = null;
let initializedSignature: string | null = null;
let renderCounter = 0;
/** Mermaid's renderer is not reentrant; a preview, a theme flip and an export can overlap. */
let renderQueue: Promise<unknown> = Promise.resolve();

/** `theme|output|source → svg`, least recently used first. */
const cache = new Map<string, string>();
/** Source of a block that was already replaced; the `<code>` element is gone by then. */
const sources = new WeakMap<Element, string>();
/** Roots that already got their one automatic retry after a failed initialization. */
const retriedRoots = new WeakSet<ParentNode>();

/**
 * Render every Mermaid block under `root`, replacing it with the diagram.
 * Returns the number of diagrams rendered (cache hits included).
 *
 * Errors never escape: a failing diagram becomes an error block that still
 * shows its source, so the rest of the document is unaffected.
 */
export async function renderDiagrams(root: ParentNode, options: DiagramOptions): Promise<number> {
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>(
      `pre.${MERMAID_BLOCK_CLASS}, .${CONTAINER_CLASS}, .${ERROR_CLASS}`
    )
  );
  if (blocks.length === 0) return 0;

  let mermaid: MermaidApi;
  try {
    mermaid = await loadMermaid();
    configure(mermaid, options);
  } catch (error: unknown) {
    // The chunk failed to load or mermaid refused to initialize. Replace every
    // block with an error so the failure is visible; a raw code block looks
    // like the feature simply is not there.
    console.error("Failed to initialize the Mermaid renderer", error);
    const message = i18n.t("mdEditor.preview.diagramError", { message: messageOf(error) });
    for (const block of blocks) {
      const source = sourceOf(block);
      if (source === null || source.trim() === "") continue;
      markError(block, source, message);
    }
    scheduleRetry(root, options);
    return 0;
  }

  await waitForFonts();

  let rendered = 0;
  let count = 0;

  for (const block of blocks) {
    const source = sourceOf(block);
    if (source === null || source.trim() === "") continue;

    if (count >= MAX_DIAGRAMS) {
      markError(block, source, i18n.t("mdEditor.preview.diagramTooMany"));
      continue;
    }
    count += 1;

    if (source.length > MAX_SOURCE_LENGTH) {
      markError(block, source, i18n.t("mdEditor.preview.diagramTooLarge"));
      continue;
    }

    const container = ensureContainer(block, source);
    const key = `${options.theme}|${options.output}|${source}`;
    const cached = readCache(key);
    if (cached !== undefined) {
      applyDiagram(container, cached, options);
      rendered += 1;
      continue;
    }

    try {
      const svg = await renderOne(mermaid, source);
      writeCache(key, svg);
      applyDiagram(container, svg, options);
      rendered += 1;
    } catch (error: unknown) {
      markError(
        container,
        source,
        i18n.t("mdEditor.preview.diagramError", { message: messageOf(error) })
      );
    }
  }

  return rendered;
}

function loadMermaid(): Promise<MermaidApi> {
  if (loader === null) {
    loader = import("mermaid")
      .then((module) => module.default)
      .catch((error: unknown) => {
        // A rejected loader must not be cached: one failed chunk fetch would
        // otherwise disable diagrams for the rest of the session.
        loader = null;
        throw error;
      });
  }
  return loader;
}

/**
 * A cold chunk or a still-optimizing dev server can fail the very first pass.
 * Retry once in the background so a transient failure does not leave the
 * document as plain code until the next theme flip. Exports are detached
 * documents and never retried.
 */
function scheduleRetry(root: ParentNode, options: DiagramOptions): void {
  if (!(root instanceof Element) || !root.isConnected || retriedRoots.has(root)) return;
  retriedRoots.add(root);
  window.setTimeout(() => {
    if (!root.isConnected) return;
    void renderDiagrams(root, options).catch(() => undefined);
  }, RETRY_DELAY_MS);
}

/** Web fonts change the measured text size, but a slow font must not stall the diagrams. */
async function waitForFonts(): Promise<void> {
  try {
    await Promise.race([
      document.fonts.ready,
      new Promise<void>((resolve) => window.setTimeout(resolve, FONT_WAIT_MS)),
    ]);
  } catch {
    // Font loading is best effort; the fallback stack still renders.
  }
}

/** One render at a time: mermaid mutates shared state and a temporary DOM node. */
function renderOne(mermaid: MermaidApi, source: string): Promise<string> {
  const id = `md-diagram-${(renderCounter += 1)}`;
  const task = renderQueue.then(async () => (await mermaid.render(id, source)).svg);
  renderQueue = task.catch(() => undefined);
  return task;
}

function configure(mermaid: MermaidApi, options: DiagramOptions): void {
  const signature = `${options.theme}|${options.output}`;
  if (initializedSignature === signature) return;

  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: options.theme === "dark" ? "dark" : "default",
    fontFamily: "inherit",
    // A long image rasterizes the whole page through a foreignObject; nested
    // foreignObject labels can lose text, so image output uses plain <text>.
    flowchart: { htmlLabels: options.output !== "image" },
    class: { htmlLabels: options.output !== "image" },
  });
  initializedSignature = signature;
}

function sourceOf(block: HTMLElement): string | null {
  const stored = sources.get(block);
  if (stored !== undefined) return stored;
  const code = block.querySelector("code");
  return code ? (code.textContent ?? "") : null;
}

/**
 * Inline SVG for the preview and the HTML export; a `data:` URL `<img>` for
 * the long image and the PDF, where `<img>.decode()` is what waits for it.
 */
function applyDiagram(container: HTMLElement, svg: string, options: DiagramOptions): void {
  if (options.output === "image") {
    container.textContent = "";
    const image = container.ownerDocument.createElement("img");
    image.className = "md-diagram-image";
    image.alt = "diagram";
    image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
    container.appendChild(image);
  } else {
    // Safe: mermaid runs with `securityLevel: "strict"`, and this path is
    // intentionally outside the DOMPurify pass (see diagram sanitation note).
    container.innerHTML = svg;
  }
}

/**
 * Swap the code block for its diagram slot before rendering starts, so the
 * source does not linger while the chunk loads. A block that already became a
 * diagram or an error is reused, which is what makes theme flips cheap.
 */
function ensureContainer(element: HTMLElement, source: string): HTMLElement {
  if (element.classList.contains(CONTAINER_CLASS)) return element;
  if (element.classList.contains(ERROR_CLASS)) {
    element.className = CONTAINER_CLASS;
    return element;
  }

  const container = element.ownerDocument.createElement("div");
  container.className = CONTAINER_CLASS;
  copySourceLine(element, container);
  sources.set(container, source);
  element.replaceWith(container);
  return container;
}

function markError(element: HTMLElement, source: string, message: string): void {
  const document = element.ownerDocument;
  const existing = element.classList.contains(ERROR_CLASS);
  const container = existing ? element : document.createElement("div");

  container.className = ERROR_CLASS;
  container.textContent = "";
  copySourceLine(element, container);

  const header = document.createElement("div");
  header.textContent = message;

  const pre = document.createElement("pre");
  const code = document.createElement("code");
  code.textContent = source;
  pre.appendChild(code);

  container.append(header, pre);
  sources.set(container, source);
  if (!existing) element.replaceWith(container);
}

function copySourceLine(from: HTMLElement, to: HTMLElement): void {
  const line = from.getAttribute("data-source-line");
  if (line !== null) to.setAttribute("data-source-line", line);
}

function readCache(key: string): string | undefined {
  const value = cache.get(key);
  if (value === undefined) return undefined;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function writeCache(key: string, value: string): void {
  cache.delete(key);
  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.split("\n")[0];
}
