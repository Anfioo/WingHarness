import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";
import type { ScoopCache } from "@/commands";
import { scoopCacheClear, scoopCacheEntries } from "@/commands";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes, messageOf } from "@/lib/scoop/diagnostics";

/**
 * The downloads Scoop kept in `<scoop>\cache`.
 *
 * The list is read from the folder, not from `scoop cache show`: the file name
 * carries the app and the version, and the page deletes the files itself so it
 * can leave alone the ones a rollback would need.
 */
export function ScoopCacheManager({ reloadKey }: { reloadKey: number }) {
  const { t } = useAppTranslation();
  const [cache, setCache] = useState<ScoopCache | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCache(await scoopCacheEntries());
      setError(null);
    } catch (failure) {
      setError(messageOf(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load, reloadKey]);

  const clear = useCallback(
    async (files: string[] | null) => {
      setBusy(true);
      try {
        const result = await scoopCacheClear(files);
        // A refused or failed file is the only part of the result the list
        // cannot show by itself, so it is reported above the rows.
        setError(
          result.failed.length > 0
            ? t("scoop.diagnostics.cache.failed", { count: result.failed.length })
            : null
        );
        await load();
      } catch (failure) {
        setError(messageOf(failure));
      } finally {
        setBusy(false);
      }
    },
    [load, t]
  );

  const entries = useMemo(() => {
    const rows = cache?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((entry) => `${entry.name}#${entry.version}`.toLowerCase().includes(needle));
  }, [cache, filter]);

  return (
    <section className="border-border flex min-h-0 flex-col gap-3 rounded-xl border p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{t("scoop.diagnostics.cache.title")}</h2>
          <p className="text-muted-foreground mt-1 text-xs">
            {t("scoop.diagnostics.cache.hint", { size: formatBytes(cache?.total ?? 0) })}
          </p>
        </div>
        <Button
          variant="outline"
          size="sm"
          disabled={busy || (cache?.entries.length ?? 0) === 0}
          onClick={() => void clear(null)}
        >
          {busy ? <Loader2 className="animate-spin" /> : <Trash2 />}
          {t("scoop.diagnostics.cache.clearAll")}
        </Button>
      </div>

      {error && <p className="text-destructive text-xs">{error}</p>}

      <Input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder={t("scoop.diagnostics.cache.filter")}
        className="h-8"
      />

      <div className="border-border max-h-72 min-h-0 overflow-auto rounded-lg border">
        {entries.length === 0 ? (
          <p className="text-muted-foreground px-3 py-6 text-center text-xs">
            {cache?.entries.length
              ? t("scoop.diagnostics.cache.noMatches")
              : t("scoop.diagnostics.cache.empty")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {entries.map((entry) => (
              <li key={entry.fileName} className="flex items-center gap-2 px-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm">{entry.name}</p>
                  <p className="text-muted-foreground truncate font-mono text-xs">
                    {entry.version}
                  </p>
                </div>
                <span className="text-muted-foreground shrink-0 font-mono text-xs">
                  {formatBytes(entry.length)}
                </span>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  disabled={busy || entry.versioned}
                  title={
                    entry.versioned
                      ? t("scoop.diagnostics.cache.versionedTitle", { app: entry.name })
                      : t("scoop.diagnostics.cache.deleteTitle", { file: entry.fileName })
                  }
                  aria-label={t("scoop.diagnostics.cache.delete")}
                  onClick={() => void clear([entry.fileName])}
                >
                  <Trash2 />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
