import { type ReactNode, useEffect, useRef, useState } from "react";

interface SurfaceRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

const sameRect = (a: SurfaceRect, b: SurfaceRect) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height;

/**
 * A React view laid exactly over an element the workbench renders.
 *
 * codelet owns the shell: the editor area is a blank iframe for a webview tab,
 * and the side bar is its own `aside`. Neither can host React. So the element is
 * left as it is and the host measures it, then draws the real content on top —
 * which is what keeps the tab strip, the close buttons and the side bar's
 * geometry the workbench's own.
 *
 * The element is observed rather than sampled: a ResizeObserver covers window
 * and panel resizes, a MutationObserver covers a tab switch or a side bar
 * re-render, and a short frame loop covers the frames between opening a view
 * and the shell mounting its element.
 */
export function WorkbenchSurface({
  selector,
  active,
  children,
}: {
  /** The element under the workbench root to cover. */
  selector: string;
  active: boolean;
  children: ReactNode;
}) {
  const anchorRef = useRef<HTMLDivElement | null>(null);
  const [rect, setRect] = useState<SurfaceRect | null>(null);

  useEffect(() => {
    if (!active) {
      setRect(null);
      return;
    }
    const root = anchorRef.current?.parentElement;
    if (!root) return;

    let stopped = false;
    let frame = 0;
    let attempts = 0;
    let observed: Element | null = null;
    const resize = new ResizeObserver(() => read());
    const mutations = new MutationObserver(() => read());

    function read() {
      const anchor = anchorRef.current;
      if (!anchor) return;
      const target = root?.querySelector(selector) ?? null;
      if (!target) {
        setRect(null);
        return;
      }
      const a = anchor.getBoundingClientRect();
      const r = target.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) {
        setRect(null);
        return;
      }
      const next = { left: r.left - a.left, top: r.top - a.top, width: r.width, height: r.height };
      setRect((previous) => (previous && sameRect(previous, next) ? previous : next));
      if (observed !== target) {
        if (observed) resize.unobserve(observed);
        resize.observe(target);
        observed = target;
      }
    }

    function tick() {
      if (stopped) return;
      read();
      attempts += 1;
      // The view is opened before the shell renders its element; a few frames
      // cover that gap, and the observers take over once it is there.
      if (attempts < 60) frame = requestAnimationFrame(tick);
    }

    resize.observe(root);
    mutations.observe(root, { childList: true, subtree: true });
    window.addEventListener("resize", read);
    frame = requestAnimationFrame(tick);

    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      window.removeEventListener("resize", read);
    };
  }, [active, selector]);

  return (
    <>
      <div
        ref={anchorRef}
        aria-hidden
        className="pointer-events-none absolute top-0 left-0 size-0"
      />
      {rect && (
        <div
          className="bg-background absolute z-10 flex min-h-0 flex-col overflow-hidden"
          style={rect}
        >
          {children}
        </div>
      )}
    </>
  );
}
