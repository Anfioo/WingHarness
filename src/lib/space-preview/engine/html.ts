// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { decodeText, type TextEncoding } from './files';

export function decodeHtml(bytes: Uint8Array, selected: TextEncoding = 'auto', partial = false) {
  if (
    selected === 'auto' &&
    !(bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) &&
    !((bytes[0] === 255 && bytes[1] === 254) || (bytes[0] === 254 && bytes[1] === 255))
  ) {
    const header = new TextDecoder('latin1').decode(bytes.slice(0, 4096));
    const declared = /<meta\b[^>]*charset\s*=\s*["']?\s*([\w-]+)/i.exec(header)?.[1];
    if (declared) {
      try {
        return {
          text: new TextDecoder(declared).decode(bytes, { stream: partial }),
          encoding: declared.toUpperCase(),
        };
      } catch {
        /* Unknown charset: use existing detection. */
      }
    }
  }
  return decodeText(bytes, selected, partial);
}
