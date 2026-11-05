export const MAX_RENDERED_LINE = 5000;

export interface RenderedLine {
  text: string;
  hidden: number;
}

export function clipRenderedLine(content: string, max = MAX_RENDERED_LINE): RenderedLine {
  if (content.length <= max) return { text: content, hidden: 0 };
  return { text: content.slice(0, max), hidden: content.length - max };
}
