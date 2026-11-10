// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
/** Linear scan; callers bound input before building per-line controls. */
export function codeFolds(text: string, language: string): Map<number, number> {
  const folds = new Map<number, number>();
  const stack: { token: string; line: number }[] = [];
  const close = (token: string, line: number) => {
    const start = stack.at(-1);
    if (!start || start.token !== token) return;
    stack.pop();
    if (line > start.line) folds.set(start.line, Math.max(line, folds.get(start.line) ?? 0));
  };
  let line = 0;
  if (['json', 'jsonc'].includes(language)) {
    let quoted = false,
      escaped = false,
      comment = '';
    for (let i = 0; i < text.length; i++) {
      const c = text[i],
        next = text[i + 1];
      if (c === '\n') {
        line++;
        if (comment === 'line') comment = '';
      }
      if (comment) {
        if (comment === 'block' && c === '*' && next === '/') {
          comment = '';
          i++;
        }
        continue;
      }
      if (quoted) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') quoted = false;
        continue;
      }
      if (c === '"') quoted = true;
      else if (c === '/' && (next === '/' || next === '*')) {
        comment = next === '/' ? 'line' : 'block';
        i++;
      } else if (c === '{' || c === '[') stack.push({ token: c, line });
      else if (c === '}' || c === ']') close(c === '}' ? '{' : '[', line);
    }
  } else if (['xml', 'html', 'svg', 'plist', 'xaml'].includes(language)) {
    const tags =
      /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<\/?([\w:.-]+)(?:"[^"]*"|'[^']*'|[^'">])*>/g;
    let offset = 0;
    for (const match of text.matchAll(tags)) {
      for (; offset < match.index!; offset++) if (text[offset] === '\n') line++;
      const start = line;
      for (; offset < match.index! + match[0].length; offset++) if (text[offset] === '\n') line++;
      if (!match[1]) continue;
      if (match[0].startsWith('</')) close(match[1], line);
      else if (!/\/\s*>$/.test(match[0])) stack.push({ token: match[1], line: start });
    }
  }
  return folds;
}
