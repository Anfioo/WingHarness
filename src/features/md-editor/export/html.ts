// Self-contained HTML export: rendered article + inlined images + stylesheet.

import { mdEditorReadAsset, saveTextFile } from "@/commands";
import { renderMarkdown } from "../preview/render";
import { ASSET_ATTR, ASSET_MISSING_ATTR, resolveAssetPath } from "../preview/assets";
import { renderDiagrams } from "../preview/diagram";
import { exportArticleCss } from "./export-style";

export interface HtmlExportOptions {
  source: string;
  docPath: string | null;
  title: string;
  inlineStyles: boolean;
  includeTitle: boolean;
}

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ESCAPES[character] ?? character);
}

/**
 * Replace the local images the renderer left as placeholders with base64 data
 * URLs. Remote images keep their `src`; local files that cannot be read are
 * dropped so the exported document never shows a broken icon.
 */
export async function inlineLocalImages(doc: Document, docPath: string | null): Promise<void> {
  const images = Array.from(
    doc.querySelectorAll<HTMLImageElement>(`img[${ASSET_ATTR}], img[${ASSET_MISSING_ATTR}]`)
  );

  await Promise.all(
    images.map(async (image) => {
      const source = image.getAttribute(ASSET_ATTR) ?? image.getAttribute(ASSET_MISSING_ATTR) ?? "";
      const path = source ? resolveAssetPath(source, docPath) : null;
      if (!path) {
        console.warn("md-editor: dropping unresolved image from export", source);
        image.remove();
        return;
      }

      try {
        const asset = await mdEditorReadAsset(path);
        image.setAttribute("src", asset.dataUrl);
        image.removeAttribute(ASSET_ATTR);
        image.removeAttribute(ASSET_MISSING_ATTR);
      } catch (error: unknown) {
        console.warn("md-editor: failed to inline image for export", path, error);
        image.remove();
      }
    })
  );
}

/** Render the document into a standalone HTML file at `targetPath`. */
export async function exportHtml(options: HtmlExportOptions, targetPath: string): Promise<void> {
  // MathML carries its own layout, so the file needs neither KaTeX CSS nor its fonts.
  const rendered = renderMarkdown(options.source, {
    docPath: options.docPath,
    mathOutput: "mathml",
  });
  const doc = new DOMParser().parseFromString(rendered, "text/html");
  await inlineLocalImages(doc, options.docPath);
  // Diagrams are inlined as SVG; the export stays readable without network access.
  await renderDiagrams(doc, { theme: "light", output: "svg" });

  const title = options.title.trim() || "Markdown";
  if (options.includeTitle) {
    const heading = doc.createElement("h1");
    heading.textContent = title;
    doc.body.prepend(heading);
  }

  const lang = document.documentElement.lang || "en";
  const styles = options.inlineStyles
    ? `<style>\nbody{margin:0;padding:0;background:#f6f8fa;color:#1f2328;}\n${exportArticleCss()}\n</style>\n`
    : "";
  const html = [
    "<!doctype html>",
    `<html lang="${escapeHtml(lang)}">`,
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title)}</title>`,
    styles + "</head>",
    "<body>",
    '<article class="md-export-article">',
    doc.body.innerHTML,
    "</article>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  await saveTextFile(targetPath, html);
}
