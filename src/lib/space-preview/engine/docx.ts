// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { zipSync } from 'fflate';
import { listZip, extractZipEntries } from './archive';
import { resolveWordThemeFonts } from './word-fonts';

export function prepareDocx(bytes: Uint8Array, includeMedia = true): Uint8Array {
  const entries = listZip(bytes).filter(
    (e) =>
      !e.directory &&
      !/vbaProject|embeddings\//i.test(e.name) &&
      (includeMedia || !/^word\/(media|fonts)\//i.test(e.name)),
  );
  if (!entries.some((e) => e.name === 'word/document.xml'))
    throw new Error('文件不是有效的 DOCX。旧版 DOC 需先另存为 DOCX。');
  if (
    entries.some((e) => e.size > 16 * 1024 * 1024) ||
    entries.reduce((n, e) => n + e.size, 0) > 64 * 1024 * 1024
  )
    throw new Error('文档展开内容超过预览上限。');
  const parts = extractZipEntries(
    bytes,
    new Set(entries.map((e) => e.name)),
    16 * 1024 * 1024,
    64 * 1024 * 1024,
  );
  for (const [name, data] of Object.entries(parts)) {
    if (/\.(xml|rels)$/i.test(name) && /<!DOCTYPE|<!ENTITY/i.test(new TextDecoder().decode(data)))
      throw new Error('文档包含不受支持的 XML 实体声明。');
  }
  // Stored entries avoid a costly compression pass before the renderer reads them.
  if (includeMedia) resolveWordThemeFonts(parts);
  return zipSync(parts, { level: 0 });
}
