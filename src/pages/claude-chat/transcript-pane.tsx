/**
 * The scrollable transcript: the message window, the "load earlier turns"
 * affordance, auto-scroll, and the anchor rail in the gutter.
 *
 * Opening a long restored session should not dump hundreds of messages on
 * screen, so only the newest `INITIAL_VISIBLE_TURNS` questions are shown at
 * first and the rest are revealed a page at a time from the top, matching the
 * jetbrains-cc-gui client. The cut always lands on a user item, so a turn's tool
 * calls and reply are never split from the question that started them.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { Bot } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { AgentPanel } from "./agent-panel";
import { AnchorRail } from "./anchor-rail";
import { Transcript } from "./transcript";

const INITIAL_VISIBLE_TURNS = 3;
const REVEAL_TURN_PAGE_SIZE = 5;

export function TranscriptPane({ items }: { items: TranscriptItem[] }) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [revealedTurns, setRevealedTurns] = useState(0);

  const userTurns = useMemo(
    () =>
      items.reduce<number[]>((indexes, item, index) => {
        if (item.kind === "user") indexes.push(index);
        return indexes;
      }, []),
    [items]
  );

  const hiddenTurns = Math.max(0, userTurns.length - INITIAL_VISIBLE_TURNS - revealedTurns);
  const cut = hiddenTurns > 0 ? userTurns[hiddenTurns] : 0;
  const visibleItems = cut > 0 ? items.slice(cut) : items;

  // Pinning to the bottom keeps streaming output in view. Revealing earlier
  // turns deliberately does not run this: the pane keeps its scroll offset, so
  // the freshly shown messages are the ones that come into sight.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <div
        ref={scrollRef}
        className="border-border bg-card text-card-foreground min-h-0 flex-1 overflow-y-auto rounded-xl border p-4 pl-7 shadow-sm"
      >
        {items.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
            <Bot className="text-muted-foreground size-10" />
            <p className="text-muted-foreground text-sm">{t("claudeChat.empty")}</p>
          </div>
        ) : (
          <>
            {hiddenTurns > 0 && (
              <button
                type="button"
                onClick={() => setRevealedTurns((revealed) => revealed + REVEAL_TURN_PAGE_SIZE)}
                className="text-muted-foreground hover:text-foreground mb-4 w-full cursor-pointer py-2 text-center text-[13px] opacity-80 transition-opacity hover:opacity-100"
              >
                {t("claudeChat.loadEarlierTurns", { count: hiddenTurns })}
              </button>
            )}
            <Transcript items={visibleItems} />
          </>
        )}
      </div>
      <AnchorRail items={visibleItems} containerRef={scrollRef} />
      {/* Indexes the Task cards among the rows rendered above. */}
      <AgentPanel items={visibleItems} containerRef={scrollRef} />
    </div>
  );
}
