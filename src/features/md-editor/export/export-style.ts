// Self-contained stylesheets for the HTML, long-image and PDF exports.
//
// These rules must never reference theme tokens (`var(--*)`) or modern color
// functions such as `oklch()` / `color-mix()`: the long image is rasterized
// through an SVG `foreignObject`, where those values do not resolve.

/** Typography overrides taken from the editor's appearance settings. */
export interface ArticleStyleOptions {
  /** Empty / missing falls back to the platform UI stack. */
  fontFamily?: string;
  fontSize?: number;
  lineHeight?: number;
  /** Used as the article's max width; the image export overrides it. */
  contentWidth?: number;
  /** Empty / missing falls back to the platform monospace stack. */
  codeFontFamily?: string;
}

const BODY_FONT = `-apple-system, "Segoe UI", "Microsoft YaHei", sans-serif`;
const CODE_FONT = `Consolas, "Cascadia Mono", monospace`;

const DEFAULT_STYLE: Required<ArticleStyleOptions> = {
  fontFamily: "",
  fontSize: 16,
  lineHeight: 1.75,
  contentWidth: 860,
  codeFontFamily: "",
};

/** Strip characters that would let a settings value break out of the declaration. */
function fontStack(custom: string | undefined, fallback: string): string {
  const cleaned = (custom ?? "").replace(/[<>{};\\'"]/g, "").trim();
  return cleaned ? `${cleaned}, ${fallback}` : fallback;
}

function resolveStyle(options: ArticleStyleOptions): Required<ArticleStyleOptions> {
  return {
    fontFamily: fontStack(options.fontFamily, BODY_FONT),
    fontSize: options.fontSize && options.fontSize > 0 ? options.fontSize : DEFAULT_STYLE.fontSize,
    lineHeight:
      options.lineHeight && options.lineHeight > 0 ? options.lineHeight : DEFAULT_STYLE.lineHeight,
    contentWidth:
      options.contentWidth && options.contentWidth > 0
        ? Math.round(options.contentWidth)
        : DEFAULT_STYLE.contentWidth,
    codeFontFamily: fontStack(options.codeFontFamily, CODE_FONT),
  };
}

/** GitHub-flavoured light palette; every value is an explicit hex color. */
function articleRules(scope: string, options: ArticleStyleOptions): string {
  const s = scope;
  const style = resolveStyle(options);

  return `
${s} {
  box-sizing: border-box;
  max-width: ${style.contentWidth}px;
  margin: 0 auto;
  padding: 32px 40px;
  background: #ffffff;
  color: #1f2328;
  font-family: ${style.fontFamily};
  font-size: ${style.fontSize}px;
  line-height: ${style.lineHeight};
  text-align: left;
  overflow-wrap: break-word;
  word-break: break-word;
}
${s} *,
${s} *::before,
${s} *::after {
  box-sizing: border-box;
}
${s} > :first-child {
  margin-top: 0;
}
${s} > :last-child {
  margin-bottom: 0;
}
${s} h1,
${s} h2,
${s} h3,
${s} h4,
${s} h5,
${s} h6 {
  margin: 1.4em 0 0.6em;
  font-weight: 600;
  line-height: 1.3;
  color: #1f2328;
}
${s} h1 {
  font-size: 1.9em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid #d1d9e0;
}
${s} h2 {
  font-size: 1.5em;
  padding-bottom: 0.25em;
  border-bottom: 1px solid #d1d9e0;
}
${s} h3 {
  font-size: 1.25em;
}
${s} h4 {
  font-size: 1.1em;
}
${s} h5 {
  font-size: 1em;
}
${s} h6 {
  font-size: 0.9em;
  color: #59636e;
}
${s} p {
  margin: 0.85em 0;
}
${s} a {
  color: #0969da;
  text-decoration: underline;
  text-underline-offset: 2px;
}
${s} strong {
  font-weight: 600;
}
${s} em {
  font-style: italic;
}
${s} del {
  color: #59636e;
  text-decoration: line-through;
}
${s} blockquote {
  margin: 1em 0;
  padding: 0.35em 1.1em;
  border-left: 4px solid #d1d9e0;
  border-radius: 0 4px 4px 0;
  background: #f6f8fa;
  color: #59636e;
}
${s} blockquote > :first-child {
  margin-top: 0;
}
${s} blockquote > :last-child {
  margin-bottom: 0;
}
${s} ul,
${s} ol {
  margin: 0.85em 0;
  padding-left: 1.75em;
}
${s} ul {
  list-style: disc;
}
${s} ol {
  list-style: decimal;
}
${s} li {
  margin: 0.25em 0;
}
${s} li > ul,
${s} li > ol {
  margin: 0.25em 0;
}
${s} ul.contains-task-list {
  padding-left: 1.2em;
}
${s} li.task-list-item {
  list-style: none;
}
${s} li.task-list-item input[type="checkbox"] {
  margin: 0 0.45em 0 0;
  vertical-align: middle;
}
${s} table {
  width: 100%;
  margin: 1em 0;
  border-collapse: collapse;
  border-spacing: 0;
  font-size: 0.95em;
}
${s} th,
${s} td {
  padding: 0.45em 0.8em;
  border: 1px solid #d1d9e0;
  text-align: left;
  vertical-align: top;
}
${s} thead th {
  background: #f6f8fa;
  font-weight: 600;
}
${s} tbody tr:nth-child(2n) {
  background: #fbfcfd;
}
${s} code {
  font-family: ${style.codeFontFamily};
  font-size: 0.9em;
  padding: 0.15em 0.35em;
  border-radius: 4px;
  background: #eff1f3;
  color: #1f2328;
}
${s} pre {
  margin: 1em 0;
  padding: 1em 1.15em;
  border: 1px solid #e6eaef;
  border-radius: 6px;
  background: #f6f8fa;
  overflow-x: auto;
  font-size: 0.875em;
  line-height: 1.6;
}
${s} pre code {
  display: block;
  padding: 0;
  border-radius: 0;
  background: transparent;
  color: inherit;
  font-size: inherit;
  white-space: pre;
}
${s} hr {
  margin: 2em 0;
  border: 0;
  border-top: 1px solid #d1d9e0;
}
${s} img {
  max-width: 100%;
  height: auto;
  margin: 0.5em 0;
  border-radius: 4px;
  vertical-align: middle;
}
${s} .md-image-placeholder {
  display: inline-block;
  margin: 0.25em 0;
  padding: 0.4em 0.7em;
  border: 1px dashed #d1d9e0;
  border-radius: 4px;
  color: #59636e;
  font-size: 0.85em;
}

/* Math and diagrams: explicit colors only, because the long image is rasterized
   through a foreignObject where theme tokens do not resolve. */
${s} .md-math-display {
  margin: 1em 0;
  text-align: center;
  overflow-x: auto;
}
${s} .md-math-display math {
  display: block;
}
${s} .md-diagram {
  display: block;
  max-width: 100%;
  height: auto;
  margin: 1em auto;
  text-align: center;
}
${s} .md-diagram svg,
${s} .md-diagram img {
  max-width: 100%;
  height: auto;
  margin: 0 auto;
}
${s} .md-diagram-error {
  margin: 1em 0;
  padding: 0.6em 0.8em;
  border: 1px dashed #d1d9e0;
  border-radius: 4px;
  color: #59636e;
  font-size: 0.85em;
}
${s} .md-diagram-error pre {
  margin: 0.5em 0 0;
  padding: 0;
  border: 0;
  background: transparent;
  font-size: 0.95em;
}

/* highlight.js token colors (GitHub light) */
${s} .hljs-comment,
${s} .hljs-quote {
  color: #6e7781;
  font-style: italic;
}
${s} .hljs-keyword,
${s} .hljs-selector-tag,
${s} .hljs-type {
  color: #cf222e;
}
${s} .hljs-string,
${s} .hljs-regexp,
${s} .hljs-meta .hljs-string {
  color: #0a3069;
}
${s} .hljs-number,
${s} .hljs-literal {
  color: #0550ae;
}
${s} .hljs-variable,
${s} .hljs-template-variable,
${s} .hljs-params {
  color: #1f2328;
}
${s} .hljs-title,
${s} .hljs-title.function_,
${s} .hljs-function .hljs-title {
  color: #8250df;
}
${s} .hljs-title.class_,
${s} .hljs-built_in,
${s} .hljs-name {
  color: #953800;
}
${s} .hljs-attr,
${s} .hljs-attribute,
${s} .hljs-selector-attr,
${s} .hljs-selector-class,
${s} .hljs-selector-id,
${s} .hljs-symbol,
${s} .hljs-bullet,
${s} .hljs-link {
  color: #0550ae;
}
${s} .hljs-meta,
${s} .hljs-doctag {
  color: #116329;
}
${s} .hljs-section {
  color: #0550ae;
  font-weight: 600;
}
${s} .hljs-addition {
  color: #116329;
  background: #dafbe1;
}
${s} .hljs-deletion {
  color: #82071e;
  background: #ffebe9;
}
${s} .hljs-emphasis {
  font-style: italic;
}
${s} .hljs-strong {
  font-weight: 600;
}
${s} .hljs-subst {
  color: #1f2328;
}
`.trim();
}

/**
 * Stylesheet for the standalone HTML export and the long-image capture.
 * Scoped to `.md-export-article`, so it never leaks into the host page.
 */
export function exportArticleCss(options: ArticleStyleOptions = {}): string {
  return articleRules(".md-export-article", options);
}

/**
 * Print-only variant used while producing a PDF. It carries the same article
 * typography plus the pagination rules, and forces a white page.
 */
export function exportPrintCss(): string {
  return `
${articleRules("#md-print-root .md-export-article, #md-print-root article", DEFAULT_STYLE)}

@page {
  margin: 0;
}
html,
body {
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #000000;
  -webkit-print-color-adjust: exact;
  print-color-adjust: exact;
}
.md-export-hide,
aside,
nav,
header,
footer {
  display: none !important;
}
#md-print-root {
  position: static;
  background: #ffffff;
  color: #000000;
}
#md-print-root .md-export-article {
  max-width: none;
  margin: 0;
  padding: 0;
  background: #ffffff;
  color: #000000;
}
table,
pre,
blockquote,
img,
.md-diagram,
.md-math-display,
tr,
th,
td {
  break-inside: avoid;
  page-break-inside: avoid;
}
h1,
h2,
h3,
h4,
h5,
h6 {
  break-after: avoid;
  page-break-after: avoid;
}
`.trim();
}
