export interface TerminalKeyEvent {
  type: string;
  key: string;
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

const ALT_ARROW_SEQUENCES: Record<string, string> = {
  ArrowUp: "\x1b[1;3A",
  ArrowDown: "\x1b[1;3B",
};

export function altArrowSequence(event: TerminalKeyEvent): string | null {
  if (event.type !== "keydown") return null;
  if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return null;
  return ALT_ARROW_SEQUENCES[event.key] ?? null;
}
