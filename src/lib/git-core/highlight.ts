import type { DiffHunk, DiffLine } from "@/lib/git-core/types";
import hljs from "highlight.js/lib/core";
import typescript from "highlight.js/lib/languages/typescript";
import javascript from "highlight.js/lib/languages/javascript";
import rust from "highlight.js/lib/languages/rust";
import python from "highlight.js/lib/languages/python";
import go from "highlight.js/lib/languages/go";
import java from "highlight.js/lib/languages/java";
import csharp from "highlight.js/lib/languages/csharp";
import cpp from "highlight.js/lib/languages/cpp";
import css from "highlight.js/lib/languages/css";
import less from "highlight.js/lib/languages/less";
import scss from "highlight.js/lib/languages/scss";
import xml from "highlight.js/lib/languages/xml";
import json from "highlight.js/lib/languages/json";
import yaml from "highlight.js/lib/languages/yaml";
import bash from "highlight.js/lib/languages/bash";
import markdown from "highlight.js/lib/languages/markdown";
import sql from "highlight.js/lib/languages/sql";
import ruby from "highlight.js/lib/languages/ruby";
import php from "highlight.js/lib/languages/php";
import kotlin from "highlight.js/lib/languages/kotlin";
import swift from "highlight.js/lib/languages/swift";
import ini from "highlight.js/lib/languages/ini";
import properties from "highlight.js/lib/languages/properties";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import makefile from "highlight.js/lib/languages/makefile";
import cmake from "highlight.js/lib/languages/cmake";

hljs.registerLanguage("typescript", typescript);
hljs.registerLanguage("javascript", javascript);
hljs.registerLanguage("rust", rust);
hljs.registerLanguage("python", python);
hljs.registerLanguage("go", go);
hljs.registerLanguage("java", java);
hljs.registerLanguage("csharp", csharp);
hljs.registerLanguage("cpp", cpp);
hljs.registerLanguage("css", css);
hljs.registerLanguage("less", less);
hljs.registerLanguage("scss", scss);
hljs.registerLanguage("xml", xml);
hljs.registerLanguage("json", json);
hljs.registerLanguage("yaml", yaml);
hljs.registerLanguage("bash", bash);
hljs.registerLanguage("markdown", markdown);
hljs.registerLanguage("sql", sql);
hljs.registerLanguage("ruby", ruby);
hljs.registerLanguage("php", php);
hljs.registerLanguage("kotlin", kotlin);
hljs.registerLanguage("swift", swift);
hljs.registerLanguage("ini", ini);
hljs.registerLanguage("properties", properties);
hljs.registerLanguage("dockerfile", dockerfile);
hljs.registerLanguage("makefile", makefile);
hljs.registerLanguage("cmake", cmake);

const BASENAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
  makefile: "makefile",
  gnumakefile: "makefile",
  "cmakelists.txt": "cmake",
  ".editorconfig": "ini",
};

const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  rs: "rust",
  py: "python",
  pyi: "python",
  go: "go",
  java: "java",
  cs: "csharp",
  c: "cpp",
  h: "cpp",
  cc: "cpp",
  cpp: "cpp",
  hpp: "cpp",
  hh: "cpp",
  hxx: "cpp",
  cxx: "cpp",
  ino: "cpp",
  css: "css",
  less: "less",
  scss: "scss",
  html: "xml",
  htm: "xml",
  svg: "xml",
  xml: "xml",
  vue: "xml",
  svelte: "xml",
  astro: "astro",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  sh: "bash",
  zsh: "bash",
  bash: "bash",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  rb: "ruby",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  ini: "ini",
  toml: "ini",
  properties: "properties",
  cmake: "cmake",
};

const FRONTMATTER_LANGUAGES: Record<string, string> = { astro: "typescript" };
const MARKUP_GRAMMARS: Record<string, string> = { astro: "xml" };

function grammarOf(language: string): string {
  return MARKUP_GRAMMARS[language] ?? language;
}

const FENCE = "---";
const SCRIPT_OPEN = /^\s*<script\b([^>]*)>/i;
const SCRIPT_CLOSE = /<\/script\s*>/i;
const STYLE_OPEN = /^\s*<style\b([^>]*)>/i;
const STYLE_CLOSE = /<\/style\s*>/i;
const LANG_ATTR = /\blang\s*=\s*["']?([\w-]+)/i;

interface Region {
  language: string;
  close: RegExp;
}

function scriptLanguage(attrs: string, language: string): string {
  if (language === "astro") return "typescript";
  const lang = LANG_ATTR.exec(attrs)?.[1]?.toLowerCase();
  return lang === "ts" || lang === "typescript" ? "typescript" : "javascript";
}

function styleLanguage(attrs: string): string {
  const lang = LANG_ATTR.exec(attrs)?.[1]?.toLowerCase();
  return lang === "scss" || lang === "less" ? lang : "css";
}

function openedRegion(content: string, language: string): Region | null {
  const script = SCRIPT_OPEN.exec(content);
  if (script && !SCRIPT_CLOSE.test(content)) {
    return { language: scriptLanguage(script[1], language), close: SCRIPT_CLOSE };
  }
  const style = STYLE_OPEN.exec(content);
  if (style && !STYLE_CLOSE.test(content)) {
    return { language: styleLanguage(style[1]), close: STYLE_CLOSE };
  }
  return null;
}

function closedRegionLanguage(content: string, language: string): string | null {
  if (SCRIPT_CLOSE.test(content)) return scriptLanguage("", language);
  if (STYLE_CLOSE.test(content)) return "css";
  return null;
}

function hasEmbeddedLanguages(language: string | null): language is string {
  return language !== null && grammarOf(language) === "xml";
}

interface EmbedWalk<T> {
  mode: "unknown" | "front" | "body" | "region";
  region: Region | null;
  pending: T[];
}

function newWalk<T>(): EmbedWalk<T> {
  return { mode: "unknown", region: null, pending: [] };
}

function embedStep<T>(
  walk: EmbedWalk<T>,
  lineNo: number | null,
  content: string,
  item: T,
  language: string,
  mark: (item: T, lang: string) => void
): void {
  const frontmatter = FRONTMATTER_LANGUAGES[language];
  const isFence = frontmatter !== undefined && content.trim() === FENCE;
  if (lineNo === 1) {
    walk.pending = [];
    walk.region = null;
    if (isFence) {
      walk.mode = "front";
      return;
    }
    walk.mode = "body";
  }
  if (walk.mode === "front") {
    if (isFence) walk.mode = "body";
    else mark(item, frontmatter as string);
    return;
  }
  if (walk.mode === "region" && walk.region) {
    if (walk.region.close.test(content)) {
      walk.mode = "body";
      walk.region = null;
    } else {
      mark(item, walk.region.language);
    }
    return;
  }
  const opened = openedRegion(content, language);
  if (opened) {
    walk.mode = "region";
    walk.region = opened;
    walk.pending = [];
    return;
  }
  if (walk.mode !== "unknown") return;
  const closed = isFence ? (frontmatter as string) : closedRegionLanguage(content, language);
  if (closed === null) {
    walk.pending.push(item);
    return;
  }
  for (const pending of walk.pending) mark(pending, closed);
  walk.pending = [];
  walk.mode = "body";
}

export function embeddedLanguages(lines: string[], language: string | null): string[] | null {
  if (!hasEmbeddedLanguages(language)) return null;
  const result = lines.map(() => language);
  const walk = newWalk<number>();
  lines.forEach((content, index) => {
    embedStep(walk, index + 1, content, index, language, (i, lang) => {
      result[i] = lang;
    });
  });
  return result;
}

export function embeddedDiffLanguages(
  hunks: DiffHunk[],
  language: string | null
): Map<DiffLine, string> | null {
  if (!hasEmbeddedLanguages(language)) return null;
  const marked = new Map<DiffLine, string>();
  const mark = (line: DiffLine, lang: string) => marked.set(line, lang);
  for (const hunk of hunks) {
    const oldWalk = newWalk<DiffLine>();
    const newWalk_ = newWalk<DiffLine>();
    for (const line of hunk.lines) {
      if (line.kind !== "addition")
        embedStep(oldWalk, line.oldLineNo, line.content, line, language, mark);
      if (line.kind !== "deletion")
        embedStep(newWalk_, line.newLineNo, line.content, line, language, mark);
    }
  }
  return marked;
}

function fileName(path: string): string {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return (slash >= 0 ? path.slice(slash + 1) : path).toLowerCase();
}

export function languageOf(path: string): string | null {
  const name = fileName(path);
  const byName = BASENAME_TO_LANG[name];
  if (byName) return byName;
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  return EXT_TO_LANG[name.slice(dot + 1)] ?? null;
}

const MAX_HIGHLIGHT_LENGTH = 5000;
const CACHE_MAX = 4000;

const BLOCK_COMMENT_OPENERS: Record<string, string> = {
  typescript: "/*",
  javascript: "/*",
  rust: "/*",
  go: "/*",
  java: "/*",
  csharp: "/*",
  cpp: "/*",
  css: "/*",
  less: "/*",
  scss: "/*",
  kotlin: "/*",
  swift: "/*",
  php: "/*",
  sql: "/*",
  xml: "<!--",
};

export function supportsBlockComments(language: string | null): boolean {
  return language !== null && grammarOf(language) in BLOCK_COMMENT_OPENERS;
}

export interface HighlightedLine {
  html: string;
  endsInComment: boolean;
}

interface ModeChain {
  scope?: string;
  className?: string;
  endRe?: RegExp;
  parent?: ModeChain;
}

const GLUED_TO_WORD = /[\w$/>]$/;

function decodeEntities(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&");
}

function openerGluedToCode(html: string): boolean {
  const index = html.lastIndexOf('<span class="hljs-comment">');
  if (index < 0) return false;
  const before = decodeEntities(html.slice(0, index).replace(/<[^>]+>/g, ""));
  return GLUED_TO_WORD.test(before);
}

function endsInBlockComment(top: unknown): boolean {
  let mode = top as ModeChain | undefined;
  while (mode) {
    if (mode.scope === "comment" || mode.className === "comment") {
      return mode.endRe instanceof RegExp && !mode.endRe.test("");
    }
    mode = mode.parent;
  }
  return false;
}

const highlightCache = new Map<string, HighlightedLine>();

export function highlightLineState(
  code: string,
  language: string | null,
  startsInComment = false
): HighlightedLine {
  if (!language || code.length > MAX_HIGHLIGHT_LENGTH) {
    return { html: escapeHtml(code), endsInComment: false };
  }
  const grammar = grammarOf(language);
  const opener = BLOCK_COMMENT_OPENERS[grammar];
  const continued = startsInComment && opener !== undefined;
  const key = `${grammar} ${continued ? 1 : 0} ${code}`;
  const cached = highlightCache.get(key);
  if (cached !== undefined) {
    highlightCache.delete(key);
    highlightCache.set(key, cached);
    return cached;
  }
  let result: HighlightedLine;
  try {
    const out = hljs.highlight(continued ? opener + code : code, {
      language: grammar,
      ignoreIllegals: true,
    });
    let html = out.value;
    if (continued) {
      const escapedOpener = opener.replace(/</g, "&lt;");
      const index = html.indexOf(escapedOpener);
      if (index >= 0) html = html.slice(0, index) + html.slice(index + escapedOpener.length);
    }
    result = {
      html,
      endsInComment:
        opener !== undefined && endsInBlockComment(out._top) && !openerGluedToCode(out.value),
    };
  } catch {
    result = { html: escapeHtml(code), endsInComment: false };
  }
  if (highlightCache.size >= CACHE_MAX) {
    highlightCache.delete(highlightCache.keys().next().value as string);
  }
  highlightCache.set(key, result);
  return result;
}

export function highlightLine(code: string, language: string | null): string {
  return highlightLineState(code, language).html;
}

/**
 * Highlights a whole document in one pass.
 *
 * A grammar id that is not registered returns null instead of throwing, so the
 * caller can render the text unchanged.
 */
export function highlightText(text: string, language: string | null): string | null {
  if (!language) return null;
  try {
    return hljs.highlight(text, { language: grammarOf(language), ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
