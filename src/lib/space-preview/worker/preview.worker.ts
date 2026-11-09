// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// Dispatches one parse request per message; the main thread transfers the bytes
// in and the result's buffers back out.
import hljs from '../engine/highlighter';
import { sourceLanguage } from '../engine/source-languages';
import { decodeHtml } from '../engine/html';
import { marked } from 'marked';
import { decodeText, extension } from '../engine/files';
import { listZip, extractZipEntries } from '../engine/archive';
import { readWorkbook, readSlides, officeIndex } from '../engine/office';
import {
  readDelimited,
  readOpenDocument,
  readEpub,
  readFictionBook,
  epubIndex,
  epubPackagePath,
} from '../engine/extra-formats';
import { readNotebook } from '../engine/notebook';
import type { WorkerRequest, WorkerResult } from './worker-types';
import { prepareDocx } from '../engine/docx';
import { parseZipDirectory, inflateZipEntry } from '../engine/zip-range';

const languages: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  py: 'python',
  rs: 'rust',
  sh: 'bash',
  yml: 'yaml',
  md: 'markdown',
  vue: 'xml',
  html: 'xml',
  cs: 'csharp',
  h: 'c',
  jsonc: 'json',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  htm: 'xml',
  xhtml: 'xml',
  svelte: 'xml',
  kt: 'kotlin',
  kts: 'kotlin',
  rb: 'ruby',
  cc: 'cpp',
  cxx: 'cpp',
  hxx: 'cpp',
  jsonl: 'json',
  ndjson: 'json',
  ipynb: 'json',
  tex: 'latex',
  ps1: 'powershell',
  cfg: 'ini',
  properties: 'ini',
};
marked.use({
  renderer: {
    code({ text, lang }) {
      const language = (lang || '').split(/\s+/)[0];
      const html = hljs.highlight(text, {
        language: hljs.getLanguage(language) ? language : 'plaintext',
        ignoreIllegals: true,
      }).value;
      return `<pre><code>${html}</code></pre>`;
    },
  },
});
self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  try {
    const { kind, bytes, name } = event.data;
    const publish = event.data.progressive
      ? (result: WorkerResult) => self.postMessage({ type: 'partial-result', result })
      : undefined;
    let result: WorkerResult;
    if (event.data.phase === 'package' && kind === 'epub')
      result = { units: [{ path: epubPackagePath(bytes), name: '清单' }] };
    else if (
      event.data.phase === 'index' &&
      (kind === 'xlsx' || kind === 'pptx' || kind === 'epub')
    )
      result = { units: kind === 'epub' ? epubIndex(bytes) : officeIndex(bytes, kind) };
    else if (kind === 'tiff')
      result = { raster: (await import('../engine/tiff')).readTiff(bytes, event.data.page) };
    else if (kind === 'mail')
      result = { mail: await (await import('../engine/mail')).readMail(bytes, name) };
    else if (kind === 'web-archive')
      result = { webArchive: await (await import('../engine/web-archive')).readWebArchive(bytes) };
    else if (kind === 'legacy-doc')
      result = (await import('../engine/legacy-office')).readLegacyWord(bytes);
    else if (kind === 'legacy-ppt')
      result = (await import('../engine/legacy-office')).readLegacySlides(bytes);
    else if (kind === 'metafile')
      result = {
        data: bytes,
        metafile: (await import('../engine/metafile')).metafileBounds(
          bytes,
          extension(name) === 'emf',
        ),
      };
    else if (kind === 'package-directory' || kind === 'compound-data') {
      const container = await import('../engine/package-container');
      const ext = extension(name);
      result =
        ext === 'asar'
          ? { entries: container.parseAsar(bytes, event.data.fileSize!) }
          : ext === 'pak'
            ? { entries: container.parsePak(bytes, event.data.fileSize!) }
            : ext === 'xar'
              ? {
                  entries: (await import('../engine/xar-container')).parseXar(
                    bytes,
                    event.data.fileSize!,
                  ),
                }
              : await container.readCompound(
                  bytes,
                  kind === 'compound-data' ? event.data.entry!.index : undefined,
                  event.data.archiveEntryLimit,
                );
    } else if (kind === 'xar-data') {
      const entry = event.data.entry!;
      if (entry.method === 0) {
        if (bytes.length !== entry.size) throw new Error('XAR 条目大小不一致。');
        result = { data: bytes };
      } else if (entry.method === 8)
        result = {
          data: (await import('../engine/xar-container')).inflateZlib(
            bytes,
            entry.size,
            event.data.archiveEntryLimit,
          ),
        };
      else throw new Error('XAR 条目压缩算法尚未支持。');
    } else if (kind === 'archive') result = { entries: listZip(bytes) };
    else if (kind === 'archive-directory')
      result = { entries: parseZipDirectory(bytes, event.data.count!) };
    else if (kind === 'archive-data')
      result = { data: inflateZipEntry(bytes, event.data.entry!, event.data.archiveEntryLimit) };
    else if (kind === 'archive-decompress') {
      const ext = extension(name);
      result = {
        data: await (
          await import('../engine/compressed-stream')
        ).decompressArchiveStream(bytes, ext, event.data.archiveEntryLimit),
      };
    } else if (kind === 'docx-layout') result = { data: prepareDocx(bytes) };
    else if (kind === 'csv')
      result = {
        sheets: [readDelimited(bytes, name, event.data.partial)],
        note: '只读表格 · 保留原始单元格内容',
      };
    else if (kind === 'odt' || kind === 'ods' || kind === 'odp')
      result = readOpenDocument(bytes, kind, publish);
    else if (kind === 'epub') result = readEpub(bytes, event.data.unit);
    else if (kind === 'fb2') result = readFictionBook(bytes);
    else if (kind === 'notebook')
      result = await readNotebook(
        bytes,
        async (text) => await marked.parse(text),
        (text, language) =>
          hljs.highlight(text, {
            language: hljs.getLanguage(language) ? language : 'plaintext',
            ignoreIllegals: true,
          }).value,
      );
    else if (kind === 'xlsx') result = { sheets: readWorkbook(bytes, event.data.unit) };
    else if (kind === 'legacy-xlsx')
      result = {
        sheets: await (
          await import('../engine/legacy-workbook')
        ).readLegacyWorkbook(bytes, name, publish ? (sheets) => publish({ sheets }) : undefined),
        note: '只读表格 · 显示已保存的值，不执行宏',
      };
    else if (kind === 'asciidoc') {
      const { default: initialize } = await import('@asciidoctor/core');
      const decoded = decodeText(bytes, event.data.encoding, event.data.partial);
      result = {
        html: String(initialize().convert(decoded.text, { safe: 'secure', header_footer: false })),
        encoding: decoded.encoding,
      };
    } else if (kind === 'animation')
      result = {
        animation: (await import('../engine/animation')).readAnimation(bytes, name, event.data.page),
      };
    else if (kind === 'pptx') result = { slides: readSlides(bytes, event.data.unit) };
    else if (kind === 'archive-entry') {
      const entry = listZip(bytes).find((e) => e.name === event.data.entryName && !e.directory);
      if (!entry) throw new Error('压缩包条目不存在。');
      if (entry.size > 8 * 1024 * 1024) throw new Error('内部文件超过 8 MB 预览上限。');
      const data = extractZipEntries(
        bytes,
        new Set([entry.name]),
        8 * 1024 * 1024,
        8 * 1024 * 1024,
      )[entry.name];
      if (!data || data.length > 8 * 1024 * 1024) throw new Error('内部文件无法读取或解压后过大。');
      result = { data };
    } else if (kind === 'docx') {
      const mammoth = await import('mammoth/mammoth.browser');
      const verified = prepareDocx(bytes, false);
      const doc = await mammoth.convertToHtml(
        { arrayBuffer: verified.buffer as ArrayBuffer },
        { convertImage: mammoth.images.imgElement(async () => ({ src: '' })) },
      );
      result = { html: doc.value };
    } else {
      const ext = extension(name);
      // eslint-disable-next-line prefer-const -- `text` is reassigned below; `encoding` shares the destructuring.
      let { text, encoding } =
        kind === 'html' || ['html', 'htm', 'xhtml'].includes(ext)
          ? decodeHtml(bytes, event.data.encoding, event.data.partial)
          : decodeText(bytes, event.data.encoding, event.data.partial);
      if (ext === 'json') {
        try {
          text = JSON.stringify(JSON.parse(text), null, 2);
        } catch {
          /* Keep incomplete or invalid JSON readable. */
        }
      }
      const language = languages[ext] ?? sourceLanguage(name);
      const html =
        kind === 'html'
          ? text
          : kind === 'markdown'
            ? await marked.parse(text)
            : hljs.highlight(text, {
                language: hljs.getLanguage(language) ? language : 'plaintext',
                ignoreIllegals: true,
              }).value;
      result = { text, html, encoding, language, lines: text.split('\n').length };
    }
    if (result.raster) self.postMessage(result, { transfer: [result.raster.pixels.buffer] });
    else if (result.data) self.postMessage(result, { transfer: [result.data.buffer] });
    else self.postMessage(result);
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
