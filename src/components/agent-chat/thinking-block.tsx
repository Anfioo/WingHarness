import { memo, useState } from "react";
import type { JSX } from "react";
import { ChevronDown, ChevronRight, Lightbulb } from "lucide-react";

import { useAppTranslation } from "@/hooks/use-app-translation";
import type { AgentMessageRow } from "@/features/agent-chat/types";

type ThinkingRow = Extract<AgentMessageRow, { kind: "thinking" }>;

function AgentThinkingBlockBase({ row }: { row: ThinkingRow }): JSX.Element {
  const { t } = useAppTranslation();
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? (row.live || !row.collapsed);

  return (
    <div className="rounded-lg border border-dashed px-3 py-1.5">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOverride(!open)}
        className="flex w-full items-center gap-2 text-left"
      >
        {open ? (
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
        )}
        <Lightbulb className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-muted-foreground text-xs font-medium">
          {t("agentChat.thinking.title")}
        </span>
        <span className="text-muted-foreground/70 text-[11px] tabular-nums">
          {row.text.length.toLocaleString()}
        </span>
        <span className="text-muted-foreground/80 ml-auto text-[11px]">
          {row.live ? t("agentChat.thinking.streaming") : t("agentChat.thinking.done")}
        </span>
      </button>
      {open ? (
        <div className="text-muted-foreground mt-1.5 border-t pt-1.5 text-xs break-words whitespace-pre-wrap italic">
          {row.text}
        </div>
      ) : null}
    </div>
  );
}

export const AgentThinkingBlock = memo(AgentThinkingBlockBase);
