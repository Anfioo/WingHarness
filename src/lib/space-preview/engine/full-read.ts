// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { RangeReader } from './zip-range';

const READ_SIZE = 4 * 1024 * 1024;

// Bounded IPC reads assemble one complete file; callers never expose these ranges as pages.
export async function readWholeFile(
  size: number,
  read: RangeReader,
  signal: AbortSignal,
  progress: (percent: number) => void = () => {},
) {
  signal.throwIfAborted();
  const bytes = new Uint8Array(size);
  progress(0);
  for (let offset = 0; offset < size; offset += READ_SIZE) {
    signal.throwIfAborted();
    const length = Math.min(READ_SIZE, size - offset);
    const part = await read(offset, length);
    signal.throwIfAborted();
    if (part.length !== length) throw new Error('文件读取不完整，文件可能已被修改，请重新打开。');
    bytes.set(part, offset);
    progress(Math.round(((offset + length) / size) * 100));
  }
  progress(100);
  return bytes;
}
