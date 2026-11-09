// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { zipSync } from 'fflate';
import { readRange } from '../bridge';
import { readZipDirectory, readZipEntry } from './zip-range';
import { parseInWorker } from '../worker/worker-client';
import type { PreviewFile } from '../bridge';

// Read the layout XML first; large picture payloads are fetched only when the renderer requests them.
export async function readWordPackage(file: PreviewFile, signal: AbortSignal) {
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    const bytes = await readRange(file, offset, length);
    signal.throwIfAborted();
    return bytes;
  };
  const directory = await readZipDirectory(file.size, read);
  const listed = await parseInWorker(
    { kind: 'archive-directory', name: file.name, ...directory },
    signal,
  );
  const entries = listed.entries!.filter(
    (entry) => !entry.directory && !/vbaProject|embeddings\//i.test(entry.name),
  );
  const xml = entries.filter((entry) => /\.(xml|rels)$/i.test(entry.name));
  if (!xml.some((entry) => entry.name === 'word/document.xml'))
    throw new Error('文件不是有效的 DOCX。');
  if (
    xml.length > 1000 ||
    xml.some((entry) => entry.size > 16 * 1024 * 1024) ||
    xml.reduce((sum, entry) => sum + entry.size, 0) > 64 * 1024 * 1024
  )
    throw new Error('文档结构超过预览上限。');
  const parts: Record<string, Uint8Array> = Object.create(null);
  for (const entry of xml) {
    const bytes = await readZipEntry(entry, file.size, read);
    const result = await parseInWorker(
      { kind: 'archive-data', bytes, name: file.name, entry },
      signal,
    );
    parts[entry.name] = result.data!;
  }
  const verified = await parseInWorker(
    { kind: 'docx-layout', bytes: zipSync(parts, { level: 0 }), name: file.name },
    signal,
  );
  let queue = Promise.resolve();
  let resourceBytes = 0;
  const cached = new Map<string, Promise<Uint8Array | null>>();
  return {
    data: verified.data!,
    resource(path: string) {
      const name = path.replace(/^\//, '');
      if (cached.has(name)) return cached.get(name)!;
      const entry = entries.find((item) => item.name === name);
      if (!entry || /\.(xml|rels)$/i.test(name)) return Promise.resolve(null);
      // Preserve request order (front pages first), bound memory, and yield before reading pictures.
      const task = queue.then(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        signal.throwIfAborted();
        if (entry.size > 16 * 1024 * 1024 || resourceBytes + entry.size > 64 * 1024 * 1024)
          throw new Error('图片或字体超过预览资源上限。');
        resourceBytes += entry.size;
        const bytes = await readZipEntry(entry, file.size, read);
        const result = await parseInWorker(
          { kind: 'archive-data', bytes, name: file.name, entry },
          signal,
        );
        return result.data!;
      });
      queue = task.then(
        () => {},
        () => {},
      );
      cached.set(name, task);
      return task;
    },
  };
}
