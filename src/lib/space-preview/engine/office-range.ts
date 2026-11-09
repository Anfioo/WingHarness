// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { zipSync } from 'fflate';
import { readRange } from '../bridge';
import { readZipDirectory, readZipEntry } from './zip-range';
import { parseInWorker } from '../worker/worker-client';
import type { PreviewFile } from '../bridge';

// Large Office containers often contain mostly pictures. Text/table engines only
// need XML, so build a bounded in-memory package without reading those pictures.
export async function readOfficeXmlPackage(file: PreviewFile, signal: AbortSignal) {
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    return readRange(file, offset, length);
  };
  const directory = await readZipDirectory(file.size, read);
  const listed = await parseInWorker(
    { kind: 'archive-directory', name: file.name, ...directory },
    signal,
  );
  const entries = listed.entries!.filter(
    (entry) =>
      !entry.directory && /\.(xml|rels)$/i.test(entry.name) && !/embeddings\//i.test(entry.name),
  );
  if (
    entries.length > 1000 ||
    entries.reduce((total, entry) => total + entry.size, 0) > 31 * 1024 * 1024 ||
    entries.some((entry) => entry.size > 8 * 1024 * 1024 || entry.compressed > 8 * 1024 * 1024)
  )
    throw new Error('文档 XML 超过 31 MB、1,000 个部分或单个部分超过 8 MB，请使用默认应用。');
  const parts: Record<string, Uint8Array> = Object.create(null);
  for (const entry of entries) {
    const bytes = await readZipEntry(entry, file.size, read);
    const result = await parseInWorker(
      { kind: 'archive-data', name: file.name, bytes, entry },
      signal,
    );
    parts[entry.name] = result.data!;
  }
  signal.throwIfAborted();
  return zipSync(parts, { level: 0 });
}
