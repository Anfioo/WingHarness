// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
/* eslint-disable no-control-regex -- The text/binary sniff must test control characters by definition. */
import type { PreviewFile } from '../bridge';

export const extension = (name: string) => name.split('.').pop()!.toLowerCase();

export function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), 4);
  return `${(bytes / 1024 ** unit).toFixed(unit === 1 ? 0 : 1)} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}
export function fromBrowser(file: File): PreviewFile {
  return {
    id: crypto.randomUUID(),
    name: file.name,
    size: file.size,
    modified: file.lastModified,
    mime: file.type,
    blob: file,
  };
}
export type TextEncoding =
  'auto' | 'utf-8' | 'utf-16le' | 'utf-16be' | 'gb18030' | 'big5' | 'windows-1252' | 'shift_jis';
export function decodeText(bytes: Uint8Array, selected: TextEncoding = 'auto', partial = false) {
  const decode = (encoding: string, fatal = false) =>
    new TextDecoder(encoding, { fatal }).decode(bytes, { stream: partial });
  if (selected !== 'auto') return { text: decode(selected), encoding: selected.toUpperCase() };
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return { text: decode('utf-16le'), encoding: 'UTF-16 LE' };
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return { text: decode('utf-16be'), encoding: 'UTF-16 BE' };
  // BOM-less UTF-16 commonly occurs in Windows configuration/license files.
  const sample = bytes.slice(0, 4096);
  const pairs = Math.floor(sample.length / 2);
  if (pairs >= 2) {
    let even = 0,
      odd = 0;
    for (let i = 0; i < pairs * 2; i += 2) {
      even += Number(sample[i] === 0);
      odd += Number(sample[i + 1] === 0);
    }
    if (odd >= 2 && odd / pairs > 0.1 && even / pairs < 0.05)
      return { text: decode('utf-16le'), encoding: 'UTF-16 LE（推测）' };
    if (even >= 2 && even / pairs > 0.1 && odd / pairs < 0.05)
      return { text: decode('utf-16be'), encoding: 'UTF-16 BE（推测）' };
  }
  try {
    return { text: decode('utf-8', true), encoding: 'UTF-8' };
  } catch {
    return { text: decode('gb18030'), encoding: 'GB18030（推测）' };
  }
}

export function hasBinarySignature(bytes: Uint8Array): boolean {
  const hex = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  return /^(4d5a|7f454c46|d0cf11e0|53514c697465|52617221|377abcaf)/.test(hex);
}

// The magic-byte probe only ever reports one of the core preview families.
export type SniffedKind = 'pdf' | 'rtf' | 'image' | 'archive' | 'html' | 'text' | 'binary';

export function sniffKind(bytes: Uint8Array): SniffedKind {
  const hex = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('25504446')) return 'pdf';
  if (hex.startsWith('7b5c727466')) return 'rtf';
  if (/^(89504e47|ffd8ff|47494638|424d)/.test(hex)) return 'image';
  if (hex.startsWith('504b0304')) return 'archive';
  if (hasBinarySignature(bytes)) return 'binary';
  const { text } = decodeText(bytes, 'auto', true);
  if (/^\s*(?:<!doctype\s+html|<html\b)/i.test(text)) return 'html';
  if (!text) return bytes.length ? 'binary' : 'text';
  const controls = [...text].filter((c) =>
    /[\u0000-\u0008\u000b\u000e-\u001f�]/.test(c),
  ).length;
  return controls / text.length <= 0.01 ? 'text' : 'binary';
}
export function hexDump(bytes: Uint8Array): string {
  return Array.from({ length: Math.ceil(bytes.length / 16) }, (_, row) => {
    const part = bytes.slice(row * 16, row * 16 + 16);
    const hex = Array.from(part, (x) => x.toString(16).padStart(2, '0'))
      .join(' ')
      .padEnd(47);
    const ascii = Array.from(part, (x) =>
      x >= 32 && x <= 126 ? String.fromCharCode(x) : '.',
    ).join('');
    return `${(row * 16).toString(16).padStart(8, '0')}    ${hex}    ${ascii}`;
  }).join('\n');
}
export function sniffMagic(bytes: Uint8Array) {
  const hex = Array.from(bytes.slice(0, 8), (b) => b.toString(16).padStart(2, '0')).join('');
  if (hex.startsWith('7f454c46')) return 'ELF 可执行文件';
  if (hex.startsWith('4d5a')) return 'Windows 可执行文件';
  if (hex.startsWith('504b0304')) return 'ZIP / OOXML 容器';
  if (hex.startsWith('53514c6974652066')) return 'SQLite 数据库';
  if (hex.startsWith('d0cf11e0')) return 'OLE 复合文档（旧版 Office 容器，不能按纯文本解码）';
  if (hex.startsWith('89504e47')) return 'PNG 图像';
  if (hex.startsWith('25504446')) return 'PDF 文档';
  return '通用二进制文件';
}
