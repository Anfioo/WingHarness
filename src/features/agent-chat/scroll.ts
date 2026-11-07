// Transcript scroll-follow.
//
// A0 freezes the hook's shape; F2 owns the final behavior (stop following when
// the user scrolls up, resume at the bottom, a "back to bottom" button).

import { useCallback, useRef, useState, type RefObject } from "react";

export interface ScrollFollow {
  containerRef: RefObject<HTMLDivElement | null>;
  atBottom: boolean;
  onScroll(): void;
  scrollToBottom(track?: boolean): void;
}

const BOTTOM_SLACK_PX = 8;

export function useScrollFollow(): ScrollFollow {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [atBottom, setAtBottom] = useState(true);

  const scrollToBottom = useCallback((track = true) => {
    const element = containerRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    if (track) setAtBottom(true);
  }, []);

  const onScroll = useCallback(() => {
    const element = containerRef.current;
    if (!element) return;
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAtBottom(distance <= BOTTOM_SLACK_PX);
  }, []);

  return { containerRef, atBottom, onScroll, scrollToBottom };
}
