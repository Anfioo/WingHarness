// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
export function metafileBounds(bytes: Uint8Array, emf: boolean) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let width = 1000,
    height = 1000,
    position = 0,
    records = 0;
  if (emf) {
    if (
      bytes.length < 88 ||
      view.getUint32(0, true) !== 1 ||
      view.getUint32(40, true) !== 0x464d4520
    )
      throw new Error('EMF 文件头无效。');
    width = view.getInt32(16, true) - view.getInt32(8, true);
    height = view.getInt32(20, true) - view.getInt32(12, true);
    const length = view.getUint32(48, true);
    if (length > bytes.length) throw new Error('EMF 数据已截断。');
    while (position < length) {
      if (position + 8 > length) throw new Error('EMF 记录已截断。');
      const size = view.getUint32(position + 4, true);
      if (size < 8 || size % 4 || position + size > length) throw new Error('EMF 记录大小无效。');
      position += size;
      if (++records > 100_000) throw new Error('矢量记录超过 100,000。');
    }
  } else {
    if (bytes.length < 18) throw new Error('WMF 文件头已截断。');
    if (view.getUint32(0, true) === 0x9ac6cdd7) {
      if (bytes.length < 40) throw new Error('WMF 文件头已截断。');
      width = view.getInt16(10, true) - view.getInt16(6, true);
      height = view.getInt16(12, true) - view.getInt16(8, true);
      position = 22;
    }
    if (
      ![1, 2].includes(view.getUint16(position, true)) ||
      view.getUint16(position + 2, true) !== 9
    )
      throw new Error('WMF 文件头无效。');
    const length = position + view.getUint32(position + 6, true) * 2;
    if (length > bytes.length) throw new Error('WMF 数据已截断。');
    position += 18;
    while (position < length) {
      if (position + 6 > length) throw new Error('WMF 记录已截断。');
      const size = view.getUint32(position, true) * 2,
        type = view.getUint16(position + 4, true);
      if (size < 6 || position + size > length) throw new Error('WMF 记录大小无效。');
      if (type === 0x020c && size >= 10) {
        height = Math.abs(view.getInt16(position + 6, true));
        width = Math.abs(view.getInt16(position + 8, true));
      }
      position += size;
      if (++records > 100_000) throw new Error('矢量记录超过 100,000。');
      if (type === 0) break; // META_EOF may be followed by alignment padding.
    }
  }
  if (width <= 0 || height <= 0 || width > 1_000_000 || height > 1_000_000)
    throw new Error('矢量画布尺寸无效。');
  return { width, height, records };
}

export async function renderMetafile(
  bytes: Uint8Array,
  emf: boolean,
  bounds: { width: number; height: number },
) {
  const { WMFJS, EMFJS } = await import('rtf.js');
  WMFJS.loggingEnabled(false);
  EMFJS.loggingEnabled(false);
  const { width, height } = bounds;
  const scale = Math.min(1, 4096 / Math.max(width, height));
  const settings = {
    width: String(width * scale),
    height: String(height * scale),
    xExt: width,
    yExt: height,
    wExt: width,
    hExt: height,
    mapMode: 8,
  };
  const renderer = emf
    ? new EMFJS.Renderer(bytes.buffer as ArrayBuffer)
    : new WMFJS.Renderer(bytes.buffer as ArrayBuffer);
  const svg = renderer.render(settings);
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  return svg.outerHTML;
}
