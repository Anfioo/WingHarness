import { useEffect, useState } from "react";
import { Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { scoopSearch, type ScoopSearchHit } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ScoopPageController } from "@/hooks/use-scoop-page";

/**
 * Local search over the manifests of the cloned buckets, plus two ways to run
 * Scoop: install the typed name, or search every remote bucket with `scoop
 * search`. Both accept `7zip` and `scoop install 7zip`.
 */
export function ScoopSearchPanel({ page }: { page: ScoopPageController }) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<ScoopSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = page.running !== null || page.preparing;

  useEffect(() => {
    const text = query.trim();
    if (!text) {
      setHits([]);
      setError(null);
      setSearching(false);
      return;
    }

    let alive = true;
    const timer = setTimeout(() => {
      setSearching(true);
      void scoopSearch(text)
        .then(
          (next) => {
            if (alive) {
              setHits(next);
              setError(null);
            }
          },
          (reason: unknown) => {
            if (alive) {
              setHits([]);
              setError(reason instanceof Error ? reason.message : String(reason));
            }
          }
        )
        .finally(() => {
          if (alive) setSearching(false);
        });
    }, 300);

    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [query]);

  const spec = query.trim();

  return (
    <div className="space-y-4">
      <section className="border-border space-y-3 rounded-xl border p-4">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-56 flex-1">
            <Search className="text-muted-foreground pointer-events-none absolute start-2.5 top-1/2 size-4 -translate-y-1/2" />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("scoop.search.placeholder")}
              spellCheck={false}
              className="ps-8 font-mono text-xs"
            />
          </div>
          <Button disabled={busy || !spec} onClick={() => void page.installApp(spec)}>
            {t("scoop.search.install")}
          </Button>
          <Button
            variant="secondary"
            disabled={busy || !spec}
            onClick={() => void page.searchOnline(spec)}
          >
            {t("scoop.search.online")}
          </Button>
        </div>
        <p className="text-muted-foreground text-xs">{t("scoop.search.hint")}</p>
      </section>

      <section className="border-border rounded-xl border">
        <header className="border-border flex items-center justify-between gap-2 border-b px-4 py-2">
          <h2 className="text-sm font-semibold">{t("scoop.search.localTitle")}</h2>
          {searching && (
            <span className="text-muted-foreground text-xs">{t("scoop.search.searching")}</span>
          )}
        </header>

        {error ? (
          <p className="text-destructive px-4 py-3 text-xs">{error}</p>
        ) : hits.length === 0 ? (
          <p className="text-muted-foreground px-4 py-3 text-xs">
            {spec ? t("scoop.search.empty") : t("scoop.search.idle")}
          </p>
        ) : (
          <ul className="divide-border divide-y">
            {hits.map((hit) => (
              <li key={`${hit.bucket}/${hit.name}`} className="flex items-start gap-3 px-4 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-sm font-medium">{hit.name}</span>
                    {hit.version && (
                      <span className="text-muted-foreground font-mono text-xs">{hit.version}</span>
                    )}
                    {hit.bucket && (
                      <Badge variant="secondary" className="text-[10px]">
                        {hit.bucket}
                      </Badge>
                    )}
                    {hit.installed && (
                      <Badge variant="outline" className="text-[10px]">
                        {t("scoop.search.installed")}
                      </Badge>
                    )}
                  </div>
                  {hit.description && (
                    <p className="text-muted-foreground mt-0.5 line-clamp-1 text-xs">
                      {hit.description}
                    </p>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={busy}
                  onClick={() => void page.installApp(hit.name)}
                >
                  {t("scoop.search.installOne")}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
