/**
 * The user-message anchor rail: a track of dots in the gutter left of the chat
 * cards, one dot per visible user message. Hovering a dot previews the question,
 * clicking scrolls the transcript to it.
 *
 * Mirrors the jetbrains-cc-gui `MessageAnchorRail` so both clients behave the
 * same: even sampling once a conversation gets long, a delayed tooltip, and the
 * topmost anchor inside the upper part of the viewport marked active.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { cn } from "@/lib/utils";

/** Set on every rendered user row; the rail finds those rows through it. */
export const ANCHOR_ATTRIBUTE = "data-anchor-id";

const MAX_ANCHOR_COUNT = 30;
const MAX_PREVIEW_LENGTH = 300;
const TOOLTIP_DELAY_MS = 500;
/** Keep the dots off the edges of the track. */
const START_POSITION = 0.04;
const POSITION_SPAN = 0.92;

/** Formatting characters that would show up as stray boxes in a tooltip. */
const INVISIBLE = new Set([0x7f, 0x200b, 0x200c, 0x200d, 0xfeff]);

type Anchor = { id: string; preview: string; position: number };
type UserItem = Extract<TranscriptItem, { kind: "user" }>;

/** Flattens a question into a single line, dropping control characters. */
function toPreview(text: string): string {
  let flat = "";
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    const control = code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d;
    flat += control || INVISIBLE.has(code) ? " " : char;
  }
  flat = flat.replace(/\s+/g, " ").trim();
  return flat.length > MAX_PREVIEW_LENGTH ? `${flat.slice(0, MAX_PREVIEW_LENGTH)}...` : flat;
}

/** Thins a long list evenly, always keeping the first and the last entry. */
function sample(users: UserItem[]): UserItem[] {
  if (users.length <= MAX_ANCHOR_COUNT) return users;
  const last = users.length - 1;
  const picked: UserItem[] = [];
  for (let index = 0; index < MAX_ANCHOR_COUNT; index += 1) {
    picked.push(users[Math.round((index / (MAX_ANCHOR_COUNT - 1)) * last)]);
  }
  return picked;
}

function buildAnchors(items: TranscriptItem[]): Anchor[] {
  const users = items.filter((item): item is UserItem => item.kind === "user");
  // A single dot carries no information, so the rail only appears from the
  // second question on — and this also guards the position division below.
  if (users.length <= 1) return [];
  const picked = sample(users);
  return picked.map((item, index) => ({
    id: item.id,
    preview: toPreview(item.text),
    position: START_POSITION + (index / (picked.length - 1)) * POSITION_SPAN,
  }));
}

/** The user rows currently rendered inside `container`, in document order. */
function userRows(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(`[${ANCHOR_ATTRIBUTE}]`));
}

export function AnchorRail({
  items,
  containerRef,
}: {
  items: TranscriptItem[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useAppTranslation();
  const [activeId, setActiveId] = useState<string | null>(null);
  const [tooltipId, setTooltipId] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const anchors = useMemo(() => buildAnchors(items), [items]);
  // Re-observing on every streamed token would be pure churn: the ids are what
  // actually change the set of dots.
  const anchorKey = anchors.map((anchor) => anchor.id).join("|");

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const handleEnter = useCallback(
    (id: string) => {
      clearTimer();
      timerRef.current = setTimeout(() => setTooltipId(id), TOOLTIP_DELAY_MS);
    },
    [clearTimer]
  );

  const handleLeave = useCallback(() => {
    clearTimer();
    setTooltipId(null);
  }, [clearTimer]);

  const scrollTo = useCallback(
    (id: string) => {
      const container = containerRef.current;
      if (!container) return;
      const node = userRows(container).find((row) => row.dataset.anchorId === id);
      if (!node) return;
      // Land the message about a third down the viewport rather than at its very
      // top, so the surrounding turn stays readable.
      const offset =
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      container.scrollTo({
        top: Math.max(0, offset - container.clientHeight * 0.28),
        behavior: "smooth",
      });
      setActiveId(id);
    },
    [containerRef]
  );

  // The active dot is the first question still inside the top part of the
  // viewport; an observer avoids a layout read on every scroll frame.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || anchorKey === "") return;
    const ids = new Set(anchorKey.split("|"));
    const rows = userRows(container).filter((row) => ids.has(row.dataset.anchorId ?? ""));
    if (rows.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const id = (entry.target as HTMLElement).dataset.anchorId;
          if (!id) continue;
          if (entry.isIntersecting) visible.add(id);
          else visible.delete(id);
        }
        const first = rows.find((row) => visible.has(row.dataset.anchorId ?? ""));
        setActiveId(first?.dataset.anchorId ?? null);
      },
      { root: container, rootMargin: "0px 0px -68% 0px", threshold: 0 }
    );
    for (const row of rows) observer.observe(row);
    return () => observer.disconnect();
  }, [anchorKey, containerRef]);

  if (anchors.length === 0) return null;

  // A stale id (a revealed turn, a new session) simply stops matching, so the
  // hover and active states are resolved here instead of being cleared by an
  // effect.
  const known = new Set(anchors.map((anchor) => anchor.id));
  const hovered = tooltipId !== null && known.has(tooltipId) ? tooltipId : null;
  const active = activeId !== null && known.has(activeId) ? activeId : null;

  return (
    // The rail itself ignores the pointer so the transcript still scrolls; only
    // the dots opt back in.
    <nav
      aria-label={t("claudeChat.anchors")}
      className="pointer-events-none absolute top-10 bottom-6 left-1 z-10 flex w-5 items-center justify-center"
    >
      <div
        aria-hidden="true"
        className="bg-border absolute top-0 bottom-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full opacity-50"
      />
      {anchors.map((anchor, index) => (
        <button
          key={anchor.id}
          type="button"
          aria-label={t("claudeChat.anchorGoTo", { index: index + 1 })}
          className={cn(
            "border-muted-foreground/60 bg-card pointer-events-auto absolute left-1/2 size-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 transition duration-200",
            "hover:border-primary hover:bg-primary hover:scale-125",
            "focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none",
            active === anchor.id && "border-primary bg-primary ring-primary/25 ring-2"
          )}
          style={{ top: `${anchor.position * 100}%` }}
          onClick={() => scrollTo(anchor.id)}
          onMouseEnter={() => handleEnter(anchor.id)}
          onMouseLeave={handleLeave}
        >
          {hovered === anchor.id && anchor.preview && (
            <span className="border-border bg-popover text-popover-foreground pointer-events-none absolute top-1/2 left-[calc(100%+8px)] w-max max-w-[400px] -translate-y-1/2 rounded-md border px-2.5 py-1.5 text-left text-[10px] leading-[1.4] break-words whitespace-pre-wrap shadow-sm">
              {anchor.preview}
            </span>
          )}
        </button>
      ))}
    </nav>
  );
}
