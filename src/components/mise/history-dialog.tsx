// The full action history: one collapsible row per mise command, newest first.
// A row shows the status, command, time and exit code; expanding it reveals the
// captured stdout and stderr, which the engine may have truncated already.

import { ChevronDown } from "lucide-react";
import { useState } from "react";

import type { MiseHealthLevel, MiseHistoryStatus } from "@/commands";
import type { HistoryDialogProps } from "@/components/mise/props";
import { StatusBadge } from "@/components/mise/status-badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatDuration, formatTimestamp, historyStatusKey } from "@/lib/mise/format";
import { cn } from "@/lib/utils";

const STATUS_LEVEL: Record<MiseHistoryStatus, MiseHealthLevel> = {
  success: "healthy",
  failure: "critical",
  canceled: "info",
};

function OutputBlock({ label, value }: { label: string; value: string | null }) {
  const { t } = useAppTranslation();
  const text = value && value.trim() ? value : t("mise.history.noOutput");

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <pre className="bg-muted max-h-64 overflow-auto rounded-md p-2 font-mono text-xs leading-relaxed whitespace-pre select-text">
        {text}
      </pre>
    </div>
  );
}

export function HistoryDialog({ open, entries, onOpenChange }: HistoryDialogProps) {
  const { t, language } = useAppTranslation();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const rows = [...entries].sort((left, right) => right.timestampMs - left.timestampMs);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("mise.history.title")}</DialogTitle>
        </DialogHeader>

        {rows.length === 0 ? (
          <div className="text-muted-foreground py-10 text-center text-sm">
            {t("mise.history.empty")}
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {rows.map((entry) => {
              const expanded = expandedId === entry.id;
              return (
                <li
                  key={entry.id}
                  className="border-border bg-card overflow-hidden rounded-lg border"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    onClick={() => setExpandedId(expanded ? null : entry.id)}
                    className="hover:bg-accent/40 flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left transition-colors"
                  >
                    <StatusBadge
                      level={STATUS_LEVEL[entry.status]}
                      label={t(historyStatusKey(entry.status))}
                    />
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <code className="font-mono text-xs leading-relaxed break-all select-text">
                        {entry.command}
                      </code>
                      <div className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px]">
                        <span>{formatTimestamp(entry.timestampMs, language)}</span>
                        {entry.exitCode != null && (
                          <span>
                            {t("mise.history.field.exitCode")} {entry.exitCode}
                          </span>
                        )}
                        {entry.durationMs != null && (
                          <span>{formatDuration(entry.durationMs)}</span>
                        )}
                      </div>
                      <p className="text-muted-foreground text-xs break-words">{entry.detail}</p>
                    </div>
                    <ChevronDown
                      className={cn(
                        "mt-0.5 size-4 shrink-0 transition-transform",
                        expanded && "rotate-180"
                      )}
                    />
                  </button>
                  {expanded && (
                    <div className="border-border flex flex-col gap-3 border-t px-3 py-3">
                      <OutputBlock label={t("mise.history.field.stdout")} value={entry.stdout} />
                      <OutputBlock label={t("mise.history.field.stderr")} value={entry.stderr} />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
