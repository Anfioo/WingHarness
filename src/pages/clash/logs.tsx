import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Pause, Play, RefreshCw, ScrollText, Search } from "lucide-react";
import { clashLogs, type ClashLogLine } from "@/commands";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { Empty, IconButton, Segmented } from "./shared";

/** The core writes continuously while it runs, so a second is the useful pace. */
const POLL_MS = 1000;
const LIMIT = 300;
/** Within this distance of the end, new lines pull the list along. */
const STICK_PX = 24;

type LevelFilter = "all" | "debug" | "info" | "warning" | "error";

/** Picking a level keeps it and everything worse, as the core's own levels nest. */
const RANKS: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3, fatal: 4 };

export function LogsTab() {
  const { t } = useAppTranslation();

  const [lines, setLines] = useState<ClashLogLine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [level, setLevel] = useState<LevelFilter>("all");
  const [query, setQuery] = useState("");
  const [paused, setPaused] = useState(false);
  const mounted = useRef(true);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const view = await clashLogs(LIMIT);
      if (!mounted.current) return;
      setLines(view.lines);
      setError(null);
    } catch (cause) {
      if (!mounted.current) return;
      setLines(null);
      setError(String(cause));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    if (paused) {
      return () => {
        mounted.current = false;
      };
    }
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [load, paused]);

  const visible = useMemo(() => {
    const floor = level === "all" ? 0 : (RANKS[level] ?? 0);
    const needle = query.trim().toLowerCase();
    return (lines ?? []).filter((line) => {
      if (level !== "all" && (RANKS[line.level] ?? 1) < floor) return false;
      return !needle || line.message.toLowerCase().includes(needle);
    });
  }, [level, lines, query]);

  // Following the tail is only useful while the reader is already at it; a
  // reader who scrolled up is reading, so the next line must not yank the view.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !stick.current) return;
    element.scrollTop = element.scrollHeight;
  }, [visible]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="relative min-w-0 flex-1">
          <Search className="text-muted-foreground/60 pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2" />
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("clash.logs.search")}
            className="h-8 pl-8 text-sm"
          />
        </div>
        <Segmented
          value={level}
          options={[
            { value: "all", label: t("clash.logs.level.all") },
            { value: "debug", label: t("clash.logs.level.debug") },
            { value: "info", label: t("clash.logs.level.info") },
            { value: "warning", label: t("clash.logs.level.warning") },
            { value: "error", label: t("clash.logs.level.error") },
          ]}
          onChange={setLevel}
        />
        <span className="text-muted-foreground shrink-0 text-xs tabular-nums">
          {t("clash.logs.count", { count: visible.length })}
        </span>
        {paused ? (
          <IconButton title={t("clash.logs.resume")} onClick={() => setPaused(false)}>
            <Play className="size-3.5" />
          </IconButton>
        ) : (
          <IconButton title={t("clash.logs.pause")} onClick={() => setPaused(true)}>
            <Pause className="size-3.5" />
          </IconButton>
        )}
        <IconButton title={t("clash.actions.refresh")} onClick={() => void load()}>
          <RefreshCw className="size-3.5" />
        </IconButton>
      </div>

      <div
        ref={scrollRef}
        onScroll={(event) => {
          const element = event.currentTarget;
          stick.current =
            element.scrollHeight - element.scrollTop - element.clientHeight <= STICK_PX;
        }}
        className="min-h-0 flex-1 overflow-auto"
      >
        {error ? (
          <Empty icon={ScrollText} text={error} />
        ) : lines === null ? null : visible.length === 0 ? (
          <Empty
            icon={ScrollText}
            text={query.trim() || level !== "all" ? t("clash.logs.noMatch") : t("clash.logs.empty")}
          />
        ) : (
          <div className="flex flex-col">
            {visible.map((line, index) => (
              <div
                key={`${index}-${line.time}-${line.message.slice(0, 24)}`}
                className="flex items-baseline gap-2 px-3 py-0.5 font-mono text-xs leading-5"
              >
                <span className="text-muted-foreground/60 w-16 shrink-0 tabular-nums">
                  {shortTime(line.time)}
                </span>
                <span className={cn("w-14 shrink-0 uppercase", levelTone(line.level))}>
                  {line.level}
                </span>
                <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{line.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/** logrus writes an RFC3339 stamp; the seconds are what a reader scans for. */
function shortTime(time: string): string {
  const match = /(\d{2}:\d{2}:\d{2})/.exec(time);
  return match ? match[1] : "";
}

function levelTone(level: string): string {
  switch (level) {
    case "error":
    case "fatal":
      return "text-red-600 dark:text-red-400";
    case "warning":
      return "text-amber-600 dark:text-amber-400";
    case "debug":
      return "text-muted-foreground/60";
    default:
      return "text-muted-foreground";
  }
}
