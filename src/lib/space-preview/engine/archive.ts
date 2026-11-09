// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { ArchiveEntry } from '../worker/worker-types';
import { Unzip, UnzipInflate } from 'fflate';

// Feed bounded compressed chunks and check actual output, not just attacker-controlled sizes.
export function extractZipEntries(
  bytes: Uint8Array,
  names: Set<string>,
  perFileLimit: number,
  totalLimit: number,
): Record<string, Uint8Array> {
  const output: Record<string, Uint8Array> = Object.create(null);
  let total = 0;
  let failure: Error | null = null;
  const unzip = new Unzip((file) => {
    if (!names.has(file.name)) return;
    const chunks: Uint8Array[] = [];
    let length = 0;
    file.ondata = (error, data, final) => {
      if (error) {
        failure = error;
        file.terminate();
        return;
      }
      length += data.length;
      total += data.length;
      if (length > perFileLimit || total > totalLimit) {
        failure = new Error('解压内容超过预览内存上限。');
        file.terminate();
        return;
      }
      chunks.push(data);
      if (final) {
        const combined = new Uint8Array(length);
        let position = 0;
        for (const chunk of chunks) {
          combined.set(chunk, position);
          position += chunk.length;
        }
        output[file.name] = combined;
      }
    };
    file.start();
  });
  unzip.register(UnzipInflate);
  for (let offset = 0; offset < bytes.length; offset += 1024) {
    unzip.push(bytes.subarray(offset, offset + 1024), offset + 1024 >= bytes.length);
    if (failure) throw failure;
  }
  for (const name of names)
    if (!output[name]) throw new Error('压缩包内部条目不完整或名称编码不受支持。');
  return output;
}

// Read only the ZIP central directory. Never inflate or write entries to disk.
export function listZip(bytes: Uint8Array): ArchiveEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (
      view.getUint32(i, true) === 0x06054b50 &&
      i + 22 + view.getUint16(i + 20, true) === bytes.length
    ) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('不是有效的 ZIP 文件，或文件尚未完整下载。');
  const count = view.getUint16(end + 10, true);
  if (view.getUint16(end + 4, true) !== 0 || view.getUint16(end + 6, true) !== 0)
    throw new Error('暂不支持分卷 ZIP。');
  if (count === 65535 || view.getUint32(end + 16, true) === 0xffffffff)
    throw new Error('暂不支持 ZIP64，请使用文件信息预览。');
  if (count > 10_000) throw new Error('压缩包超过 10,000 个条目，已停止解析。');
  let pos = view.getUint32(end + 16, true);
  const entries: ArchiveEntry[] = [];
  for (let index = 0; index < count; index++) {
    if (pos + 46 > end || view.getUint32(pos, true) !== 0x02014b50)
      throw new Error('ZIP 目录损坏。');
    const length = view.getUint16(pos + 28, true);
    const next =
      pos + 46 + length + view.getUint16(pos + 30, true) + view.getUint16(pos + 32, true);
    if (next > end) throw new Error('ZIP 条目越界。');
    const name = new TextDecoder(
      view.getUint16(pos + 8, true) & 0x800 ? 'utf-8' : 'gb18030',
    ).decode(bytes.subarray(pos + 46, pos + 46 + length));
    entries.push({
      name,
      size: view.getUint32(pos + 24, true),
      compressed: view.getUint32(pos + 20, true),
      directory: name.endsWith('/'),
      index,
    });
    pos = next;
  }
  return entries;
}
