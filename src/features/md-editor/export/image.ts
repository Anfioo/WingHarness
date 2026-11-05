// Whole-document PNG export.
//
// The article is laid out in an offscreen DOM node, serialized into an SVG
// `foreignObject`, loaded as an image and rasterized on a canvas. This avoids
// html2canvas and keeps the export dependency-free.

import { mdEditorSaveBinary } from "@/commands";
import i18n from "@/i18n";
import type { OutlineHeading } from "../outline/extract";
import { renderMarkdown } from "../preview/render";
import { renderDiagrams } from "../preview/diagram";
import { exportArticleCss } from "./export-style";
import { inlineLocalImages } from "./html";

export interface ImageExportOptions {
  source: string;
  docPath: string | null;
  /** Capture width in CSS pixels (the editor's content width). */
  width: number;
  /** Requested pixel ratio, 1–3 in quarter steps. */
  scale: number;
  includeOutline: boolean;
  headings?: OutlineHeading[];
}

export type LongImageErrorCode = "too-large" | "render-failed";

/** Structured failure the page turns into a localized message. */
export class LongImageExportError extends Error {
  readonly code: LongImageErrorCode;
  readonly detail: Record<string, unknown> | null;

  constructor(
    code: LongImageErrorCode,
    message: string,
    detail: Record<string, unknown> | null = null
  ) {
    super(message);
    this.name = "LongImageExportError";
    this.code = code;
    this.detail = detail;
  }
}

const SVG_NS = "http://www.w3.org/2000/svg";
const XHTML_NS = "http://www.w3.org/1999/xhtml";

/** Chromium refuses canvases wider or taller than this. */
const MAX_DIMENSION = 32_767;
/** 268 MP keeps the PNG under the engine's memory ceiling. */
const MAX_PIXELS = 268_000_000;
const MIN_SCALE = 0.5;
const SCALE_STEP = 0.25;
const OUTLINE_WIDTH = 220;

/** Layout around the article; the capture is not the standalone HTML page. */
const IMAGE_LAYOUT_CSS = `
.md-export-root {
  display: flex;
  align-items: flex-start;
  gap: 24px;
  padding: 24px;
  background: #ffffff;
  color: #1f2328;
}
.md-export-root > .md-export-article {
  flex: 1 1 auto;
  min-width: 0;
  max-width: none;
  margin: 0;
  padding: 0;
  background: #ffffff;
}
.md-export-outline {
  flex: 0 0 ${OUTLINE_WIDTH}px;
  width: ${OUTLINE_WIDTH}px;
  padding-top: 2px;
  color: #59636e;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  font-size: 13px;
  line-height: 1.65;
}
.md-export-outline-title {
  margin: 0 0 8px;
  color: #1f2328;
  font-size: 14px;
  font-weight: 600;
}
.md-export-outline ul {
  margin: 0;
  padding: 0;
  list-style: none;
}
.md-export-outline li {
  margin: 2px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.md-export-outline .level-2 {
  padding-left: 12px;
}
.md-export-outline .level-3 {
  padding-left: 24px;
}
.md-export-outline .level-4 {
  padding-left: 36px;
}
.md-export-outline .level-5 {
  padding-left: 48px;
}
.md-export-outline .level-6 {
  padding-left: 60px;
}
`.trim();

/**
 * Rasterize the whole document to `targetPath` as a PNG.
 * Returns the ratio actually used, so the caller can report a downscale.
 */
export async function exportLongImage(
  options: ImageExportOptions,
  targetPath: string
): Promise<{ scale: number }> {
  const requestedWidth = Number.isFinite(options.width) ? options.width : 0;
  const width = Math.max(200, Math.round(requestedWidth || 860));
  const rendered = renderMarkdown(options.source, {
    docPath: options.docPath,
    mathOutput: "mathml",
  });
  const parsed = new DOMParser().parseFromString(rendered, "text/html");
  await inlineLocalImages(parsed, options.docPath);
  // Must happen before `buildRoot`: the diagrams become data-URL images that
  // `waitForContent` can then decode alongside the regular images.
  await renderDiagrams(parsed, { theme: "light", output: "image" });

  const container = document.createElement("div");
  container.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;background:#ffffff;color:#1f2328;`;

  const content = document.createElementNS(XHTML_NS, "div");
  content.setAttribute("xmlns", XHTML_NS);
  content.style.cssText = `width:${width}px;background:#ffffff;color:#1f2328;`;

  const style = document.createElement("style");
  style.textContent = `${exportArticleCss({ contentWidth: width })}\n${IMAGE_LAYOUT_CSS}`;
  content.appendChild(style);
  content.appendChild(buildRoot(options, parsed));

  container.appendChild(content);
  document.body.appendChild(container);

  try {
    await waitForContent(content);

    const height = Math.ceil(
      Math.max(content.scrollHeight, content.getBoundingClientRect().height)
    );
    if (height <= 0) {
      throw new LongImageExportError("render-failed", "The exported article has no height.");
    }

    const svg = buildSvg(content, width, height);
    const serialized = new XMLSerializer().serializeToString(svg);
    const image = await loadSvgImage(serialized);

    const target = fitScale(width, height, options.scale);
    const canvas = document.createElement("canvas");
    canvas.width = target.width;
    canvas.height = target.height;

    const context = canvas.getContext("2d");
    if (!context) {
      throw new LongImageExportError("render-failed", "The canvas 2D context is unavailable.");
    }

    // A transparent PNG border is invisible on a dark editor background.
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, target.width, target.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, target.width, target.height);

    let dataUrl: string;
    try {
      dataUrl = canvas.toDataURL("image/png");
    } catch (error: unknown) {
      throw new LongImageExportError(
        "render-failed",
        "The canvas could not be read; the document probably contains a remote image.",
        { reason: error instanceof Error ? error.message : String(error) }
      );
    }

    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    await mdEditorSaveBinary(targetPath, base64);
    return { scale: target.scale };
  } finally {
    container.remove();
  }
}

function buildRoot(options: ImageExportOptions, parsed: Document): HTMLElement {
  const root = document.createElement("div");
  root.className = "md-export-root";

  if (options.includeOutline) {
    const outline = buildOutline(options.headings ?? []);
    if (outline) root.appendChild(outline);
  }

  const article = document.createElement("article");
  article.className = "md-export-article";
  article.innerHTML = parsed.body.innerHTML;
  root.appendChild(article);

  return root;
}

function buildOutline(headings: OutlineHeading[]): HTMLElement | null {
  if (headings.length === 0) return null;

  const aside = document.createElement("aside");
  aside.className = "md-export-outline";

  const title = document.createElement("div");
  title.className = "md-export-outline-title";
  title.textContent = i18n.t("mdEditor.outline.title");

  const list = document.createElement("ul");
  for (const heading of headings) {
    const item = document.createElement("li");
    item.className = `level-${heading.level}`;
    item.textContent = heading.text;
    list.appendChild(item);
  }

  aside.append(title, list);
  return aside;
}

async function waitForContent(root: HTMLElement): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    // Font loading is best effort; the fallback stack is always available.
  }

  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
}

function buildSvg(content: HTMLElement, width: number, height: number): SVGSVGElement {
  content.style.height = `${height}px`;

  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("xmlns", SVG_NS);
  svg.setAttribute("width", String(width));
  svg.setAttribute("height", String(height));
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);

  const foreignObject = document.createElementNS(SVG_NS, "foreignObject");
  foreignObject.setAttribute("width", "100%");
  foreignObject.setAttribute("height", "100%");

  // Styles are scoped by the <style> already inside `content`; `foreignObject`
  // does not inherit any rule from the host page.
  foreignObject.appendChild(content);
  svg.appendChild(foreignObject);

  return svg;
}

async function loadSvgImage(svg: string): Promise<HTMLImageElement> {
  const base64 = btoa(unescape(encodeURIComponent(svg)));
  const image = new Image();
  image.src = `data:image/svg+xml;base64,${base64}`;

  try {
    await image.decode();
  } catch (error: unknown) {
    throw new LongImageExportError(
      "render-failed",
      "The document could not be rendered as an SVG image.",
      { reason: error instanceof Error ? error.message : String(error) }
    );
  }

  return image;
}

function fitScale(
  width: number,
  height: number,
  requested: number
): { scale: number; width: number; height: number } {
  const safeRequested = Number.isFinite(requested) ? requested : 1;
  let scale = Math.round(Math.min(3, Math.max(MIN_SCALE, safeRequested)) * 4) / 4;

  while (true) {
    const pixelWidth = Math.round(width * scale);
    const pixelHeight = Math.round(height * scale);
    if (
      pixelWidth <= MAX_DIMENSION &&
      pixelHeight <= MAX_DIMENSION &&
      pixelWidth * pixelHeight <= MAX_PIXELS
    ) {
      return { scale, width: pixelWidth, height: pixelHeight };
    }

    const next = Math.round((scale - SCALE_STEP) * 4) / 4;
    if (next < MIN_SCALE - 1e-9) break;
    scale = next;
  }

  throw new LongImageExportError(
    "too-large",
    "The document is too large to export as a single image; export it as HTML instead.",
    { width, height, minScale: MIN_SCALE }
  );
}
