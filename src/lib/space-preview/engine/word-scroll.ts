// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
// Keep only nearby Word sections mounted; placeholders retain measured scroll geometry.
export function mountWordScroll(
  target: Document,
  count: number,
  render: (index: number, host: HTMLElement) => Promise<void>,
  signal: AbortSignal,
  onError: (error: unknown) => void,
) {
  const win = target.defaultView!;
  // Chromium/WebView2 must not apply its own anchoring on top of our compensation.
  const previousAnchoring = target.documentElement.style.overflowAnchor;
  target.documentElement.style.overflowAnchor = 'none';
  const slots = Array.from({ length: count }, (_, index) => {
    const slot = target.createElement('div');
    slot.dataset.wordSection = String(index);
    slot.style.height = '8000px';
    slot.style.overflow = 'hidden';
    target.body.append(slot);
    return slot;
  });
  const wanted = new Set<number>([0]);
  const mounted = new Set<number>();
  let busy = false;
  let disposed = false;
  const preservePosition = (slot: HTMLElement, change: () => void) => {
    const before = slot.getBoundingClientRect();
    change();
    const after = slot.getBoundingClientRect();
    // Explicit anchoring also works in WebKit, where CSS scroll anchoring is unavailable.
    if (before.bottom <= 0) win.scrollBy(0, after.height - before.height);
  };
  const pump = async () => {
    if (busy || disposed) return;
    busy = true;
    try {
      for (const index of wanted) {
        if (mounted.has(index) || disposed || signal.aborted) continue;
        const slot = slots[index];
        await render(index, slot);
        if (disposed || signal.aborted) return;
        preservePosition(slot, () => {
          slot.style.height = 'auto';
        });
        mounted.add(index);
      }
      for (const index of mounted) {
        if (wanted.has(index)) continue;
        const slot = slots[index];
        const height = slot.getBoundingClientRect().height;
        slot.style.height = `${height}px`;
        slot.replaceChildren();
        mounted.delete(index);
      }
    } catch (error) {
      if (!disposed && !signal.aborted) onError(error);
    } finally {
      busy = false;
    }
  };
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const index = Number((entry.target as HTMLElement).dataset.wordSection);
        if (entry.isIntersecting) wanted.add(index);
        else wanted.delete(index);
      }
      void pump();
    },
    { rootMargin: '1600px 0px' },
  );
  slots.forEach((slot) => observer.observe(slot));
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    target.documentElement.style.overflowAnchor = previousAnchoring;
    wanted.clear();
  };
  signal.addEventListener('abort', dispose, { once: true });
  void pump();
}
