// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { XMLBuilder, XMLParser } from 'fast-xml-parser';

// docx-preview ignores eastAsiaTheme. Resolve it inside the in-memory package;
// leave explicit fonts, run sizes, and the user's file untouched.
export function resolveWordThemeFonts(parts: Record<string, Uint8Array>) {
  const decoder = new TextDecoder();
  const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true });
  const theme = parts['word/theme/theme1.xml'];
  if (!theme) return;
  const scheme = parser.parse(decoder.decode(theme))?.theme?.themeElements?.fontScheme;
  if (!scheme) return;
  const settings = parts['word/settings.xml'];
  const language = settings
    ? parser.parse(decoder.decode(settings))?.settings?.themeFontLang?.['@_eastAsia']
    : undefined;
  const ordered = new XMLParser({
    ignoreAttributes: false,
    preserveOrder: true,
    trimValues: false,
    parseTagValue: false,
  });
  const builder = new XMLBuilder({ ignoreAttributes: false, preserveOrder: true });
  const scriptFor = (lang: string) => {
    if (/^ja/i.test(lang)) return 'Jpan';
    if (/^ko/i.test(lang)) return 'Hang';
    if (/^zh-(TW|HK|MO|Hant)/i.test(lang)) return 'Hant';
    if (/^zh/i.test(lang)) return 'Hans';
    return '';
  };
  for (const [name, bytes] of Object.entries(parts)) {
    if (!/^word\/.*\.xml$/i.test(name)) continue;
    const xml = decoder.decode(bytes);
    if (!xml.includes('eastAsiaTheme')) continue;
    const nodes = ordered.parse(xml);
    let changed = false;
    const visit = (children: any[], inheritedLanguage: string) => {
      const langNode = children.find((node) =>
        Object.keys(node).some((k) => /(?:^|:)lang$/.test(k)),
      );
      const localLang = Object.entries(langNode?.[':@'] ?? {}).find(([key]) =>
        /(?:^|:)eastAsia$/.test(key),
      )?.[1];
      const lang = typeof localLang === 'string' ? localLang : inheritedLanguage;
      for (const node of children) {
        for (const [tag, value] of Object.entries(node)) {
          if (/(?:^|:)rFonts$/.test(tag)) {
            const attrs = node[':@'] ?? {};
            const key = Object.keys(attrs).find((key) => /:eastAsiaTheme$/.test(key));
            if (!key) continue;
            const fontGroup = /^major/.test(attrs[key]) ? scheme.majorFont : scheme.minorFont;
            const fonts = fontGroup?.font ? [fontGroup.font].flat() : [];
            const face =
              fontGroup?.ea?.['@_typeface'] ||
              fonts.find((f: any) => f['@_script'] === scriptFor(lang))?.['@_typeface'];
            if (face) {
              attrs[key.replace('eastAsiaTheme', 'eastAsia')] = face;
              delete attrs[key];
              changed = true;
            }
          }
          if (Array.isArray(value)) visit(value, lang);
        }
      }
    };
    visit(nodes, language || '');
    if (changed) parts[name] = new TextEncoder().encode(builder.build(nodes));
  }
}
