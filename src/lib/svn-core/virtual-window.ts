export function getVirtualWindow(
  count: number,
  rowHeight: number,
  scrollTop: number,
  viewportHeight: number,
  overscan = 6
) {
  if (count <= 0 || rowHeight <= 0) return { start: 0, end: 0, top: 0, height: 0 };
  const height = count * rowHeight;
  const viewport = Math.max(rowHeight, viewportHeight);
  const top = Math.max(0, Math.min(scrollTop, Math.max(0, height - viewport)));
  return {
    start: Math.max(0, Math.floor(top / rowHeight) - overscan),
    end: Math.min(count, Math.ceil((top + viewport) / rowHeight) + overscan),
    top,
    height,
  };
}
