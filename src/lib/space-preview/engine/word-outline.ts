// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
interface WordNode {
  type: string;
  text?: string;
  children?: WordNode[];
  outlineLevel?: number;
  styleName?: string;
  className?: string;
  cssStyle?: Record<string, string>;
}
interface WordStyle {
  id: string;
  name?: string;
  basedOn?: string;
  paragraphProps?: { outlineLevel?: number };
}

const content = (node: WordNode): string =>
  node.type === 'text' ? (node.text ?? '') : (node.children ?? []).map(content).join('');

// Mark the engine's paragraphs so outline navigation preserves the original layout.
export function buildWordOutline(body: WordNode, styleList: WordStyle[]) {
  const styles = new Map(styleList.map((style) => [style.id, style]));
  const styleLevel = (id?: string, seen = new Set<string>()): number | undefined => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    const style = styles.get(id);
    if (!style) return;
    if (Number.isInteger(style.paragraphProps?.outlineLevel))
      return style.paragraphProps!.outlineLevel;
    const named = /^(?:heading|标题)\s*([1-9])$/i.exec(style.name || id);
    return named ? Number(named[1]) - 1 : styleLevel(style.basedOn, seen);
  };
  const headings: { id: string; title: string; level: number }[] = [];
  const add = (node: WordNode, level: number) => {
    const title = content(node).trim();
    if (!title || headings.length >= 1000) return;
    const id = `word-heading-${headings.length}`;
    headings.push({ id, title, level });
    node.className = `${node.className || ''} ${id}`;
  };
  const visit = (node: WordNode) => {
    const level = node.outlineLevel ?? styleLevel(node.styleName);
    if (
      node.type === 'paragraph' &&
      level !== undefined &&
      Number.isInteger(level) &&
      level >= 0 &&
      level < 9
    )
      add(node, level + 1);
    (node.children ?? []).forEach(visit);
  };
  visit(body);
  if (headings.length) return headings;

  // Some documents use direct bold/size formatting instead of Word heading styles.
  // Only infer short, fully bold headings in the main body, never table cells.
  const paragraphs = (body.children ?? []).filter((node) => node.type === 'paragraph');
  const runs = (node: WordNode): WordNode[] =>
    node.type === 'run'
      ? content(node).trim()
        ? [node]
        : []
      : (node.children ?? []).flatMap(runs);
  const sizes = new Map<number, number>();
  for (const paragraph of paragraphs)
    for (const run of runs(paragraph)) {
      const size = parseFloat(run.cssStyle?.['font-size'] ?? '');
      if (Number.isFinite(size)) sizes.set(size, (sizes.get(size) ?? 0) + content(run).length);
    }
  const bodySize = [...sizes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? Infinity;
  for (const paragraph of paragraphs) {
    const title = content(paragraph).trim();
    const textRuns = runs(paragraph);
    // Explicit body-text levels must not be promoted by visual inference.
    if (
      (paragraph.outlineLevel ?? styleLevel(paragraph.styleName)) !== undefined ||
      !title ||
      title.length > 80 ||
      !textRuns.length ||
      !textRuns.every((run) => run.cssStyle?.['font-weight'] === 'bold')
    )
      continue;
    const chinese = /^[一二三四五六七八九十百]+[、．.]/.test(title);
    const parenthesized = /^[（(][一二三四五六七八九十百\d]+[）)]/.test(title);
    const numeric = /^(\d+(?:\.\d+)*)(?:[、．.)）]|\s)\s*\S/.exec(title);
    const larger = textRuns.every(
      (run) => parseFloat(run.cssStyle?.['font-size'] ?? '') > bodySize,
    );
    if (chinese || parenthesized || numeric || larger)
      add(
        paragraph,
        chinese ? 1 : parenthesized ? 2 : numeric ? Math.min(9, numeric[1].split('.').length) : 1,
      );
  }
  return headings;
}
