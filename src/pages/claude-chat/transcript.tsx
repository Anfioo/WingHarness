/**
 * Renders the flat transcript: user/assistant text bubbles, thinking blocks,
 * tool cards, and the per-turn result footer.
 *
 * Items whose `parentToolUseId` names a tool card on screen are rendered inside
 * that card instead of in the main column, which is what makes sub-agent (Task)
 * output appear nested under its parent.
 */

import { Bot, Loader2, User } from "lucide-react";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { ResultFooter } from "./result-footer";
import { ThinkingBlock } from "./thinking-block";
import { ToolCard } from "./tool-card";

export function Transcript({ items }: { items: TranscriptItem[] }) {
  // Tool calls that own nested output, keyed by the tool_use id children point at.
  const childrenByParent = new Map<string, TranscriptItem[]>();
  const visibleToolIds = new Set<string>();

  for (const item of items) {
    if (item.kind === "tool") visibleToolIds.add(item.toolUseId);
  }
  for (const item of items) {
    if (item.kind === "result" || item.parentToolUseId === null) continue;
    if (!visibleToolIds.has(item.parentToolUseId)) continue;
    const siblings = childrenByParent.get(item.parentToolUseId);
    if (siblings) siblings.push(item);
    else childrenByParent.set(item.parentToolUseId, [item]);
  }

  const renderItem = (item: TranscriptItem): React.ReactNode => {
    switch (item.kind) {
      case "user":
        return <UserBubble key={item.id} item={item} />;
      case "assistant":
        return <AssistantBubble key={item.id} item={item} />;
      case "thinking":
        return <ThinkingBlock key={item.id} item={item} />;
      case "tool": {
        const children = childrenByParent.get(item.toolUseId);
        return (
          // The sub-agent panel (agent-panel.tsx) finds the card through this
          // attribute. It is not `data-anchor-id`: that one is the user-message
          // rail's, and it must not pick up tool cards.
          <div key={item.id} data-tool-anchor-id={item.id}>
            <ToolCard
              item={item}
              nested={
                children?.length ? (
                  <div className="border-border mt-2 flex flex-col gap-3 border-l-2 pl-3">
                    {children.map(renderItem)}
                  </div>
                ) : undefined
              }
            />
          </div>
        );
      }
      case "result":
        return <ResultFooter key={item.id} item={item} />;
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        // Nested items are rendered by their parent card, not here.
        const nested =
          item.kind !== "result" &&
          item.parentToolUseId !== null &&
          visibleToolIds.has(item.parentToolUseId);
        return nested ? null : renderItem(item);
      })}
    </div>
  );
}

function UserBubble({ item }: { item: Extract<TranscriptItem, { kind: "user" }> }) {
  return (
    // `data-anchor-id` matches ANCHOR_ATTRIBUTE in anchor-rail.tsx, which is how
    // the rail finds the row to scroll to.
    <div className="flex flex-row-reverse gap-3" data-anchor-id={item.id}>
      <div className="bg-primary text-primary-foreground flex size-7 shrink-0 items-center justify-center rounded-full">
        <User className="size-4" />
      </div>
      <div className="bg-primary text-primary-foreground max-w-[80%] rounded-xl px-3 py-2 text-sm leading-6 whitespace-pre-wrap">
        {item.text}
      </div>
    </div>
  );
}

function AssistantBubble({ item }: { item: Extract<TranscriptItem, { kind: "assistant" }> }) {
  const { t } = useAppTranslation();
  const waiting = item.streaming && item.text === "";

  return (
    <div className="flex gap-3">
      <div className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-full">
        <Bot className="size-4" />
      </div>
      <div
        className={cn(
          "bg-muted text-foreground max-w-[80%] rounded-xl px-3 py-2 text-sm leading-6 whitespace-pre-wrap",
          item.isError && "bg-destructive/10 text-destructive"
        )}
      >
        {waiting ? (
          <span className="text-muted-foreground inline-flex items-center gap-2">
            <Loader2 className="size-3.5 animate-spin" />
            {t("claudeChat.thinking")}
          </span>
        ) : (
          item.text
        )}
      </div>
    </div>
  );
}
