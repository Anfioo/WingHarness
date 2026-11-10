// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { XMLParser } from 'fast-xml-parser';
import { strFromU8 } from 'fflate';
import { decodeText, extension } from './files';
import { extractZipEntries } from './archive';
import type { WorkbookSheet, WorkerResult } from '../worker/worker-types';

export function readDelimited(bytes: Uint8Array, name: string, partial = false): WorkbookSheet {
  const { text: decoded } = decodeText(bytes, 'auto', partial);
  const text = decoded.replace(/^\uFEFF/, '');
  let delimiter = extension(name) === 'csv' ? ',' : extension(name) === 'psv' ? '|' : '\t';
  if (delimiter === ',') {
    let quoted = false;
    let commas = 0,
      semicolons = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '"') quoted = !quoted;
      if (!quoted && /[\r\n]/.test(text[i])) break;
      if (!quoted && text[i] === ',') commas++;
      if (!quoted && text[i] === ';') semicolons++;
    }
    if (semicolons > commas) delimiter = ';';
  }
  const rows: string[][] = [];
  let row: string[] = [],
    field = '',
    quoted = false,
    closed = false,
    columns = 0;
  const cell = () => {
    row.push(field);
    field = '';
    closed = false;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (c === '"') {
        quoted = false;
        closed = true;
      } else field += c;
    } else if (c === delimiter) cell();
    else if (c === '\r' || c === '\n') {
      cell();
      rows.push(row);
      columns = Math.max(columns, row.length);
      row = [];
      if (c === '\r' && text[i + 1] === '\n') i++;
    } else if (c === '"' && !field && !closed) quoted = true;
    else {
      if (closed) throw new Error('Unexpected content follows a closing quote in the table.');
      field += c;
    }
  }
  if (quoted && !partial)
    throw new Error('The table has an unclosed quote and cannot be fully parsed.');
  if (!partial && (row.length || field || closed || text.endsWith(delimiter))) {
    cell();
    rows.push(row);
    columns = Math.max(columns, row.length);
  }
  return { name, rows, columns, truncated: false };
}

// Preserve XML order so inline spans, paragraphs and book chapters stay readable.
type Node = Record<string, any>;
const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  removeNSPrefix: true,
  parseTagValue: false,
  processEntities: true,
  htmlEntities: true,
});
const tag = (n: Node) => Object.keys(n).find((k) => k !== ':@') ?? '';
const kids = (n: Node): Node[] => (Array.isArray(n[tag(n)]) ? n[tag(n)] : []);
const attr = (n: Node, key: string): string => String(n[':@']?.[`@_${key}`] ?? '');
function find(nodes: Node[], name: string): Node[] {
  return nodes.flatMap((n) => (tag(n) === name ? [n] : find(kids(n), name)));
}
function xml(bytes: Uint8Array): Node[] {
  // EPUB 2 commonly declares the XHTML public DTD. Drop the declaration;
  // never load it, and still reject internal subsets/custom entity declarations.
  const source = strFromU8(bytes).replace(/<!DOCTYPE\s+html(?:\s+[^<>\[\]]*)?>/i, '');
  if (/<!DOCTYPE|<!ENTITY/i.test(source))
    throw new Error('The document contains an unsupported XML entity declaration.');
  return xmlParser.parse(source);
}
function text(n: Node): string {
  if (tag(n) === '#text') return String(n['#text']);
  if (tag(n) === 's') return ' '.repeat(Math.min(1000, Number(attr(n, 'c')) || 1));
  if (tag(n) === 'tab') return '\t';
  if (tag(n) === 'line-break' || tag(n) === 'br') return '\n';
  return kids(n).map(text).join('');
}
const escape = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function prose(nodes: Node[]): string {
  return nodes
    .map((n) => {
      const name = tag(n);
      if (['script', 'style', 'head', 'svg', 'math', 'iframe', 'object'].includes(name)) return '';
      if (name === '#text') return escape(text(n));
      const content = prose(kids(n));
      if (name === 'h') return `<h2>${content}</h2>`;
      if (name === 'table-row') return `<tr>${content}</tr>`;
      if (name === 'table-cell') return `<td>${content}</td>`;
      if (
        [
          'p',
          'h1',
          'h2',
          'h3',
          'h4',
          'h5',
          'h6',
          'table',
          'tr',
          'td',
          'th',
          'thead',
          'tbody',
          'ul',
          'ol',
          'li',
          'blockquote',
          'pre',
          'strong',
          'em',
          'code',
        ].includes(name)
      )
        return `<${name}>${content}</${name}>`;
      if (['br', 'line-break'].includes(name)) return '<br>';
      if (name === 's' || name === 'tab') return escape(text(n));
      return content;
    })
    .join('');
}
function extract(bytes: Uint8Array, names: string[]) {
  return extractZipEntries(bytes, new Set(names), 12 * 1024 * 1024, 48 * 1024 * 1024);
}
function repeat(n: Node, key: string, limit: number) {
  const value = Number(attr(n, key) || 1);
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, limit + 1) : 1;
}
export function readOpenDocument(
  bytes: Uint8Array,
  kind: 'odt' | 'ods' | 'odp',
  publish?: (value: WorkerResult) => void,
): WorkerResult {
  const content = extract(bytes, ['content.xml'])['content.xml'];
  if (!content) throw new Error('The OpenDocument content.xml was not found.');
  const nodes = xml(content);
  if (kind === 'odt') {
    const body = find(nodes, 'text')[0];
    if (!body) throw new Error('No valid OpenDocument text content was found.');
    const blocks = kids(body);
    let html = '';
    for (let index = 0; index < blocks.length; index += 200) {
      html += prose(blocks.slice(index, index + 200));
      publish?.({ html });
    }
    return { html };
  }
  if (kind === 'odp') {
    const pages = find(nodes, 'page');
    if (pages.length > 500) throw new Error('The presentation exceeds 500 slides.');
    const slides: NonNullable<WorkerResult['slides']> = [];
    pages.forEach((page, i) => {
      const paragraphs = find(kids(page), 'p').map(text).filter(Boolean);
      slides.push({
        title: paragraphs[0] || attr(page, 'name') || `Slide ${i + 1}`,
        paragraphs: paragraphs.slice(1),
      });
      publish?.({ slides });
    });
    return { slides };
  }
  const tables = find(nodes, 'table');
  if (tables.length > 100) throw new Error('The workbook exceeds 100 worksheets.');
  let cellBudget = 500_000;
  const sheets: WorkbookSheet[] = [];
  tables.forEach((table, i) => {
    const rows: string[][] = [];
    let columns = 0,
      truncated = false;
    for (const row of find(kids(table), 'table-row')) {
      const cells: string[] = [];
      for (const cell of kids(row).filter((n) =>
        ['table-cell', 'covered-table-cell'].includes(tag(n)),
      )) {
        const value =
          find(kids(cell), 'p').map(text).join('\n') ||
          attr(cell, 'string-value') ||
          attr(cell, 'date-value') ||
          attr(cell, 'time-value') ||
          attr(cell, 'boolean-value') ||
          attr(cell, 'value');
        const count = repeat(cell, 'number-columns-repeated', 100);
        if (count > 100 - cells.length && value) truncated = true;
        const available = Math.min(count, 100 - cells.length);
        for (let c = 0; c < available; c++) cells.push(value);
        if (cells.length === 100) break;
      }
      while (cells.length && !cells.at(-1)) cells.pop();
      const count = repeat(row, 'number-rows-repeated', 5000);
      if (count > 5000 - rows.length) truncated = true;
      const available = Math.min(count, 5000 - rows.length);
      cellBudget -= available * Math.max(1, cells.length);
      if (cellBudget < 0) throw new Error('The expanded workbook exceeds 500,000 cells.');
      for (let r = 0; r < available; r++) rows.push([...cells]);
      columns = Math.max(columns, cells.length);
      if (rows.length === 5000) {
        truncated = true;
        break;
      }
    }
    while (rows.length && !rows.at(-1)!.length) rows.pop();
    sheets.push({ name: attr(table, 'name') || `Sheet ${i + 1}`, rows, columns, truncated });
    publish?.({ sheets });
  });
  return { sheets };
}

function resolvePart(base: string, relative: string): string {
  if (/^[a-z]+:|^[/\\]/i.test(relative))
    throw new Error('The e-book contains an external or invalid chapter path.');
  const segments = base.split('/').slice(0, -1);
  for (const part of decodeURIComponent(relative.split('#')[0]).split('/')) {
    if (part === '..') {
      if (!segments.length) throw new Error('The e-book chapter path escapes the container.');
      segments.pop();
    } else if (part && part !== '.') segments.push(part);
  }
  return segments.join('/');
}
export function epubPackagePath(bytes: Uint8Array) {
  const container = extract(bytes, ['META-INF/container.xml'])['META-INF/container.xml'];
  if (!container) throw new Error('The EPUB container information was not found.');
  const root = find(xml(container), 'rootfile')[0];
  const packagePath = root && resolvePart('', attr(root, 'full-path'));
  if (!packagePath) throw new Error('The EPUB is missing its package document.');
  return packagePath;
}
export function epubIndex(bytes: Uint8Array) {
  const packagePath = epubPackagePath(bytes);
  const packageBytes = extract(bytes, [packagePath])[packagePath];
  if (!packageBytes) throw new Error('The EPUB package document does not exist.');
  const book = xml(packageBytes);
  const manifest = find(book, 'item');
  const spine = find(book, 'itemref').filter((n) => attr(n, 'linear') !== 'no');
  if (!spine.length || spine.length > 300)
    throw new Error('The EPUB has no valid chapters or exceeds 300 chapters.');
  const paths = spine.map((n) => {
    const item = manifest.find((m) => attr(m, 'id') === attr(n, 'idref'));
    if (!item || !['application/xhtml+xml', 'text/html'].includes(attr(item, 'media-type')))
      throw new Error('The EPUB contains an unsupported chapter format.');
    return resolvePart(packagePath, attr(item, 'href'));
  });
  return paths.map((path, index) => ({ path, name: `Chapter ${index + 1}` }));
}
export function readEpub(bytes: Uint8Array, selected?: number): WorkerResult {
  const paths = epubIndex(bytes)
    .filter((_, index) => selected === undefined || selected === index)
    .map((item) => item.path);
  const parts = extract(bytes, paths);
  return {
    chapters: paths.map((path, i) => {
      if (!parts[path]) throw new Error('The EPUB is missing chapter content.');
      const nodes = xml(parts[path]);
      const body = find(nodes, 'body')[0];
      if (!body)
        throw new Error('The EPUB chapter is unreadable; it may be encrypted or corrupt.');
      const heading =
        find(kids(body), 'h1')[0] || find(kids(body), 'h2')[0] || find(nodes, 'title')[0];
      return { title: heading ? text(heading) : `Chapter ${i + 1}`, html: prose(kids(body)) };
    }),
  };
}

export function readFictionBook(bytes: Uint8Array): WorkerResult {
  let source = decodeText(bytes).text;
  const declared = /<\?xml[^>]*\bencoding=["']([^"']+)["']/i.exec(source)?.[1];
  if (declared && !/^utf-16$/i.test(declared))
    source = new TextDecoder(declared, { fatal: true }).decode(bytes);
  const nodes = xml(new TextEncoder().encode(source));
  if (!find(nodes, 'FictionBook').length) throw new Error('This is not a valid FB2 e-book.');
  const bodies = find(nodes, 'body').filter((body) => attr(body, 'name') !== 'notes');
  if (!bodies.length) throw new Error('The FB2 has no readable body text.');
  const render = (nodes: Node[], level = 1): string =>
    nodes
      .map((node) => {
        const name = tag(node);
        if (name === 'binary' || name === 'image') return '';
        if (name === 'title')
          return `<h${Math.min(level, 6)}>${escape(text(node).trim())}</h${Math.min(level, 6)}>`;
        if (name === 'section') return render(kids(node), level + 1);
        if (name === 'emphasis') return `<em>${render(kids(node), level)}</em>`;
        if (name === 'strong') return `<strong>${render(kids(node), level)}</strong>`;
        if (name === 'empty-line') return '<p><br></p>';
        if (name === 'p' || name === 'subtitle') return `<p>${render(kids(node), level)}</p>`;
        if (name === '#text') return escape(text(node));
        return render(kids(node), level);
      })
      .join('');
  return {
    html: bodies.map((body) => render(kids(body))).join(''),
    note: 'FB2 text reading · covers, images and footnotes are not shown',
  };
}
