// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { Unzlib } from 'fflate';
import { XMLParser } from 'fast-xml-parser';
import type { ArchiveEntry } from '../worker/worker-types';

export function xarHeader(bytes: Uint8Array) {
  if (bytes.length < 28 || new TextDecoder().decode(bytes.slice(0, 4)) !== 'xar!')
    throw new Error('The XAR header is invalid.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = view.getUint16(4),
    compressed = Number(view.getBigUint64(8)),
    size = Number(view.getBigUint64(16));
  if (
    view.getUint16(6) !== 1 ||
    header < 28 ||
    header > 65535 ||
    !compressed ||
    compressed > 16 * 1024 * 1024 ||
    !size ||
    size > 16 * 1024 * 1024
  )
    throw new Error('The XAR version or directory size is invalid.');
  return { header, compressed, size };
}

export function inflateZlib(bytes: Uint8Array, expected: number, limit = 256 * 1024 * 1024) {
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (!Number.isSafeInteger(expected) || expected < 0 || expected > limit)
    throw new Error('The XAR expanded size is invalid or exceeds the configured limit.');
  const decoder = new Unzlib((chunk) => {
    size += chunk.length;
    if (size > expected) throw new Error('The XAR expanded size exceeds the directory record.');
    chunks.push(chunk);
  });
  for (let offset = 0; offset < bytes.length; offset += 1024)
    decoder.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
  if (size !== expected) throw new Error('The decompressed XAR content is truncated.');
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

export function parseXar(bytes: Uint8Array, total: number): ArchiveEntry[] {
  const header = xarHeader(bytes),
    base = header.header + header.compressed;
  if (bytes.length < base || base > total) throw new Error('The XAR directory is truncated.');
  const xml = new TextDecoder('utf-8', { fatal: true }).decode(
    inflateZlib(bytes.subarray(header.header, base), header.size),
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('The XAR directory contains XML entities.');
  const parsed = new XMLParser({
    ignoreAttributes: false,
    processEntities: false,
    parseTagValue: false,
  }).parse(xml);
  if (!parsed.xar?.toc) throw new Error('The XAR directory structure is invalid.');
  type Node = {
    name: string;
    type: string;
    file?: Node | Node[];
    data?: { offset: string; size: string; length: string; encoding?: { '@_style': string } };
  };
  const list = (nodes?: Node | Node[]) => (nodes ? (Array.isArray(nodes) ? nodes : [nodes]) : []);
  const stack = list(parsed.xar.toc.file).map((node) => ({ path: '', node }));
  const entries: ArchiveEntry[] = [];
  while (stack.length) {
    if (entries.length + stack.length > 100_000) throw new Error('The XAR entry count exceeds 100,000.');
    const { path, node } = stack.pop()!;
    if (!node.name || /[/\\]/.test(node.name) || ['.', '..'].includes(node.name))
      throw new Error('The XAR file name is invalid.');
    const name = path + node.name;
    if (name.length > 4096) throw new Error('The XAR path is too long.');
    if (node.type === 'directory') {
      entries.push({
        name: name + '/',
        directory: true,
        size: 0,
        compressed: 0,
        index: entries.length,
      });
      for (const child of list(node.file)) stack.push({ path: name + '/', node: child });
    } else if (node.type === 'file' && node.data) {
      const offset = base + Number(node.data.offset),
        size = Number(node.data.length),
        compressed = Number(node.data.size);
      if (
        ![offset, size, compressed].every((value) => Number.isSafeInteger(value) && value >= 0) ||
        offset < base ||
        offset > total - compressed
      )
        throw new Error('The XAR data range is invalid.');
      const encoding = node.data.encoding?.['@_style'] ?? 'application/octet-stream';
      entries.push({
        name,
        directory: false,
        size,
        compressed,
        offset,
        method:
          encoding === 'application/octet-stream' ? 0 : encoding === 'application/x-gzip' ? 8 : -1,
        index: entries.length,
        sourcePath: name,
      });
    }
  }
  return entries;
}
