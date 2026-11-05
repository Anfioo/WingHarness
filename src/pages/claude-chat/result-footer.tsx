/**
 * One line per finished turn: status, duration and cost, as reported by the
 * CLI's terminal `result` event.
 */

import { CircleAlert, CircleCheck, CircleSlash } from "lucide-react";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatCost, formatDuration } from "./format";

type ResultItem = Extract<TranscriptItem, { kind: "result" }>;

export function ResultFooter({ item }: { item: ResultItem }) {
  const { t } = useAppTranslation();
  const stopped = item.subtype === "interrupted";
  const Icon = stopped ? CircleSlash : item.isError ? CircleAlert : CircleCheck;

  return (
    <div
      className={cn(
        "text-muted-foreground flex items-center gap-2 px-1 text-xs",
        item.isError && "text-destructive"
      )}
    >
      <Icon className="size-3.5 shrink-0" />
      <span>
        {stopped
          ? t("claudeChat.turnStopped")
          : item.isError
            ? t("claudeChat.turnFailed", { subtype: item.subtype })
            : t("claudeChat.turnDone")}
      </span>
      {item.durationMs !== undefined && (
        <span className="font-mono">· {formatDuration(item.durationMs)}</span>
      )}
      {item.totalCostUsd !== undefined && (
        <span className="font-mono">· {formatCost(item.totalCostUsd)}</span>
      )}
    </div>
  );
}
