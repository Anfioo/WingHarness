// Native PDF export.
//
// Printing is done by WebView2 (`md_editor_export_pdf`) against whatever the
// window is showing, so the page is first put into a print state: every
// top-level node but the article root is hidden and a print-only stylesheet is
// attached. The state is torn down in `finally`, whether the export succeeded,
// failed or fell back to the system print dialog.

import { mdEditorErrorCode, mdEditorExportPdf } from "@/commands";
import i18n from "@/i18n";
import { toast } from "sonner";
import { renderMarkdown } from "../preview/render";
import { renderDiagrams } from "../preview/diagram";
import { exportPrintCss } from "./export-style";
import { inlineLocalImages } from "./html";

export interface PdfExportOptions {
  source: string;
  docPath: string | null;
  title: string;
  page: "a4" | "letter";
  marginMm: number;
}

/** Page geometry in inches; WebView2's print settings are inch-based. */
const PAGE_SIZES = {
  a4: { width: 8.27, height: 11.69 },
  letter: { width: 8.5, height: 11 },
} as const;

const MM_PER_INCH = 25.4;

const PRINT_ROOT_ID = "md-print-root";
const ARTICLE_CLASS = "md-export-article";

/**
 * `exportPrintCss` styles the article but knows nothing about the app shell.
 * Hiding every other top-level node is what keeps the sidebar, tab strip,
 * toolbar, outline and status bar out of the PDF without the page having to tag
 * each of them.
 */
const PRINT_ISOLATION_CSS = `
html[data-md-print="1"] body > :not(#${PRINT_ROOT_ID}) {
  display: none !important;
}
`.trim();

/** The nodes an export added, so the teardown removes exactly those. */
interface PrintState {
  root: HTMLElement;
  style: HTMLStyleElement;
  previousTitle: string;
}

/**
 * Export the document at `targetPath` as a PDF.
 *
 * Sizes go over the wire in inches because Rust passes them straight to
 * WebView2; only the margin arrives in millimetres, which is what the settings
 * dialog shows.
 */
export async function exportPdf(options: PdfExportOptions, targetPath: string): Promise<void> {
  const page = options.page === "letter" ? PAGE_SIZES.letter : PAGE_SIZES.a4;
  const margin = marginInInches(options.marginMm);

  const state = await enterPrintState(options);

  try {
    await mdEditorExportPdf({
      path: targetPath,
      pageWidth: page.width,
      pageHeight: page.height,
      margins: { top: margin, right: margin, bottom: margin, left: margin },
    });
  } catch (error: unknown) {
    exitPrintState(state);

    // Outside Windows, or on a WebView2 runtime older than the printing
    // interface, there is no dialog-free print. The system dialog still can
    // produce a PDF, so the export degrades to it instead of failing.
    if (mdEditorErrorCode(error) !== "unsupported") throw error;
    await printThroughDialog(options);
  } finally {
    exitPrintState(state);
  }
}

async function printThroughDialog(options: PdfExportOptions): Promise<void> {
  toast.info(
    i18n.t("mdEditor.export.pdfFallback", {
      defaultValue: "Choose “Save as PDF” in the print dialog.",
    })
  );
  // Let the toast paint before the modal dialog blocks the compositor.
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

  const state = await enterPrintState(options);
  try {
    window.print();
  } finally {
    exitPrintState(state);
  }
}

/** Build the article, hide the shell, and wait until the layout is final. */
async function enterPrintState(options: PdfExportOptions): Promise<PrintState> {
  const rendered = renderMarkdown(options.source, {
    docPath: options.docPath,
    mathOutput: "mathml",
  });
  const doc = new DOMParser().parseFromString(rendered, "text/html");
  await inlineLocalImages(doc, options.docPath);
  // Same as the long image: a data-URL image is what `waitForLayout` decodes.
  await renderDiagrams(doc, { theme: "light", output: "image" });

  const root = document.createElement("div");
  root.id = PRINT_ROOT_ID;
  // Absolute while on screen so the app shell disappears without reflowing the
  // page; the print stylesheet turns it back into normal flow for pagination.
  root.style.cssText = "position:absolute;inset:0;background:#ffffff;";

  const article = document.createElement("article");
  article.className = ARTICLE_CLASS;
  article.innerHTML = doc.body.innerHTML;
  root.appendChild(article);

  const style = document.createElement("style");
  style.textContent = `${exportPrintCss()}\n${PRINT_ISOLATION_CSS}`;

  // WebView2 writes the document title into the PDF's metadata.
  const previousTitle = document.title;
  document.title = options.title.trim() || previousTitle;

  document.documentElement.dataset.mdPrint = "1";
  document.head.appendChild(style);
  document.body.appendChild(root);

  await waitForLayout(root);

  return { root, style, previousTitle };
}

/** Remove the print state. Safe to call twice, and safe on a stale state. */
function exitPrintState(state: PrintState): void {
  state.root.remove();
  state.style.remove();
  document.title = state.previousTitle;
  delete document.documentElement.dataset.mdPrint;
}

function marginInInches(marginMm: number): number {
  const value = Number.isFinite(marginMm) ? Math.max(0, marginMm) : 0;
  return value / MM_PER_INCH;
}

async function waitForLayout(root: HTMLElement): Promise<void> {
  try {
    await document.fonts.ready;
  } catch {
    // Fonts are best effort; the fallback stack always renders.
  }

  const images = Array.from(root.querySelectorAll("img"));
  await Promise.all(images.map((image) => image.decode().catch(() => undefined)));
}
