// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { describe, expect, it } from 'vitest';
import { zipSync, strToU8 } from 'fflate';
import { decodeText, formatSize, hexDump, sniffMagic, sniffKind } from '../files';
import { detectKind, previewMime } from '../../registry';
import { listZip, extractZipEntries } from '../archive';

describe('preview routing and fallback', () => {
  it('distinguishes DLL/ELF binaries from SQL DDL and UTF-16 text', () => {
    expect(detectKind('GameDll.dll')).toBe('binary');
    expect(detectKind('schema.ddl')).toBe('text');
    expect(sniffKind(new Uint8Array([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]))).toBe('binary');
    expect(sniffKind(new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1, 0]))).toBe('binary');
    expect(sniffKind(strToU8('CREATE TABLE users (id INTEGER PRIMARY KEY);'))).toBe('text');
    expect(sniffKind(new Uint8Array([255, 254, 65, 0, 66, 0]))).toBe('text');
  });
  it('assigns display MIME types to files extracted from archives', () => {
    expect(previewMime('drawing.SVG')).toBe('image/svg+xml');
    expect(previewMime('photo.jpg')).toBe('image/jpeg');
    expect(previewMime('photo.jpeg')).toBe('image/jpeg');
    expect(previewMime('photo.png')).toBe('image/png');
    expect(previewMime('sound.mp3')).toBe('audio/mpeg');
    expect(previewMime('clip.mov')).toBe('video/quicktime');
    expect(previewMime('license.dat')).toBe('application/octet-stream');
  });
  it('identifies text content in .dat without misclassifying known binary containers', () => {
    expect(sniffKind(strToU8('license=ABCD-1234\n公司授权=有效'))).toBe('text');
    expect(sniffKind(new Uint8Array([0, 1, 2, 3, 4, 255, 0, 6]))).toBe('binary');
    expect(sniffKind(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]))).toBe(
      'binary',
    );
    expect(sniffKind(strToU8('%PDF-1.4\n'))).toBe('pdf');
    expect(sniffKind(strToU8('{\\rtf1\\ansi example}'))).toBe('rtf');
    expect(sniffKind(strToU8('<!doctype html><html><body>内容</body></html>'))).toBe('html');
  });
  it('decodes BOM-less UTF16, GBK, and permits explicit legacy encodings', () => {
    expect(decodeText(new Uint8Array([65, 0, 66, 0, 45, 0, 67, 0])).text).toBe('AB-C');
    expect(decodeText(new Uint8Array([0, 65, 0, 66, 0, 45, 0, 67])).text).toBe('AB-C');
    expect(decodeText(new Uint8Array([0xd6, 0xd0, 0xce, 0xc4])).text).toBe('中文');
    expect(decodeText(new Uint8Array([0x63, 0x61, 0x66, 0xe9]), 'windows-1252').text).toBe('café');
    const partial = strToU8('中文').slice(0, 5);
    expect(decodeText(partial, 'auto', true)).toEqual({ text: '中', encoding: 'UTF-8' });
  });
  it('handles uppercase, dotfiles and unknown extensions', () => {
    expect(detectKind('PHOTO.PNG')).toBe('image');
    expect(detectKind('.env')).toBe('text');
    expect(detectKind('Dockerfile')).toBe('text');
    expect(detectKind('firmware.xyz')).toBe('binary');
    expect(detectKind('复杂表格.xlsx')).toBe('xlsx');
    expect(detectKind('模板.XLTX')).toBe('xlsx');
    expect(detectKind('放映.PPSM')).toBe('pptx');
    expect(detectKind('插件.vsix')).toBe('archive');
    expect(detectKind('漫画.cbz')).toBe('archive');
  });
  it('decodes UTF-8 Chinese and UTF-16 byte order marks', () => {
    expect(decodeText(strToU8('瞬览')).text).toBe('瞬览');
    expect(decodeText(new Uint8Array([255, 254, 65, 0])).text).toBe('A');
    expect(decodeText(new Uint8Array([254, 255, 0, 65])).text).toBe('A');
  });
  it('detects BOM-less UTF-16 Chinese lines in both byte orders', () => {
    const text = '中文完整文档\n'.repeat(400) + '文件末尾';
    const little = new Uint8Array(text.length * 2);
    const big = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      new DataView(little.buffer).setUint16(i * 2, text.charCodeAt(i), true);
      new DataView(big.buffer).setUint16(i * 2, text.charCodeAt(i), false);
    }
    expect(decodeText(little).text).toBe(text);
    expect(decodeText(big).text).toBe(text);
    expect(decodeText(strToU8(text)).encoding).toBe('UTF-8');
  });
  it('produces offsets, printable ASCII and magic detection', () => {
    const bytes = new Uint8Array([127, 69, 76, 70, 0, 65]);
    expect(sniffMagic(bytes)).toBe('ELF 可执行文件');
    expect(hexDump(bytes)).toContain('00000000    7f 45 4c 46 00 41');
    expect(hexDump(bytes)).toContain('.ELF.A');
    expect(hexDump(new Uint8Array())).toBe('');
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1024 ** 3 * 20)).toBe('20.0 GB');
  });
});
describe('read-only ZIP directory', () => {
  it('extracts only the requested file in memory and checks actual output limits', () => {
    const bytes = zipSync({
      'readme.txt': strToU8('safe'),
      'large.txt': strToU8('x'.repeat(30_000)),
    });
    expect(
      new TextDecoder().decode(
        extractZipEntries(bytes, new Set(['readme.txt']), 100, 100)['readme.txt'],
      ),
    ).toBe('safe');
    expect(() => extractZipEntries(bytes, new Set(['large.txt']), 100, 100)).toThrow('内存上限');
  });
  it('lists Unicode paths and sizes without extracting', () => {
    const bytes = zipSync({
      '目录/你好.txt': strToU8('你好'),
      '../outside.txt': strToU8('display only'),
    });
    const entries = listZip(bytes);
    expect(entries[0]).toMatchObject({ name: '目录/你好.txt', size: 6, directory: false });
    expect(entries[1].name).toBe('../outside.txt');
  });
  it('handles an empty archive', () => expect(listZip(zipSync({}))).toEqual([]));
  it('rejects truncated and corrupt archives', () => {
    const bytes = zipSync({ 'readme.txt': strToU8('a') });
    expect(() => listZip(bytes.slice(0, -5))).toThrow();
    const damaged = bytes.slice();
    new DataView(damaged.buffer).setUint32(damaged.length - 6, 0x7fffffff, true);
    expect(() => listZip(damaged)).toThrow('ZIP 目录损坏');
    expect(() => listZip(new Uint8Array([1, 2, 3]))).toThrow();
  });
});
