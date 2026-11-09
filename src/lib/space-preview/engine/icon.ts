// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// ICO/CUR decoding goes through the same browser decoder as the image viewer.
import type { DecodeImage } from 'icojs';

export async function decodeIcon(bytes: Uint8Array): Promise<DecodeImage> {
  const { decodeIco } = await import('icojs');
  const images = await decodeIco(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, 'image/png');
  const selected = images.sort((a, b) => b.width * b.height - a.width * a.height)[0];
  if (!selected) throw new Error('This icon file has no decodable image.');
  return selected;
}
