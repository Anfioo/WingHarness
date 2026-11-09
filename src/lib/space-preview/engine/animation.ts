// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { gunzipSync } from 'fflate';
import { extractZipEntries, listZip } from './archive';
import { extension } from './files';
export function readAnimation(bytes: Uint8Array, name: string, page = 0) {
  let files: Record<string, Uint8Array> = {};
  let names = ['动画'];
  if (extension(name) === 'tgs') bytes = gunzipSync(bytes);
  if (extension(name) === 'lottie') {
    files = extractZipEntries(
      bytes,
      new Set(
        listZip(bytes)
          .filter((entry) => !entry.directory)
          .map((entry) => entry.name),
      ),
      32 * 1024 * 1024,
      64 * 1024 * 1024,
    );
    const manifest = JSON.parse(new TextDecoder().decode(files['manifest.json']));
    names = manifest.animations.map((item: { id: string }) => item.id);
    if (!names[page]) throw new Error('动画页码无效。');
    bytes = files[`animations/${names[page]}.json`];
  }
  if (!bytes) throw new Error('动画内容不存在。');
  const data = JSON.parse(new TextDecoder().decode(bytes));
  if (
    !Array.isArray(data.layers) ||
    !Number.isFinite(data.fr) ||
    data.fr <= 0 ||
    !Number.isFinite(data.w) ||
    !Number.isFinite(data.h)
  )
    throw new Error('文件不是有效的 Lottie 动画。');
  for (const asset of data.assets ?? []) {
    if (!asset.p) continue;
    const path = `${asset.u ?? ''}${asset.p}`.replace(/^\.\//, '');
    const image = files[path] ?? files[`images/${asset.p}`];
    if (image) {
      const mime = /\.jpe?g$/i.test(path)
        ? 'image/jpeg'
        : /\.webp$/i.test(path)
          ? 'image/webp'
          : 'image/png';
      let binary = '';
      for (let i = 0; i < image.length; i += 8192)
        binary += String.fromCharCode(...image.subarray(i, i + 8192));
      asset.p = `data:${mime};base64,${btoa(binary)}`;
    } else if (!/^data:image\/(png|jpeg|webp|gif);base64,/i.test(asset.p)) asset.p = '';
    asset.u = '';
    asset.e = 1;
  }
  for (const font of data.fonts?.list ?? []) {
    delete font.fPath;
    font.fOrigin = 'n';
  }
  return { data, names, page };
}
