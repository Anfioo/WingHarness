// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import UTIF from 'utif';
export function readTiff(bytes: Uint8Array, page = 0) {
  const buffer = bytes.slice().buffer as ArrayBuffer;
  const pages = UTIF.decode(buffer);
  if (!pages.length || pages.length > 200) throw new Error('TIFF 页面数无效或超过 200 页。');
  if (!Number.isInteger(page) || page < 0 || page >= pages.length)
    throw new Error('TIFF 页码无效。');
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
    throw new Error('TIFF 每页预览上限为 1,600 万像素。');
  UTIF.decodeImage(buffer, image);
  const pixels = UTIF.toRGBA8(image);
  if (pixels.length !== width * height * 4) throw new Error('TIFF 图像无法完整解码。');
  return { width, height, pixels, pages: pages.length, page };
}
