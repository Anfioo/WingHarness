// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { readFullBytes, readRange } from '../bridge';
import { extension } from './files'
import type { PreviewFile } from '../bridge';
import { asarHeaderSize, crxZipOffset, pakHeaderSize } from './package-container';
import { readZipDirectory, readZipEntry, readArchiveRange } from './zip-range';
import { parseInWorker } from '../worker/worker-client';
import type { ArchiveEntry } from '../worker/worker-types';
import { xarHeader } from './xar-container';

export const packageFormats = ['asar', 'crx', 'cfb', 'eif', 'pak', 'msi', 'msp', 'xar'];
export async function openPackage(file: PreviewFile, signal: AbortSignal) {
  const ext = extension(file.name);
  const read = async (offset: number, length: number) => {
    signal.throwIfAborted();
    const bytes = await readArchiveRange(
      (offset, length) => {
        signal.throwIfAborted();
        return readRange(file, offset, length);
      },
      offset,
      length,
    );
    signal.throwIfAborted();
    return bytes;
  };
  if (ext === 'crx') {
    const base = crxZipOffset(await read(0, 16), file.size);
    const zipRead = (offset: number, length: number) => read(base + offset, length);
    const directory = await readZipDirectory(file.size - base, zipRead);
    const parsed = await parseInWorker(
      { kind: 'archive-directory', name: file.name, ...directory },
      signal,
    );
    return {
      entries: parsed.entries!,
      close: () => {},
      async extract(entry: ArchiveEntry, limit = 256 * 1024 * 1024) {
        if (entry.size > limit || entry.compressed > limit)
          throw new Error('The inner file exceeds the configured limit.');
        const bytes = await readZipEntry(entry, file.size - base, zipRead, limit);
        const result = await parseInWorker(
          { kind: 'archive-data', name: file.name, bytes, entry, archiveEntryLimit: limit },
          signal,
        );
        return new Blob([result.data as Uint8Array<ArrayBuffer>]);
      },
    };
  }
  const compound = ['cfb', 'eif', 'msi', 'msp'].includes(ext);
  const xar = ext === 'xar' ? xarHeader(await read(0, 28)) : undefined;
  const length = compound
    ? file.size
    : xar
      ? xar.header + xar.compressed
      : ext === 'asar'
        ? asarHeaderSize(await read(0, 16))
        : pakHeaderSize(await read(0, 12));
  if (length > file.size) throw new Error('The container directory is truncated.');
  const parsed = await parseInWorker(
    {
      kind: 'package-directory',
      name: file.name,
      bytes: compound ? await readFullBytes(file, signal) : await read(0, length),
      fileSize: file.size,
    },
    signal,
  );
  return {
    entries: parsed.entries!,
    close: () => {},
    async extract(entry: ArchiveEntry, limit = 256 * 1024 * 1024) {
      if (entry.size > limit || entry.compressed > limit) throw new Error('The inner file exceeds the configured limit.');
      if (xar) {
        if (entry.compressed > limit || ![0, 8].includes(entry.method!))
          throw new Error('The compression method of this XAR entry is not supported yet or exceeds the configured limit.');
        const bytes = await read(entry.offset!, entry.compressed);
        const result = await parseInWorker(
          { kind: 'xar-data', name: file.name, bytes, entry, archiveEntryLimit: limit },
          signal,
        );
        return new Blob([result.data as Uint8Array<ArrayBuffer>]);
      }
      if (!compound)
        return new Blob([(await read(entry.offset!, entry.size)) as Uint8Array<ArrayBuffer>]);
      const result = await parseInWorker(
        {
          kind: 'compound-data',
          name: file.name,
          bytes: await readFullBytes(file, signal),
          entry,
          archiveEntryLimit: limit,
        },
        signal,
      );
      return new Blob([result.data as Uint8Array<ArrayBuffer>]);
    },
  };
}
