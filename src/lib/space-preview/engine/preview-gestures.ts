// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
export function fontKeyDirection(
  event: Pick<KeyboardEvent, 'key' | 'code' | 'ctrlKey' | 'metaKey' | 'altKey' | 'isComposing'>,
): number {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || event.isComposing) return 0;
  if (['+', '='].includes(event.key) || ['Equal', 'NumpadAdd'].includes(event.code)) return 1;
  if (event.key === '-' || ['Minus', 'NumpadSubtract'].includes(event.code)) return -1;
  return 0;
}

export const resizeText = (size: number, direction: number) =>
  Math.max(10, Math.min(40, size + direction * 2));

export function forwardPreviewWheel(event: WheelEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.altKey || !event.deltaY) return;
  const forwarded = new WheelEvent('wheel', {
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    deltaY: event.deltaY,
    deltaMode: event.deltaMode,
    cancelable: true,
  });
  if (!window.dispatchEvent(forwarded)) event.preventDefault();
}
