// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { ArchiveEntry } from '../worker/worker-types';

const LIMIT = 100_000;
function span(offset: number, length: number, total: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset > total - length
  )
    throw new Error('The container entry offset or size is invalid.');
}

export function asarHeaderSize(bytes: Uint8Array) {
  if (bytes.length < 16) throw new Error('The ASAR header is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== 4) throw new Error('The ASAR file signature is invalid.');
  const size = view.getUint32(4, true);
  if (size < 8 || size > 16 * 1024 * 1024) throw new Error('The ASAR directory size is invalid or exceeds 16 MB.');
  return 8 + size;
}

export function parseAsar(bytes: Uint8Array, total: number): ArchiveEntry[] {
  const base = asarHeaderSize(bytes);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = view.getUint32(12, true);
  span(16, length, Math.min(base, bytes.length));
  const root = JSON.parse(
    new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(16, 16 + length)),
  );
  const stack: { path: string; node: Record<string, unknown> }[] = [{ path: '', node: root }];
  const entries: ArchiveEntry[] = [];
  while (stack.length) {
    const { path, node } = stack.pop()!;
    if (!node || typeof node !== 'object') throw new Error('The ASAR directory structure is invalid.');
    if (path.length > 4096 || entries.length + stack.length > LIMIT)
      throw new Error('The ASAR directory is too large.');
    if (node.files && typeof node.files === 'object') {
      if (path)
        entries.push({
          name: path + '/',
          directory: true,
          size: 0,
          compressed: 0,
          index: entries.length,
        });
      for (const [name, child] of Object.entries(node.files)) {
        if (!name || /[/\\]/.test(name) || name === '.' || name === '..')
          throw new Error('The ASAR file name is invalid.');
        stack.push({
          path: path ? `${path}/${name}` : name,
          node: child as Record<string, unknown>,
        });
      }
    } else if (!node.link && !node.unpacked) {
      const size = Number(node.size),
        offset = base + Number(node.offset);
      span(offset, size, total);
      entries.push({
        name: path,
        directory: false,
        size,
        compressed: size,
        offset,
        index: entries.length,
        sourcePath: path,
      });
    }
  }
  return entries;
}

export function crxZipOffset(bytes: Uint8Array, total: number) {
  if (bytes.length < 16 || new TextDecoder().decode(bytes.subarray(0, 4)) !== 'Cr24')
    throw new Error('The CRX file signature is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(4, true);
  const offset =
    version === 2
      ? 16 + view.getUint32(8, true) + view.getUint32(12, true)
      : version === 3
        ? 12 + view.getUint32(8, true)
        : -1;
  span(offset, 22, total);
  return offset;
}

export function pakHeaderSize(bytes: Uint8Array) {
  if (bytes.length < 12) throw new Error('The PAK header is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true);
  const count =
    version === 4 ? view.getUint32(4, true) : version === 5 ? view.getUint16(8, true) : -1;
  const aliases = version === 5 ? view.getUint16(10, true) : 0;
  if (count < 0 || count + aliases > LIMIT)
    throw new Error('Only Chromium DataPack v4/v5 is supported; other PAK game containers are not supported yet.');
  return (version === 4 ? 9 : 12) + (count + 1) * 6 + aliases * 4;
}

export function parsePak(bytes: Uint8Array, total: number): ArchiveEntry[] {
  const header = pakHeaderSize(bytes);
  if (bytes.length < header) throw new Error('The PAK directory is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const version = view.getUint32(0, true),
    start = version === 4 ? 9 : 12;
  const count = version === 4 ? view.getUint32(4, true) : view.getUint16(8, true);
  const entries = Array.from({ length: count }, (_, index) => {
    const record = start + index * 6,
      offset = view.getUint32(record + 2, true);
    const end = view.getUint32(record + 8, true);
    span(offset, end - offset, total);
    if (offset < header) throw new Error('The PAK data overlaps the directory.');
    const name = `resource-${view.getUint16(record, true)}.dat`;
    return {
      name,
      directory: false,
      offset,
      size: end - offset,
      compressed: end - offset,
      index,
      sourcePath: name,
    };
  });
  const aliases = version === 5 ? view.getUint16(10, true) : 0;
  for (let i = 0; i < aliases; i++) {
    const position = start + (count + 1) * 6 + i * 4;
    const target = view.getUint16(position + 2, true);
    if (target >= entries.length) throw new Error('The PAK alias index is invalid.');
    const name = `resource-${view.getUint16(position, true)}.dat`;
    entries.push({ ...entries[target], name, sourcePath: name, index: entries.length });
  }
  return entries;
}

export async function readCompound(bytes: Uint8Array, index?: number, limit = 256 * 1024 * 1024) {
  if (
    bytes.length < 512 ||
    new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0, true) !== 0xe011cfd0
  )
    throw new Error('The OLE compound document signature is invalid.');
  const { CFB } = await import('xlsx');
  const compound = CFB.read(bytes, { type: 'array' }) as {
    FullPaths: string[];
    FileIndex: { type: number; size: number; content?: Uint8Array }[];
  };
  if (compound.FullPaths.length > LIMIT) throw new Error('The compound document directory is too large.');
  if (index !== undefined) {
    const stream = compound.FileIndex[index];
    if (!stream || stream.type !== 2 || !stream.content) throw new Error('The compound document stream does not exist.');
    if (stream.size > limit) throw new Error('The compound document stream exceeds the configured limit.');
    return { data: Uint8Array.from(stream.content) };
  }
  const root = compound.FullPaths[0];
  const entries = compound.FullPaths.flatMap((path, index): ArchiveEntry[] => {
    const stream = compound.FileIndex[index];
    if (!index || ![1, 2].includes(stream.type)) return [];
    const name = path.startsWith(root) ? path.slice(root.length) : path;
    return [
      {
        name,
        directory: stream.type === 1,
        size: stream.size,
        compressed: -1,
        index,
        sourcePath: path,
      },
    ];
  });
  return { entries };
}
