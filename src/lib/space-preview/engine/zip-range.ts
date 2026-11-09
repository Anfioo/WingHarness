// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { Inflate } from 'fflate';
import type { ArchiveEntry } from '../worker/worker-types';

export type RangeReader = (offset: number, length: number) => Promise<Uint8Array>;
export const ZIP_DIRECTORY_LIMIT = 16 * 1024 * 1024;
export const ZIP_ENTRY_LIMIT = 32 * 1024 * 1024;
const viewOf = (b: Uint8Array) => new DataView(b.buffer, b.byteOffset, b.byteLength);
function uint64(view: DataView, offset: number) {
  const value = Number(view.getBigUint64(offset, true));
  if (!Number.isSafeInteger(value)) throw new Error('The ZIP64 offset is outside the safely readable range.');
  return value;
}
export async function readZipDirectory(size: number, read: RangeReader) {
  const tailOffset = Math.max(0, size - 65557 - 20);
  const tail = await read(tailOffset, size - tailOffset);
  const view = viewOf(tail);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === tail.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Not a complete, valid ZIP file.');
  if (view.getUint16(end + 4, true) || view.getUint16(end + 6, true))
    throw new Error('Multi-volume ZIP is not supported yet.');
  let count = view.getUint16(end + 10, true);
  let length = view.getUint32(end + 12, true);
  let offset = view.getUint32(end + 16, true);
  let directoryEnd = tailOffset + end;
  if (count === 65535 || length === 0xffffffff || offset === 0xffffffff) {
    if (end < 20 || view.getUint32(end - 20, true) !== 0x07064b50)
      throw new Error('The ZIP64 locator record is corrupt.');
    if (view.getUint32(end - 16, true) !== 0 || view.getUint32(end - 4, true) !== 1)
      throw new Error('Multi-volume ZIP64 is not supported yet.');
    directoryEnd = uint64(view, end - 12);
    const record = await read(directoryEnd, 56);
    const zip64 = viewOf(record);
    if (record.length !== 56 || zip64.getUint32(0, true) !== 0x06064b50)
      throw new Error('The ZIP64 directory record is corrupt.');
    if (
      zip64.getUint32(16, true) ||
      zip64.getUint32(20, true) ||
      uint64(zip64, 24) !== uint64(zip64, 32)
    )
      throw new Error('Multi-volume ZIP64 is not supported yet.');
    count = uint64(zip64, 32);
    length = uint64(zip64, 40);
    offset = uint64(zip64, 48);
  } else if (view.getUint16(end + 8, true) !== count) throw new Error('The ZIP entry count is inconsistent.');
  if (count > 100000 || length > ZIP_DIRECTORY_LIMIT)
    throw new Error('The directory exceeds 100,000 entries or 16 MB; preview stopped.');
  if (offset + length > directoryEnd) throw new Error('The ZIP directory is out of bounds.');
  const bytes = await read(offset, length);
  if (bytes.length !== length) throw new Error('The ZIP directory read is incomplete.');
  return { bytes, count };
}

export function crc32(bytes: Uint8Array) {
  let crc = -1;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ -1) >>> 0;
}
export function parseZipDirectory(bytes: Uint8Array, count: number): ArchiveEntry[] {
  if (count > 100000 || bytes.length > ZIP_DIRECTORY_LIMIT) throw new Error('The ZIP directory exceeds the limit.');
  const view = viewOf(bytes);
  const entries: ArchiveEntry[] = [];
  let pos = 0;
  for (let index = 0; index < count; index++) {
    if (pos + 46 > bytes.length || view.getUint32(pos, true) !== 0x02014b50)
      throw new Error('The ZIP directory is corrupt.');
    const flags = view.getUint16(pos + 8, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const extraStart = pos + 46 + nameLength;
    const next = extraStart + extraLength + view.getUint16(pos + 32, true);
    if (next > bytes.length) throw new Error('The ZIP entry is out of bounds.');
    const nameBytes = bytes.subarray(pos + 46, extraStart);
    let name: string;
    try {
      name = new TextDecoder('utf-8', { fatal: true }).decode(nameBytes);
    } catch {
      if (flags & 0x800) throw new Error('The ZIP UTF-8 file name is corrupt.');
      name = new TextDecoder('gb18030').decode(nameBytes);
    }
    let size = view.getUint32(pos + 24, true),
      compressed = view.getUint32(pos + 20, true),
      offset = view.getUint32(pos + 42, true);
    let zip64Found = false;
    for (let field = extraStart; field < extraStart + extraLength;) {
      if (field + 4 > extraStart + extraLength) throw new Error('The ZIP extra field is corrupt.');
      const type = view.getUint16(field, true),
        length = view.getUint16(field + 2, true),
        finish = field + 4 + length;
      if (finish > extraStart + extraLength) throw new Error('The ZIP extra field is out of bounds.');
      if (type === 1) {
        let p = field + 4;
        const take = () => {
          if (p + 8 > finish) throw new Error('The ZIP64 entry is corrupt.');
          const n = uint64(view, p);
          p += 8;
          return n;
        };
        if (size === 0xffffffff) size = take();
        if (compressed === 0xffffffff) compressed = take();
        if (offset === 0xffffffff) offset = take();
        zip64Found = true;
      }
      if (
        type === 0x7075 &&
        length >= 5 &&
        bytes[field + 4] === 1 &&
        view.getUint32(field + 5, true) === crc32(nameBytes)
      ) {
        name = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(field + 9, finish));
      }
      field = finish;
    }
    if (!zip64Found && (size === 0xffffffff || compressed === 0xffffffff || offset === 0xffffffff))
      throw new Error('The ZIP64 extra field is missing.');
    if (view.getUint16(pos + 34, true) !== 0) throw new Error('Multi-volume entries are not supported yet.');
    entries.push({
      name,
      size,
      compressed,
      offset,
      method: view.getUint16(pos + 10, true),
      encrypted: Boolean(flags & 0x41),
      crc: view.getUint32(pos + 16, true),
      directory: name.endsWith('/'),
      index,
    });
    pos = next;
  }
  return entries;
}
export async function readZipEntry(
  entry: ArchiveEntry,
  size: number,
  read: RangeReader,
  limit = ZIP_ENTRY_LIMIT,
) {
  if (entry.directory || entry.encrypted) throw new Error('The encrypted entry must be opened with archive software.');
  if (![0, 8].includes(entry.method ?? -1)) throw new Error('The compression method of this entry is not supported yet.');
  if (entry.size > limit || entry.compressed > limit)
    throw new Error(`The inner file's compressed and uncompressed sizes must both be within ${limit / 1024 / 1024} MB.`);
  const offset = entry.offset!;
  if (!Number.isSafeInteger(offset) || offset + 30 > size) throw new Error('The ZIP entry offset is invalid.');
  const header = await read(offset, 30),
    view = viewOf(header);
  if (
    header.length !== 30 ||
    view.getUint32(0, true) !== 0x04034b50 ||
    view.getUint16(8, true) !== entry.method ||
    view.getUint16(6, true) & 0x41
  )
    throw new Error('The ZIP entry header is corrupt or encrypted.');
  const start = offset + 30 + view.getUint16(26, true) + view.getUint16(28, true);
  if (start + entry.compressed > size) throw new Error('The ZIP data is out of bounds.');
  const bytes = await readArchiveRange(read, start, entry.compressed);
  if (bytes.length !== entry.compressed) throw new Error('The ZIP entry read is incomplete.');
  return bytes;
}
export function inflateZipEntry(bytes: Uint8Array, entry: ArchiveEntry, limit = ZIP_ENTRY_LIMIT) {
  if (entry.encrypted || entry.size > limit || bytes.length > limit)
    throw new Error('The entry is encrypted or exceeds the preview limit.');
  const chunks: Uint8Array[] = [];
  let length = 0;
  if (entry.method === 0) {
    chunks.push(bytes);
    length = bytes.length;
  } else if (entry.method === 8) {
    const inflate = new Inflate((chunk) => {
      length += chunk.length;
      if (length > limit || length > entry.size) throw new Error('The decompressed content exceeds the preview memory limit.');
      chunks.push(chunk);
    });
    for (let offset = 0; offset < bytes.length; offset += 1024)
      inflate.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  } else throw new Error('This compression method is not supported yet.');
  if (length !== entry.size) throw new Error('The decompressed ZIP size does not match the directory.');
  const result = new Uint8Array(length);
  let pos = 0;
  for (const chunk of chunks) {
    result.set(chunk, pos);
    pos += chunk.length;
  }
  if (crc32(result) !== entry.crc) throw new Error('ZIP checksum verification failed; the entry may be corrupt.');
  return result;
}

// Keep native IPC reads bounded while assembling a selected archive entry.
export async function readArchiveRange(read: RangeReader, offset: number, length: number) {
  const bytes = new Uint8Array(length);
  for (let position = 0; position < length; position += 4 * 1024 * 1024) {
    const size = Math.min(4 * 1024 * 1024, length - position);
    const chunk = await read(offset + position, size);
    if (chunk.length !== size) throw new Error('The inner file read is incomplete.');
    bytes.set(chunk, position);
  }
  return bytes;
}
