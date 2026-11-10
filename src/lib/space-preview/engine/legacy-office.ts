// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { CFB } from 'xlsx';

function streams(bytes: Uint8Array) {
  const container = CFB.read(bytes, { type: 'array' }) as {
    FileIndex: { name: string; content?: Uint8Array }[];
  };
  return (name: string) => {
    const data = container.FileIndex.find((item) => item.name === name)?.content;
    if (!data) throw new Error(`Legacy Office is missing the ${name} stream.`);
    return Uint8Array.from(data);
  };
}
function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function range(offset: number, size: number, length: number) {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(size) ||
    offset < 0 ||
    size < 0 ||
    offset > length - size
  )
    throw new Error('The legacy Office data is truncated.');
}

export function readLegacyWord(bytes: Uint8Array) {
  const stream = streams(bytes),
    document = stream('WordDocument'),
    fib = view(document);
  range(0, 34, document.length);
  if (fib.getUint16(0, true) !== 0xa5ec || fib.getUint16(2, true) < 0xc1)
    throw new Error('Only Word 97–2003 binary DOC files are supported.');
  const flags = fib.getUint16(10, true);
  if (flags & 0x8100)
    throw new Error('Encrypted Word documents require a password and are not supported yet.');
  let position = 34 + fib.getUint16(32, true) * 2;
  range(position, 2, document.length);
  const longs = fib.getUint16(position, true),
    longStart = position + 2;
  range(longStart, longs * 4 + 2, document.length);
  if (longs < 4) throw new Error('The Word character directory is invalid.');
  const characters = fib.getUint32(longStart + 12, true);
  position = longStart + longs * 4;
  const pairs = fib.getUint16(position, true),
    pairStart = position + 2;
  if (pairs <= 33) throw new Error('The Word document is missing its text piece table.');
  range(pairStart, pairs * 8, document.length);
  const table = stream(flags & 0x200 ? '1Table' : '0Table');
  const fc = fib.getUint32(pairStart + 33 * 8, true),
    length = fib.getUint32(pairStart + 33 * 8 + 4, true);
  range(fc, length, table.length);
  const tv = view(table),
    end = fc + length;
  position = fc;
  while (position < end && table[position] === 1) {
    range(position, 3, end);
    position += 3 + tv.getUint16(position + 1, true);
  }
  range(position, 5, end);
  if (table[position] !== 2) throw new Error('The Word text piece format is invalid.');
  const size = tv.getUint32(position + 1, true),
    start = position + 5;
  if (size < 4 || (size - 4) % 12) throw new Error('The Word text piece size is invalid.');
  range(start, size, end);
  const count = (size - 4) / 12;
  const pieces: string[] = [];
  for (let i = 0; i < count; i++) {
    const from = tv.getUint32(start + i * 4, true),
      to = tv.getUint32(start + (i + 1) * 4, true);
    if (to < from) throw new Error('The Word character range is invalid.');
    if (from >= characters) break;
    const cp = Math.min(to, characters) - from;
    const packed = tv.getUint32(start + (count + 1) * 4 + i * 8 + 2, true);
    const compressed = Boolean(packed & 0x40000000),
      offset = (packed & 0x3fffffff) / (compressed ? 2 : 1);
    const length = cp * (compressed ? 1 : 2);
    range(offset, length, document.length);
    pieces.push(
      new TextDecoder(compressed ? 'windows-1252' : 'utf-16le').decode(
        document.subarray(offset, offset + length),
      ),
    );
  }
  const text = pieces
    .join('')
    .replace(/\u0013[^\u0014\u0015]*(?:\u0014([^\u0015]*))?\u0015/g, '$1')
    .replace(/\r/g, '\n')
    .replace(/\u0007/g, '\t')
    .replace(/[\u0000-\u0008\u000e-\u001f]/g, '')
    .trim();
  const escape = (line: string) =>
    line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return {
    html: text
      .split('\n')
      .map((line) => `<p>${escape(line) || '<br>'}</p>`)
      .join(''),
    note: 'Legacy Word · text overview, without the original page layout',
  };
}

export function readLegacySlides(bytes: Uint8Array) {
  const data = streams(bytes)('PowerPoint Document'),
    dv = view(data);
  const slides: { title: string; paragraphs: string[] }[] = [];
  const scan = (
    start: number,
    end: number,
    slide?: { title: string; paragraphs: string[] },
    depth = 0,
  ) => {
    if (depth > 64) throw new Error('The PowerPoint record nesting is too deep.');
    for (let position = start; position < end;) {
      range(position, 8, end);
      const flags = dv.getUint16(position, true),
        type = dv.getUint16(position + 2, true),
        size = dv.getUint32(position + 4, true);
      const content = position + 8,
        finish = content + size;
      range(content, size, end);
      if (type === 0x2f14) throw new Error('Encrypted PowerPoint presentations are not supported yet.');
      if ((flags & 15) === 15) {
        let current = slide;
        if (type === 1006) {
          current = { title: `Slide ${slides.length + 1}`, paragraphs: [] };
          slides.push(current);
        }
        scan(content, finish, current, depth + 1);
      } else if (slide && [4000, 4008].includes(type)) {
        const text = new TextDecoder(type === 4000 ? 'utf-16le' : 'windows-1252')
          .decode(data.subarray(content, finish))
          .replace(/\r|\u000b/g, '\n')
          .replace(/\u0000/g, '')
          .trim();
        if (text) {
          if (!slide.paragraphs.length) slide.title = text.split('\n')[0];
          slide.paragraphs.push(text);
        }
      }
      position = finish;
    }
  };
  scan(0, data.length);
  if (!slides.length)
    throw new Error(
      'The presentation has no readable slides; this legacy PowerPoint variant is not supported yet.',
    );
  return { slides, note: 'Legacy PowerPoint · text overview, without the original page layout' };
}
