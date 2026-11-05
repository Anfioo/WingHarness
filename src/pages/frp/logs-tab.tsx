import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { FolderOpen, Loader2, Pause, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { openPath } from "@/commands";
import { frpLogsClear, frpLogsRecent, frpProfilesList } from "@/commands/services/frp";
import type { LogEntry, LogLevel } from "@/commands/services/frp/types";
import { VirtualLogList } from "@/components/frp/virtual-log-list";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type { FrpWorkspace } from "@/hooks/use-frp-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { filterLogs, type FrpLogStore } from "@/lib/frp/log-store";

const ALL_PROFILES = "__all__";
const RECENT_LIMIT = 1000;
// The log panel takes the height the page has left instead of a fixed slice of
// the viewport, so it lines up with the window at every size.
const LIST_HEIGHT_CLASS = "min-h-[18rem] flex-1";

type LevelOption = { value: string; minimum: LogLevel | null };

const LEVEL_OPTIONS: LevelOption[] = [
  { value: "all", minimum: null },
  { value: "debug", minimum: "debug" },
  { value: "info", minimum: "info" },
  { value: "warn", minimum: "warn" },
  { value: "error", minimum: "error" },
];

function entryKey(entry: LogEntry): string {
  return `${entry.profileId}|${entry.timestamp}|${entry.stream}|${entry.level}|${entry.message}`;
}

/**
 * Backfills the ring buffer with the engine's recent lines without
 * duplicating anything the live stream already pushed while the call was in
 * flight, then keeps the whole buffer oldest-first.
 */
function mergeRecent(store: FrpLogStore, recent: LogEntry[]): void {
  if (recent.length === 0) return;

  const existing = store.snapshot();
  if (existing.length === 0) {
    store.pushAll([...recent].sort((a, b) => a.timestamp - b.timestamp));
    return;
  }

  const seen = new Set(existing.map(entryKey));
  const merged = [...existing];
  for (const entry of recent) {
    const key = entryKey(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  if (merged.length === existing.length) return;

  merged.sort((a, b) => a.timestamp - b.timestamp);
  store.clear(null);
  store.pushAll(merged);
}

export type LogsTabProps = {
  workspace: FrpWorkspace;
  /** The page's single ring buffer; the tab must not create a second one. */
  store: FrpLogStore;
  /** Preselected server, e.g. arriving from a profile's detail drawer. */
  initialProfileId?: string | null;
};

/**
 * The logs tab: filter the shared buffer by server, severity and keyword;
 * pause the view without dropping incoming lines; clear the in-memory buffer
 * or open the on-disk folder.
 */
export function LogsTab({ workspace, store, initialProfileId }: LogsTabProps) {
  const { t } = useAppTranslation();

  const liveLogs = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);

  const [profileId, setProfileId] = useState<string>(initialProfileId ?? ALL_PROFILES);
  const [level, setLevel] = useState<string>("all");
  const [keyword, setKeyword] = useState("");
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<LogEntry[] | null>(null);
  const [followTail, setFollowTail] = useState(true);
  const [logDir, setLogDir] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  const [openingDir, setOpeningDir] = useState(false);

  useEffect(() => {
    if (initialProfileId) setProfileId(initialProfileId);
  }, [initialProfileId]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const recent = await frpLogsRecent(null, RECENT_LIMIT);
        if (!cancelled) mergeRecent(store, recent);
      } catch {
        // Live events still fill the buffer; a failed backfill is not fatal.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [store]);

  const profileNames = useMemo(() => {
    const names: Record<string, string> = {};
    for (const profile of workspace.profiles) names[profile.id] = profile.name;
    return names;
  }, [workspace.profiles]);

  const minimumLevel = useMemo(
    () => LEVEL_OPTIONS.find((option) => option.value === level)?.minimum ?? null,
    [level]
  );

  const source = paused && frozen ? frozen : liveLogs;

  const filtered = useMemo(() => {
    const base = filterLogs(source, {
      profileId: profileId === ALL_PROFILES ? null : profileId,
      minimumLevel,
      keyword: "",
    });

    const term = keyword.trim().toLowerCase();
    if (!term) return base;
    return base.filter((entry) => {
      if (entry.message.toLowerCase().includes(term)) return true;
      if ((profileNames[entry.profileId] ?? "").toLowerCase().includes(term)) return true;
      return t(`frp.logs.level.${entry.level}`).toLowerCase().includes(term);
    });
  }, [source, profileId, minimumLevel, keyword, profileNames, t]);

  const levelLabel = useCallback(
    (option: LevelOption) =>
      option.minimum === null
        ? t("frp.logs.filter.all")
        : `${t(`frp.logs.level.${option.value}`)}+`,
    [t]
  );

  const togglePause = () => {
    if (paused) {
      setPaused(false);
      setFrozen(null);
      return;
    }
    // Freeze what is on screen; the store keeps receiving in the background.
    setFrozen(liveLogs);
    setPaused(true);
    setFollowTail(false);
  };

  const clearLogs = async () => {
    const target = profileId === ALL_PROFILES ? null : profileId;
    setClearing(true);
    try {
      await workspace.runAction(() => frpLogsClear(target));
      store.clear(target);
      if (paused) setFrozen(store.snapshot());
    } catch {
      // `runAction` already wrote the failure to the page-level banner.
    } finally {
      setClearing(false);
    }
  };

  const openLogDir = async () => {
    setOpeningDir(true);
    try {
      let dir = logDir;
      if (!dir) {
        const view = await frpProfilesList();
        dir = view.logDir;
        setLogDir(dir);
      }
      await openPath(dir);
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure);
      toast.error(`${t("frp.logs.openDirFailed")}: ${message}`);
    } finally {
      setOpeningDir(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={profileId} onValueChange={setProfileId}>
          <SelectTrigger size="sm" className="w-[11rem]" aria-label={t("frp.logs.filter.server")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_PROFILES}>{t("frp.logs.filter.all")}</SelectItem>
            {workspace.profiles.map((profile) => (
              <SelectItem key={profile.id} value={profile.id}>
                {profile.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={level} onValueChange={setLevel}>
          <SelectTrigger size="sm" className="w-[8rem]" aria-label={t("frp.logs.filter.level")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {levelLabel(option)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder={t("frp.logs.search.placeholder")}
          aria-label={t("frp.logs.search.placeholder")}
          className="h-8 min-w-[12rem] flex-1"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={paused ? "default" : "outline"}
          onClick={togglePause}
          aria-pressed={paused}
        >
          {paused ? <Play /> : <Pause />}
          {paused ? t("frp.logs.resume") : t("frp.logs.pause")}
        </Button>

        <div className="flex items-center gap-2">
          <Switch
            id="frp-log-follow"
            checked={followTail}
            disabled={paused}
            onCheckedChange={setFollowTail}
          />
          <Label htmlFor="frp-log-follow" className="text-muted-foreground text-xs">
            {t("frp.logs.autoScroll")}
          </Label>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={clearing || source.length === 0}
            onClick={() => void clearLogs()}
          >
            {clearing ? <Loader2 className="animate-spin" /> : <Trash2 />}
            {t("frp.logs.clear")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={openingDir}
            onClick={() => void openLogDir()}
          >
            {openingDir ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {t("frp.logs.openDir")}
          </Button>
        </div>
      </div>

      {source.length === 0 ? (
        <div
          className={`border-border text-muted-foreground flex items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm ${LIST_HEIGHT_CLASS}`}
        >
          {t("frp.logs.empty")}
        </div>
      ) : filtered.length === 0 ? (
        <div
          className={`border-border text-muted-foreground flex items-center justify-center rounded-lg border border-dashed p-8 text-center text-sm ${LIST_HEIGHT_CLASS}`}
        >
          {t("frp.logs.noMatch")}
        </div>
      ) : (
        <VirtualLogList
          entries={filtered}
          profileNames={profileNames}
          followTail={followTail && !paused}
          onFollowTailChange={(next) => {
            if (!paused) setFollowTail(next);
          }}
          className={LIST_HEIGHT_CLASS}
        />
      )}
    </div>
  );
}
