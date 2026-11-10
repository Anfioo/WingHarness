// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { RangeReader } from './zip-range';

// Publish an early prefix, then grow geometrically to avoid reparsing every small read.
export async function readInStages(
  size: number,
  read: RangeReader,
  signal: AbortSignal,
  publish: (bytes: Uint8Array, complete: boolean) => Promise<void>,
  progress: (percent: number) => void,
) {
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let target = Math.min(size, 64 * 1024);
  do {
    while (offset < target) {
      signal.throwIfAborted();
      const length = Math.min(4 * 1024 * 1024, target - offset);
      const chunk = await read(offset, length);
      signal.throwIfAborted();
      if (chunk.length !== length)
        throw new Error('The file read is incomplete; the file may have been modified, please reopen it.');
      chunks.push(chunk);
      offset += length;
      progress(Math.round((offset / size) * 100));
    }
    signal.throwIfAborted();
    const bytes = new Uint8Array(offset);
    let position = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, position);
      position += chunk.length;
    }
    await publish(bytes, offset === size);
    signal.throwIfAborted();
    if (offset === size) return;
    // Let the browser paint the published content before requesting the next stage.
    await new Promise((resolve) => setTimeout(resolve, 16));
    target = Math.min(size, target * 4);
  } while (offset < size);
}
