// Share scroll tracking between the reading pane and the Word iframe.
export function trackReadingPosition(
  scroller: HTMLElement,
  headings: { id: string; element: Element }[],
  onChange: (id: string) => void,
) {
  const doc = scroller.ownerDocument;
  const win = doc.defaultView!;
  const viewport = scroller === doc.scrollingElement;
  const source = viewport ? doc : scroller;
  let pending = 0;
  const update = () => {
    pending = 0;
    const top = viewport ? 0 : scroller.getBoundingClientRect().top;
    let current = headings[0]?.id ?? '';
    for (const heading of headings) {
      if (heading.element.getBoundingClientRect().top > top + 48) break;
      current = heading.id;
    }
    onChange(current);
  };
  const schedule = () => {
    if (!pending) pending = win.requestAnimationFrame(update);
  };
  source.addEventListener('scroll', schedule, { passive: true });
  win.addEventListener('resize', schedule);
  const resize = new ResizeObserver(schedule);
  resize.observe(scroller);
  for (const heading of headings) resize.observe(heading.element);
  schedule();
  return () => {
    source.removeEventListener('scroll', schedule);
    win.removeEventListener('resize', schedule);
    resize.disconnect();
    win.cancelAnimationFrame(pending);
  };
}
