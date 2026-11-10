// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import UTIF from 'utif';
export function readTiff(bytes: Uint8Array, page = 0) {
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const pages = UTIF.decode(buffer);
  if (!pages.length || pages.length > 200) throw new Error('The TIFF page count is invalid or exceeds 200 pages.');
  if (!Number.isInteger(page) || page < 0 || page >= pages.length)
    throw new Error('The TIFF page number is invalid.');
  const image = pages[page];
  const width = Number((image.t256 as number[])?.[0]),
    height = Number((image.t257 as number[])?.[0]);
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    width * height > 16000000
  )
    throw new Error('The TIFF preview limit is 16 million pixels per page.');
  UTIF.decodeImage(buffer, image);
  const pixels = UTIF.toRGBA8(image);
  if (pixels.length !== width * height * 4) throw new Error('The TIFF image cannot be fully decoded.');
  return { width, height, pixels, pages: pages.length, page };
}
