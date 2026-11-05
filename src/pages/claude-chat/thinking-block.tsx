/**
 * Extended-thinking block. Expanded while the deltas stream in, collapsed once
 * the message settles — without fighting a user who opened it afterwards.
 */

import { useEffect, useRef } from "react";
import { Brain, Loader2 } from "lucide-react";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { lineCount } from "./format";

type ThinkingItem = Extract<TranscriptItem, { kind: "thinking" }>;

export function ThinkingBlock({ item }: { item: ThinkingItem }) {
  const { t } = useAppTranslation();
  const ref = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (ref.current) ref.current.open = item.streaming;
  }, [item.streaming]);

  return (
    <details ref={ref} className="border-border bg-muted/30 overflow-hidden rounded-lg border">
      <summary className="text-muted-foreground hover:text-foreground flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs">
        {item.streaming ? (
          <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
        ) : (
          <Brain className="size-3.5 shrink-0" />
        )}
        <span>{item.streaming ? t("claudeChat.thinking") : t("claudeChat.thought")}</span>
        <span className="ml-auto font-mono text-xs tracking-wider uppercase">
          {lineCount(item.text)}L
        </span>
      </summary>
      <pre className="text-muted-foreground max-h-72 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre-wrap italic">
        {item.text}
      </pre>
    </details>
  );
}
