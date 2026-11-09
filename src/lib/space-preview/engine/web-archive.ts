// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import PostalMime from 'postal-mime';

export interface WebArchive {
  html: string;
  location: string;
  resources: { location: string; mime: string; bytes: Uint8Array }[];
}

export async function readWebArchive(bytes: Uint8Array): Promise<WebArchive> {
  // Preserve raw MIME bytes (including legacy charsets). PostalMime exposes CID,
  // so give Content-Location parts an equivalent CID before MIME decoding.
  let source = '';
  for (let i = 0; i < bytes.length; i += 8192)
    source += String.fromCharCode(...bytes.subarray(i, i + 8192));
  const locations: string[] = [];
  source = source.replace(
    /(^|\r?\n)(Content-Location:[^\r\n]*(?:\r?\n[ \t][^\r\n]*)*)/gi,
    (_, prefix, header) => {
      const location = header
        .replace(/^Content-Location:\s*/i, '')
        .replace(/\r?\n[ \t]+/g, '')
        .trim();
      locations.push(location);
      return `${prefix}${header}\r\nContent-ID: <${location.replace(/[<>\r\n]/g, '')}>`;
    },
  );
  const mail = await PostalMime.parse(Uint8Array.from(source, (char) => char.charCodeAt(0)));
  if (!mail.html) throw new Error('此网页存档没有 HTML 正文。');
  return {
    html: mail.html,
    location: locations[0] ?? '',
    resources: mail.attachments
      .filter((item) => item.contentId)
      .map((item) => ({
        location: item.contentId!.replace(/^<|>$/g, ''),
        mime: item.mimeType,
        bytes:
          typeof item.content === 'string'
            ? new TextEncoder().encode(item.content)
            : new Uint8Array(item.content),
      })),
  };
}

export function resourceDataUrl(mime: string, bytes: Uint8Array) {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192)
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return `data:${mime};base64,${btoa(binary)}`;
}

export function materializeWebArchive(archive: WebArchive) {
  const resources = new Map(archive.resources.map((resource) => [resource.location, resource]));
  const find = (url: string, base = archive.location) => {
    const raw = url.replace(/^cid:/i, '');
    if (resources.has(raw)) return resources.get(raw);
    try {
      return resources.get(new URL(raw, base).href);
    } catch {
      return undefined;
    }
  };
  const rewriteCss = (css: string, base: string) =>
    css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (_, _quote, url) => {
      const resource = find(url, base);
      return resource && /^(?:image\/(?:png|jpeg|gif|webp)|font\/)/i.test(resource.mime)
        ? `url("${resourceDataUrl(resource.mime, resource.bytes)}")`
        : 'url("")';
    });
  const doc = new DOMParser().parseFromString(archive.html, 'text/html');
  doc.querySelectorAll('img[src]').forEach((image) => {
    const resource = find(image.getAttribute('src')!);
    if (resource && /^image\/(?:png|jpeg|gif|webp)$/i.test(resource.mime))
      image.setAttribute('src', resourceDataUrl(resource.mime, resource.bytes));
  });
  doc.querySelectorAll('style').forEach((style) => {
    style.textContent = rewriteCss(style.textContent ?? '', archive.location);
  });
  doc.querySelectorAll('[style]').forEach((node) => {
    node.setAttribute('style', rewriteCss(node.getAttribute('style')!, archive.location));
  });
  doc.querySelectorAll('link[rel=stylesheet]').forEach((link) => {
    const resource = find(link.getAttribute('href') ?? '');
    if (resource?.mime === 'text/css') {
      const style = doc.createElement('style');
      style.textContent = rewriteCss(new TextDecoder().decode(resource.bytes), resource.location);
      link.replaceWith(style);
    }
  });
  return '<!doctype html>' + doc.documentElement.outerHTML;
}
