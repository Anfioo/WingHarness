// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// Resolve only descendants of the selected document's directory. The native side
// repeats this check after canonicalization to account for symlinks.
export function localResource(reference: string, base = ''): string | null {
  if (!reference || /^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(reference.trim())) return null;
  try {
    const decoded = decodeURIComponent(reference.split(/[?#]/)[0]).replace(/\\/g, '/');
    if (decoded.startsWith('/')) return null;
    const parts = base.split('/').slice(0, -1);
    for (const part of decoded.split('/')) {
      if (part === '..') {
        if (!parts.length) return null;
        parts.pop();
      } else if (part && part !== '.') parts.push(part);
    }
    return parts.join('/');
  } catch {
    return null;
  }
}

const mime: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};
export function htmlResources(read: (path: string) => Promise<Uint8Array>, signal: AbortSignal) {
  const cache = new Map<string, Promise<Uint8Array>>();
  let budget = 32 * 1024 * 1024;
  const load = (path: string) => {
    signal.throwIfAborted();
    let pending = cache.get(path);
    if (!pending) {
      if (cache.size >= 64 || budget <= 0) return Promise.reject(new Error('The resource budget is exhausted.'));
      pending = read(path).then((bytes) => {
        signal.throwIfAborted();
        budget -= bytes.length;
        if (budget < 0) throw new Error('The resource budget is exhausted.');
        return bytes;
      });
      cache.set(path, pending);
    }
    return pending;
  };
  const image = async (reference: string, base = '') => {
    if (/^data:image\/(png|jpeg|gif|webp);base64,/i.test(reference)) return reference;
    const path = localResource(reference, base);
    const type = path && mime[path.split('.').at(-1)!.toLowerCase()];
    if (!path || !type) return '';
    try {
      const bytes = await load(path);
      let binary = '';
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return `data:${type};base64,${btoa(binary)}`;
    } catch {
      return '';
    }
  };
  const css = async (source: string, base = '', ancestors: string[] = []): Promise<string> => {
    // Resolve imports relative to their own stylesheet, preserving media conditions.
    const imports = /@import\s+(?:url\(\s*['"]?([^'"\s)]+)['"]?\s*\)|['"]([^'"]+)['"])([^;]*);/gi;
    let expanded = '',
      offset = 0;
    for (const match of source.matchAll(imports)) {
      expanded += source.slice(offset, match.index);
      const path = localResource(match[1] || match[2], base);
      if (path && path.endsWith('.css') && ancestors.length < 4 && !ancestors.includes(path)) {
        try {
          const content = await css(new TextDecoder().decode(await load(path)), path, [
            ...ancestors,
            path,
          ]);
          expanded += match[3].trim() ? `@media ${match[3]}{${content}}` : content;
        } catch {
          /* Missing resources do not block the document. */
        }
      }
      offset = match.index! + match[0].length;
    }
    expanded += source.slice(offset);
    const urls = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
    let output = '';
    offset = 0;
    for (const match of expanded.matchAll(urls)) {
      output += expanded.slice(offset, match.index);
      const ref = match[2];
      // Already-inlined imported resources are preserved; CSP disallows remote URLs.
      const value = ref.startsWith('data:') ? ref : await image(ref, base);
      output += `url("${value.replaceAll('"', '%22')}")`;
      offset = match.index! + match[0].length;
    }
    return output + expanded.slice(offset);
  };
  return {
    image,
    css,
    stylesheet: async (reference: string) => {
      const path = localResource(reference);
      if (!path || !path.endsWith('.css')) return '';
      try {
        return await css(new TextDecoder().decode(await load(path)), path, [path]);
      } catch {
        return '';
      }
    },
  };
}
