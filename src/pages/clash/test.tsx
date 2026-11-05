import { useCallback, useEffect, useRef, useState } from "react";
import {
  CheckCircle2,
  Globe,
  Loader2,
  Pencil,
  Plus,
  RotateCw,
  Trash2,
  XCircle,
} from "lucide-react";
import { toast } from "sonner";
import {
  clashTestList,
  clashTestSave,
  clashTestUrl,
  type ClashTestResult,
  type ClashTestSite,
} from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { Empty, IconButton } from "./shared";

type Outcome =
  | { kind: "testing" }
  | { kind: "ok"; result: ClashTestResult }
  | { kind: "failed"; message: string };

type Draft = { id: string | null; name: string; url: string };

/** The host a link points at; the whole URL when it is not a URL at all. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function newId(): string {
  return `site-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** A slow answer is still an answer; only the unreachable ones are failures. */
function delayTone(delay: number): string {
  if (delay < 500) return "text-emerald-600 dark:text-emerald-400";
  if (delay < 1000) return "text-amber-600 dark:text-amber-400";
  return "text-red-600 dark:text-red-400";
}

export function TestTab({ running }: { running: boolean }) {
  const { t } = useAppTranslation();

  const [sites, setSites] = useState<ClashTestSite[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, Outcome>>({});
  const [testingAll, setTestingAll] = useState(false);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<ClashTestSite | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const next = await clashTestList();
      if (!mounted.current) return;
      setSites(next);
      setLoadError(null);
    } catch (error) {
      if (!mounted.current) return;
      setLoadError(String(error));
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const probe = useCallback(async (site: ClashTestSite) => {
    setResults((prev) => ({ ...prev, [site.id]: { kind: "testing" } }));
    try {
      const result = await clashTestUrl(site.url);
      if (!mounted.current) return;
      setResults((prev) => ({ ...prev, [site.id]: { kind: "ok", result } }));
    } catch (error) {
      if (!mounted.current) return;
      setResults((prev) => ({
        ...prev,
        [site.id]: { kind: "failed", message: String(error) },
      }));
    }
  }, []);

  // Every site is independent, so they all go at once; the core is the only
  // thing they share and it handles several small requests without trouble.
  const probeAll = useCallback(async () => {
    if (sites.length === 0) return;
    setTestingAll(true);
    try {
      await Promise.all(sites.map((site) => probe(site)));
    } finally {
      if (mounted.current) setTestingAll(false);
    }
  }, [probe, sites]);

  const submit = useCallback(async () => {
    if (!draft) return;
    const name = draft.name.trim();
    const url = draft.url.trim();
    if (!name || !url) return;
    const editingId = draft.id;
    const next: ClashTestSite[] = editingId
      ? sites.map((site) => (site.id === editingId ? { ...site, name, url } : site))
      : [...sites, { id: newId(), name, url }];

    setSaving(true);
    try {
      await clashTestSave(next);
      setSites(next);
      // A changed URL makes the old answer meaningless.
      if (editingId) {
        setResults((prev) => {
          const copy = { ...prev };
          delete copy[editingId];
          return copy;
        });
      }
      setDraft(null);
    } catch (error) {
      toast.error(String(error));
    } finally {
      setSaving(false);
    }
  }, [draft, sites]);

  const remove = useCallback(async () => {
    if (!pendingDelete) return;
    const next = sites.filter((site) => site.id !== pendingDelete.id);
    try {
      await clashTestSave(next);
      setSites(next);
      setResults((prev) => {
        const copy = { ...prev };
        delete copy[pendingDelete.id];
        return copy;
      });
      setPendingDelete(null);
      toast.success(t("clash.messages.deleted"));
    } catch (error) {
      toast.error(String(error));
    }
  }, [pendingDelete, sites, t]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b px-3 py-2">
        <div className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
          {running ? t("clash.tests.hint") : t("clash.tests.offline")}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={!running || testingAll || sites.length === 0}
          onClick={() => void probeAll()}
        >
          {testingAll ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RotateCw className="size-3.5" />
          )}
          {testingAll ? t("clash.tests.testing") : t("clash.tests.testAll")}
        </Button>
        <Button size="sm" onClick={() => setDraft({ id: null, name: "", url: "" })}>
          <Plus className="size-3.5" />
          {t("clash.tests.add")}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {loadError ? (
          <Empty icon={Globe} text={loadError} />
        ) : sites.length === 0 ? (
          <Empty icon={Globe} text={t("clash.tests.empty")} />
        ) : (
          <div className="grid grid-cols-[repeat(auto-fill,minmax(14.5rem,1fr))] gap-2 p-3">
            {sites.map((site) => (
              <SiteCard
                key={site.id}
                site={site}
                outcome={results[site.id]}
                running={running}
                onProbe={() => void probe(site)}
                onEdit={() => setDraft({ id: site.id, name: site.name, url: site.url })}
                onDelete={() => setPendingDelete(site)}
              />
            ))}
          </div>
        )}
      </div>

      <Dialog open={draft !== null} onOpenChange={(open) => !open && setDraft(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{draft?.id ? t("clash.tests.edit") : t("clash.tests.add")}</DialogTitle>
            <DialogDescription>{t("clash.tests.addHint")}</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-2">
            <Input
              autoFocus
              placeholder={t("clash.tests.namePlaceholder")}
              value={draft?.name ?? ""}
              onChange={(event) =>
                setDraft((prev) => prev && { ...prev, name: event.target.value })
              }
            />
            <Input
              placeholder="https://…"
              value={draft?.url ?? ""}
              onChange={(event) => setDraft((prev) => prev && { ...prev, url: event.target.value })}
              onKeyDown={(event) => event.key === "Enter" && void submit()}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDraft(null)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button
              onClick={() => void submit()}
              disabled={saving || !draft?.name.trim() || !draft?.url.trim()}
            >
              {saving && <Loader2 className="size-3.5 animate-spin" />}
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => !open && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("clash.actions.delete")}</DialogTitle>
            <DialogDescription>
              {t("clash.tests.confirmDelete", { name: pendingDelete?.name ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)}>
              {t("clash.prompts.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              {t("clash.prompts.confirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function SiteCard({
  site,
  outcome,
  running,
  onProbe,
  onEdit,
  onDelete,
}: {
  site: ClashTestSite;
  outcome: Outcome | undefined;
  running: boolean;
  onProbe: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useAppTranslation();
  const testing = outcome?.kind === "testing";
  const canProbe = running && !testing;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-disabled={!canProbe}
      onClick={() => canProbe && onProbe()}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        if (canProbe) onProbe();
      }}
      title={site.url}
      className={cn(
        "bg-card/40 flex flex-col gap-1.5 rounded-lg border px-3 py-2.5 transition-colors",
        canProbe ? "hover:border-primary/40 hover:bg-accent/40 cursor-pointer" : "cursor-default"
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded text-xs font-semibold uppercase">
          {site.name.slice(0, 1)}
        </span>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{site.name}</span>
        <span
          className="flex shrink-0 items-center gap-0.5"
          onClick={(event) => event.stopPropagation()}
        >
          <IconButton title={t("clash.tests.edit")} onClick={onEdit}>
            <Pencil className="size-3.5" />
          </IconButton>
          <IconButton title={t("clash.actions.delete")} onClick={onDelete}>
            <Trash2 className="size-3.5" />
          </IconButton>
        </span>
      </div>

      <div className="text-muted-foreground/70 truncate font-mono text-[11px]">
        {hostOf(site.url)}
      </div>

      <div className="flex min-h-5 items-center gap-1 text-xs">
        {testing ? (
          <>
            <Loader2 className="text-muted-foreground size-3.5 animate-spin" />
            <span className="text-muted-foreground">{t("clash.tests.testing")}</span>
          </>
        ) : outcome?.kind === "ok" ? (
          <>
            <CheckCircle2 className={cn("size-3.5", delayTone(outcome.result.delay))} />
            <span className={cn("font-mono tabular-nums", delayTone(outcome.result.delay))}>
              {outcome.result.delay} ms
            </span>
            <span className="text-muted-foreground/60 ml-auto shrink-0 font-mono text-[11px]">
              HTTP {outcome.result.status}
            </span>
          </>
        ) : outcome?.kind === "failed" ? (
          <>
            <XCircle className="text-destructive size-3.5 shrink-0" />
            <span className="text-destructive min-w-0 truncate" title={outcome.message}>
              {t("clash.tests.failed")}
            </span>
          </>
        ) : (
          <span className="text-muted-foreground/70">{t("clash.tests.untested")}</span>
        )}
      </div>
    </div>
  );
}
