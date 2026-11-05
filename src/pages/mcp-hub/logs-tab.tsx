import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import {
  mcphubListServers,
  mcphubRecentLogs,
  type LogEntry,
  type LogLevel,
  type ServerView,
} from "@/commands";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { Badge } from "./ui-bits";

const levelTone: Record<LogLevel, "gray" | "amber" | "red"> = {
  info: "gray",
  warn: "amber",
  error: "red",
};

function formatTime(ts: number) {
  const d = new Date(ts);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function LogsTab() {
  const { t } = useAppTranslation();
  const [entries, setEntries] = useState<LogEntry[]>([]);
  const [servers, setServers] = useState<ServerView[]>([]);
  const [loading, setLoading] = useState(true);
  const [serverFilter, setServerFilter] = useState<string>("all");
  const [levelFilter, setLevelFilter] = useState<string>("all");
  const [limit, setLimit] = useState<number>(50);
  const listRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [logList, serverList] = await Promise.all([
        mcphubRecentLogs({
          server: serverFilter === "all" ? undefined : serverFilter,
          level: levelFilter === "all" ? undefined : (levelFilter as LogLevel),
          limit,
        }),
        mcphubListServers(),
      ]);
      setEntries(logList);
      setServers(serverList);
    } catch (error) {
      console.error("mcphub recent logs:", error);
      toast.error(t("mcphub.logs.loadFailed"));
    } finally {
      setLoading(false);
    }
  }, [levelFilter, limit, serverFilter, t]);

  useEffect(() => {
    void load();
  }, [load]);

  // Auto-scroll to bottom (newest at top per task, but scroll to show latest).
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = 0;
  }, [entries]);

  const levelLabel = useMemo<Record<LogLevel, string>>(
    () => ({
      info: t("mcphub.logs.levelInfo"),
      warn: t("mcphub.logs.levelWarn"),
      error: t("mcphub.logs.levelError"),
    }),
    [t]
  );

  return (
    <div className="flex h-full flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={serverFilter} onValueChange={setServerFilter}>
          <SelectTrigger size="sm" className="w-44">
            <SelectValue placeholder={t("mcphub.logs.filterAllServers")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("mcphub.logs.filterAllServers")}</SelectItem>
            {servers.map((s) => (
              <SelectItem key={s.name} value={s.name}>
                {s.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={levelFilter} onValueChange={setLevelFilter}>
          <SelectTrigger size="sm" className="w-32">
            <SelectValue placeholder={t("mcphub.logs.filterAllLevels")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("mcphub.logs.filterAllLevels")}</SelectItem>
            <SelectItem value="info">{levelLabel.info}</SelectItem>
            <SelectItem value="warn">{levelLabel.warn}</SelectItem>
            <SelectItem value="error">{levelLabel.error}</SelectItem>
          </SelectContent>
        </Select>

        <label className="flex items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("mcphub.logs.limit")}:</span>
          <Input
            type="number"
            min={10}
            max={500}
            className="h-8 w-20"
            value={limit}
            onChange={(e) => setLimit(Math.max(10, Number(e.target.value) || 50))}
          />
        </label>
      </div>

      {loading ? (
        <div className="flex h-32 items-center justify-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin" />
          {t("mcphub.loading")}
        </div>
      ) : entries.length === 0 ? (
        <div className="border-border/60 rounded-lg border border-dashed p-8 text-center text-sm">
          <p className="text-muted-foreground">{t("mcphub.logs.empty")}</p>
        </div>
      ) : (
        <div
          ref={listRef}
          className="bg-muted/40 min-h-0 flex-1 overflow-auto rounded-lg border px-3 py-2 font-mono text-xs leading-5"
        >
          {entries.map((entry, idx) => (
            <div
              key={idx}
              className={cn(
                "flex gap-2 border-b py-1 last:border-b-0",
                entry.level === "error" && "text-destructive"
              )}
            >
              <span className="text-muted-foreground shrink-0">{formatTime(entry.ts)}</span>
              <Badge tone={levelTone[entry.level]}>{levelLabel[entry.level]}</Badge>
              {entry.server && (
                <span className="shrink-0 text-sky-600 dark:text-sky-400">[{entry.server}]</span>
              )}
              <span className="break-all whitespace-pre-wrap">{entry.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
