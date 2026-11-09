// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
export function fontCollection(bytes: Uint8Array, face = 0) {
  if (new TextDecoder().decode(bytes.subarray(0, 4)) !== 'ttcf') return { bytes, count: 1 };
  if (bytes.length < 16) throw new Error('The font collection is truncated.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = view.getUint32(8);
  if (
    !count ||
    count > 256 ||
    12 + count * 4 > bytes.length ||
    !Number.isInteger(face) ||
    face < 0 ||
    face >= count
  )
    throw new Error('The font collection page number or directory is invalid.');
  const offset = view.getUint32(12 + face * 4);
  if (offset + 12 > bytes.length) throw new Error('The font collection is truncated.');
  const tables = view.getUint16(offset + 4);
  if (offset + 12 + tables * 16 > bytes.length) throw new Error('The font table directory is truncated.');
  let length = 12 + tables * 16;
  const records = Array.from({ length: tables }, (_, i) => {
    const record = offset + 12 + i * 16;
    const start = view.getUint32(record + 8),
      size = view.getUint32(record + 12);
    if (start + size > bytes.length) throw new Error('The font table is truncated.');
    const destination = length;
    length += Math.ceil(size / 4) * 4;
    return { record, start, size, destination };
  });
  const result = new Uint8Array(length);
  const output = new DataView(result.buffer);
  result.set(bytes.subarray(offset, offset + 12));
  let head = -1;
  for (const [i, item] of records.entries()) {
    const directory = 12 + i * 16;
    result.set(bytes.subarray(item.record, item.record + 16), directory);
    output.setUint32(directory + 8, item.destination);
    result.set(bytes.subarray(item.start, item.start + item.size), item.destination);
    if (output.getUint32(directory) === 0x68656164) {
      if (item.size < 12) throw new Error('The font head table is invalid.');
      head = item.destination;
      output.setUint32(head + 8, 0);
      let checksum = 0;
      for (let n = item.destination; n < item.destination + item.size; n += 4)
        checksum = (checksum + output.getUint32(n)) >>> 0;
      output.setUint32(directory + 4, checksum);
    }
  }
  if (head >= 0) {
    let checksum = 0;
    for (let i = 0; i < result.length; i += 4) checksum = (checksum + output.getUint32(i)) >>> 0;
    output.setUint32(head + 8, (0xb1b0afba - checksum) >>> 0);
  }
  return { bytes: result, count };
}
