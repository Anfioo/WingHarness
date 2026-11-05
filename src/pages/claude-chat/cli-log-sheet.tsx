/**
 * The CLI log drawer: the raw traffic between this app and the `claude`
 * process — the command that ran, the frames written to its stdin, the lines it
 * wrote to stdout/stderr, and the events the host synthesized when it ended.
 *
 * The lines are collected by the session, not here, so the drawer can be opened
 * after the fact and still show the turn that already ran. Rendering is bounded
 * by that collection (300 lines, 8000 characters each): a long tool result would
 * otherwise put megabytes of text into the DOM.
 */

import { useEffect, useRef, useState } from "react";
import { Eraser, Terminal } from "lucide-react";
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
import type { CliLogDirection, CliLogEntry } from "@/lib/use-claude/types";
import { cn } from "@/lib/utils";

const BADGES: Record<CliLogDirection, { mark: string; className: string }> = {
  spawn: { mark: "$", className: "text-primary" },
  in: { mark: "→", className: "text-foreground" },
  out: { mark: "←", className: "text-muted-foreground" },
  err: { mark: "!", className: "text-destructive" },
  sys: { mark: "·", className: "text-muted-foreground" },
};

const DIRECTION_LABELS: Record<CliLogDirection, string> = {
  spawn: "logDirSpawn",
  in: "logDirIn",
  out: "logDirOut",
  err: "logDirErr",
  sys: "logDirSys",
};

export function CliLogSheet({ logs, onClear }: { logs: CliLogEntry[]; onClear: () => void }) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  // Streaming output should stay in view, but only while the reader has not
  // scrolled up to look at something older.
  const pinnedRef = useRef(true);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [open, logs]);

  const handleScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 32;
  };

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button variant="outline" size="sm">
          <Terminal className="size-4" />
          {t("claudeChat.log")}
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className="w-full gap-2 sm:max-w-2xl">
        <SheetHeader>
          <div className="flex items-center justify-between gap-2">
            <SheetTitle>{t("claudeChat.logTitle")}</SheetTitle>
            <Button variant="ghost" size="sm" onClick={onClear} disabled={logs.length === 0}>
              <Eraser className="size-4" />
              {t("claudeChat.logClear")}
            </Button>
          </div>
          <SheetDescription className="font-mono text-xs">
            {t("claudeChat.logCount", { count: logs.length })}
          </SheetDescription>
        </SheetHeader>

        <div
          ref={scrollRef}
          onScroll={handleScroll}
          className="border-border mx-4 mb-4 min-h-0 flex-1 overflow-y-auto rounded-lg border p-2"
        >
          {logs.length === 0 ? (
            <p className="text-muted-foreground p-2 text-sm">{t("claudeChat.logEmpty")}</p>
          ) : (
            logs.map((entry) => {
              const badge = BADGES[entry.dir];
              return (
                <div
                  key={entry.id}
                  className="border-border/50 flex gap-2 border-b py-1 last:border-b-0"
                >
                  <span
                    className={cn("w-4 shrink-0 text-center font-mono text-xs", badge.className)}
                    title={t(`claudeChat.${DIRECTION_LABELS[entry.dir]}`)}
                  >
                    {badge.mark}
                  </span>
                  <span className="min-w-0 flex-1 font-mono text-[11px] leading-relaxed break-all whitespace-pre-wrap">
                    {entry.text}
                  </span>
                </div>
              );
            })
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}
