// Transcript scroll-follow.
//
// Follow mode is sticky: it stays on while the viewport sits within a small
// slack of the bottom, and a deliberate scroll upwards turns it off until the
// user asks for the bottom again.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";

export interface ScrollFollowOptions {
  scrollerRef: RefObject<HTMLDivElement | null>;
  itemCount: number;
}

export interface ScrollFollow {
  atBottom: boolean;
  scrollToBottom: (behavior?: ScrollBehavior) => void;
  /** Restores a remembered offset; `null` means "pin to the bottom". */
  restore: (offset: number | null) => void;
}

const BOTTOM_SLACK_PX = 48;
/** Ignore the intermediate scroll positions a programmatic pin reports. */
const AUTO_PIN_GUARD_MS = 160;
const SMOOTH_PIN_GUARD_MS = 800;

export function isNearBottom(element: HTMLElement): boolean {
  return isNearBottomAt(element, element.scrollTop);
}

function isNearBottomAt(element: HTMLElement, offset: number): boolean {
  return element.scrollHeight - offset - element.clientHeight <= BOTTOM_SLACK_PX;
}

export function useScrollFollow({ scrollerRef, itemCount }: ScrollFollowOptions): ScrollFollow {
  const [atBottom, setAtBottom] = useState(true);
  const followingRef = useRef(true);
  const frameRef = useRef<number | null>(null);
  const guardUntilRef = useRef(0);

  const scrollToBottom = useCallback(
    (behavior: ScrollBehavior = "auto") => {
      const element = scrollerRef.current;
      if (!element) return;
      followingRef.current = true;
      setAtBottom(true);
      guardUntilRef.current =
        performance.now() + (behavior === "smooth" ? SMOOTH_PIN_GUARD_MS : AUTO_PIN_GUARD_MS);
      element.scrollTo({ top: element.scrollHeight, behavior });
    },
    [scrollerRef]
  );

  const restore = useCallback(
    (offset: number | null) => {
      const element = scrollerRef.current;
      if (!element) return;
      if (offset == null || isNearBottomAt(element, offset)) {
        scrollToBottom("auto");
        return;
      }
      // The tab is still scrolled up: leave follow mode off until the user
      // returns to the bottom, and let the frame pin below respect that.
      followingRef.current = false;
      setAtBottom(false);
      guardUntilRef.current = performance.now() + AUTO_PIN_GUARD_MS;
      element.scrollTop = offset;
    },
    [scrollerRef, scrollToBottom]
  );

  useEffect(() => {
    const element = scrollerRef.current;
    if (!element) return;

    const readPosition = () => {
      if (frameRef.current !== null) return;
      frameRef.current = requestAnimationFrame(() => {
        frameRef.current = null;
        const node = scrollerRef.current;
        if (!node) return;
        const atEnd = isNearBottom(node);
        if (!atEnd && performance.now() < guardUntilRef.current) return;
        followingRef.current = atEnd;
        setAtBottom(atEnd);
      });
    };

    // A wheel notch upwards is intent, not a side effect of layout changes, so
    // it leaves follow mode before the scroll handler has to infer it.
    const wheelUp = (event: WheelEvent) => {
      if (event.deltaY >= 0) return;
      followingRef.current = false;
      setAtBottom(false);
    };

    element.addEventListener("scroll", readPosition, { passive: true });
    element.addEventListener("wheel", wheelUp, { passive: true });

    return () => {
      element.removeEventListener("scroll", readPosition);
      element.removeEventListener("wheel", wheelUp);
      if (frameRef.current !== null) {
        cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
      }
    };
  }, [scrollerRef]);

  useLayoutEffect(() => {
    if (itemCount === 0 || !followingRef.current) return;
    // Pin synchronously first so a render burst cannot starve the frame below,
    // then pin again once the newest row reports its measured height.
    const element = scrollerRef.current;
    if (element) {
      guardUntilRef.current = performance.now() + AUTO_PIN_GUARD_MS;
      element.scrollTop = element.scrollHeight;
    }
    const frame = requestAnimationFrame(() => {
      // A tab switch may have restored an older offset in between; never
      // override a deliberate scroll-up with the deferred pin.
      if (followingRef.current) scrollToBottom("auto");
    });
    return () => cancelAnimationFrame(frame);
  }, [itemCount, scrollToBottom, scrollerRef]);

  return { atBottom, scrollToBottom, restore };
}
