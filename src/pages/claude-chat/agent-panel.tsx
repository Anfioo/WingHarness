/**
 * The sub-agent panel: every sub-agent tool call (`Task` or `Agent`, depending
 * on the CLI version) in the transcript, as a navigable index. Clicking a row
 * scrolls the transcript to that tool card and flashes it.
 *
 * A permanently open sidebar would take a quarter of the ~800px window away
 * from the conversation, so this is a right-side drawer behind a count button
 * in the transcript's corner.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { Ban, Bot, Check, CircleAlert, Loader2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { cn } from "@/lib/utils";
import { isSubagentTool, stringField, toolTitle } from "./format";

/**
 * Set on every rendered tool card in `transcript.tsx`. Deliberately not
 * `data-anchor-id`: that one belongs to the user-message rail, which must not
 * pick up tool cards.
 */
const TOOL_ANCHOR_ATTRIBUTE = "data-tool-anchor-id";

const HIGHLIGHT_MS = 1600;
/** `rounded-lg` matches the card itself, so the ring hugs its border. */
const HIGHLIGHT_CLASSES = ["rounded-lg", "ring-2", "ring-primary/60"];

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;
type AgentStatus = "running" | "done" | "failed" | "stopped";

interface AgentEntry {
  /** The transcript item id, which is what the card's anchor carries. */
  id: string;
  /** Empty when the call carried no description, so the row needs a fallback. */
  title: string;
  status: AgentStatus;
  childCount: number;
}

const STATUS_ICONS: Record<AgentStatus, LucideIcon> = {
  running: Loader2,
  done: Check,
  failed: CircleAlert,
  stopped: Ban,
};

const STATUS_LABELS: Record<AgentStatus, string> = {
  running: "agentRunning",
  done: "agentDone",
  failed: "agentFailed",
  stopped: "agentStopped",
};

const STATUS_CLASSES: Record<AgentStatus, string> = {
  running: "text-primary animate-spin",
  done: "text-emerald-600 dark:text-emerald-400",
  failed: "text-destructive",
  stopped: "text-muted-foreground",
};

function statusOf(result: ToolItem["result"]): AgentStatus {
  if (result === null) return "running";
  if (result.stopped === true) return "stopped";
  if (result.isError === true) return "failed";
  return "done";
}

function toEntries(items: TranscriptItem[]): AgentEntry[] {
  // Sub-agent output points at its parent tool call through `parentToolUseId`.
  const children = new Map<string, number>();
  for (const item of items) {
    if (item.kind === "result" || item.parentToolUseId === null) continue;
    children.set(item.parentToolUseId, (children.get(item.parentToolUseId) ?? 0) + 1);
  }

  const entries: AgentEntry[] = [];
  for (const item of items) {
    if (item.kind !== "tool" || !isSubagentTool(item.toolName)) continue;
    // The title is the call's own description. `toolArgument` would fall back
    // to `subagent_type`, which is a type name rather than a title.
    const described = stringField(item.input, "description").trim();
    entries.push({
      id: item.id,
      title: described ? toolTitle(item.toolName, item.input) : "",
      status: statusOf(item.result),
      childCount: children.get(item.toolUseId) ?? 0,
    });
  }
  return entries;
}

export function AgentPanel({
  items,
  containerRef,
}: {
  items: TranscriptItem[];
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const entries = useMemo(() => toEntries(items), [items]);
  const running = entries.some((entry) => entry.status === "running");
  const flashRef = useRef<{ node: HTMLElement; timer: ReturnType<typeof setTimeout> } | null>(null);

  const select = useCallback(
    (id: string) => {
      // The card is behind the drawer, so closing it is part of the jump.
      setOpen(false);
      const container = containerRef.current;
      if (!container) return;
      const node = container.querySelector<HTMLElement>(
        `[${TOOL_ANCHOR_ATTRIBUTE}="${CSS.escape(id)}"]`
      );
      if (!node) return;

      // Land the card about a third down the viewport rather than at its very
      // top, the same way the user-message rail lands a question.
      const offset =
        node.getBoundingClientRect().top -
        container.getBoundingClientRect().top +
        container.scrollTop;
      container.scrollTo({
        top: Math.max(0, offset - container.clientHeight * 0.28),
        behavior: "smooth",
      });

      // Only one flash is tracked at a time; a previous timer would otherwise
      // strip the class off a card the user just re-selected.
      const previous = flashRef.current;
      if (previous) {
        clearTimeout(previous.timer);
        previous.node.classList.remove(...HIGHLIGHT_CLASSES);
      }
      node.classList.add(...HIGHLIGHT_CLASSES);
      const timer = setTimeout(() => {
        node.classList.remove(...HIGHLIGHT_CLASSES);
        flashRef.current = null;
      }, HIGHLIGHT_MS);
      flashRef.current = { node, timer };
    },
    [containerRef]
  );

  if (entries.length === 0) return null;

  const messageCount = entries.reduce((sum, entry) => sum + entry.childCount, 0);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          title={t("claudeChat.agents")}
          className="bg-card/90 absolute top-2 right-3 z-20 gap-1.5 shadow-sm"
        >
          <Bot className="size-4" />
          {running && <Loader2 className="text-primary size-3.5 animate-spin" />}
          <span className="bg-primary/15 text-primary rounded-full px-1.5 font-mono text-[10px] leading-4 font-semibold">
            {entries.length}
          </span>
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-2 sm:max-w-sm">
        <SheetHeader>
          <SheetTitle>{t("claudeChat.agents")}</SheetTitle>
          <SheetDescription className="text-muted-foreground text-xs">
            {t("claudeChat.agentMessages", { count: messageCount })}
          </SheetDescription>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
          <div className="flex flex-col gap-2">
            {entries.map((entry) => {
              const Icon = STATUS_ICONS[entry.status];
              const title = entry.title || t("claudeChat.agentUntitled");
              return (
                <button
                  key={entry.id}
                  type="button"
                  title={entry.title || undefined}
                  onClick={() => select(entry.id)}
                  className="border-border hover:bg-accent flex w-full items-start gap-2 rounded-lg border p-2.5 text-left transition-colors"
                >
                  <Icon className={cn("mt-0.5 size-4 shrink-0", STATUS_CLASSES[entry.status])} />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="truncate font-mono text-xs font-medium">{title}</span>
                    <span className="text-muted-foreground text-[11px]">
                      {t(`claudeChat.${STATUS_LABELS[entry.status]}`)} ·{" "}
                      {t("claudeChat.agentMessages", { count: entry.childCount })}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}
