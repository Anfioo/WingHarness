// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { describe, expect, it } from 'vitest';
import { CFB } from 'xlsx';
import { readLegacyWord, readLegacySlides } from '../legacy-office';

function compound(name: string, data: Uint8Array, table?: Uint8Array) {
  const container = CFB.utils.cfb_new();
  CFB.utils.cfb_add(container, name, data);
  if (table) CFB.utils.cfb_add(container, '1Table', table);
  return new Uint8Array(CFB.write(container, { type: 'array' }));
}
function word() {
  const text = '中文标题\r正文<&>\r',
    document = new Uint8Array(1024),
    view = new DataView(document.buffer);
  view.setUint16(0, 0xa5ec, true);
  view.setUint16(2, 0xc1, true);
  view.setUint16(10, 0x200, true);
  view.setUint16(34, 4, true);
  view.setUint32(48, text.length, true);
  view.setUint16(52, 34, true);
  view.setUint32(322, 21, true);
  for (let i = 0; i < text.length; i++) view.setUint16(512 + i * 2, text.charCodeAt(i), true);
  const table = new Uint8Array(21),
    tv = new DataView(table.buffer);
  table[0] = 2;
  tv.setUint32(1, 16, true);
  tv.setUint32(9, text.length, true);
  tv.setUint32(15, 512, true);
  return { document, table };
}
function record(type: number, content: Uint8Array, container = false) {
  const bytes = new Uint8Array(8 + content.length),
    view = new DataView(bytes.buffer);
  view.setUint16(0, container ? 15 : 0, true);
  view.setUint16(2, type, true);
  view.setUint32(4, content.length, true);
  bytes.set(content, 8);
  return bytes;
}
describe('Office 97–2003 content', () => {
  it('reads DOC Unicode pieces in logical order and escapes document markup', () => {
    const { document, table } = word();
    expect(readLegacyWord(compound('WordDocument', document, table)).html).toBe(
      '<p>中文标题</p><p>正文&lt;&amp;&gt;</p>',
    );
    new DataView(document.buffer).setUint16(10, 0x300, true);
    expect(() => readLegacyWord(compound('WordDocument', document, table))).toThrow('加密');
  });
  it('rejects DOC piece offsets beyond the original document', () => {
    const { document, table } = word();
    new DataView(table.buffer).setUint32(15, 999999, true);
    expect(() => readLegacyWord(compound('WordDocument', document, table))).toThrow('截断');
  });
  it('reads PPT Unicode and ANSI text atoms and checks record boundaries', () => {
    const text = '中文幻灯片',
      unicode = new Uint8Array(text.length * 2),
      view = new DataView(unicode.buffer);
    for (let i = 0; i < text.length; i++) view.setUint16(i * 2, text.charCodeAt(i), true);
    const title = record(4000, unicode),
      paragraph = record(4008, new TextEncoder().encode('Full content'));
    const children = new Uint8Array(title.length + paragraph.length);
    children.set(title);
    children.set(paragraph, title.length);
    const slide = record(1006, children, true);
    expect(readLegacySlides(compound('PowerPoint Document', slide)).slides).toEqual([
      { title: text, paragraphs: [text, 'Full content'] },
    ]);
    new DataView(slide.buffer).setUint32(4, slide.length, true);
    expect(() => readLegacySlides(compound('PowerPoint Document', slide))).toThrow('截断');
  });
});
