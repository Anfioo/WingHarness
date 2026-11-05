import { useEffect, useMemo, useState } from "react";
import { Command } from "cmdk";
import { AlertTriangle, FolderGit2 } from "lucide-react";
import { toast } from "sonner";
import { pathsExist, type RecentRepository } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useUi } from "@/features/git/ui-store";
import { useRepo } from "@/features/git/repository-store";
import { shortenHome } from "@/features/git/utils";
import { activateTab } from "./tabs";

const MAX_RESULTS = 100;

function ranked(recents: readonly RecentRepository[], query: string): RecentRepository[] {
  const trimmed = query.trim().toLowerCase();
  if (!trimmed) return recents.slice(0, MAX_RESULTS);
  const matches = recents.filter(
    (repo) => repo.path.toLowerCase().includes(trimmed) || repo.name.toLowerCase().includes(trimmed)
  );
  const score = (repo: RecentRepository) => {
    const name = repo.name.toLowerCase();
    if (name === trimmed) return 0;
    if (name.startsWith(trimmed)) return 1;
    if (name.includes(trimmed)) return 2;
    return 3;
  };
  return [...matches].sort((a, b) => score(a) - score(b)).slice(0, MAX_RESULTS);
}

function parentOf(path: string): string {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return shortenHome(index > 0 ? path.slice(0, index) : path);
}

export function RepoQuickOpen() {
  const { t } = useAppTranslation();
  const open = useUi((state) => state.repoSwitcherOpen);
  const setOpen = useUi((state) => state.setRepoSwitcherOpen);
  const recents = useRepo((state) => state.recents);
  const current = useRepo((state) => state.repo?.path ?? null);
  const [search, setSearch] = useState("");
  const [missing, setMissing] = useState<Set<string>>(new Set());

  const results = useMemo(() => ranked(recents, search), [recents, search]);

  useEffect(() => {
    if (!open) return;
    setSearch("");
    void useRepo.getState().loadRecents();
  }, [open]);

  useEffect(() => {
    if (!open || results.length === 0) {
      setMissing(new Set());
      return;
    }
    let cancelled = false;
    void pathsExist(results.map((repo) => repo.path)).then((exists) => {
      if (cancelled) return;
      setMissing(new Set(results.filter((_, index) => !exists[index]).map((repo) => repo.path)));
    });
    return () => {
      cancelled = true;
    };
  }, [open, results]);

  const choose = (path: string) => {
    if (missing.has(path)) {
      toast.error(t("gitRepo.extras.quickOpen.missing"));
      return;
    }
    setOpen(false);
    if (path === current) return;
    activateTab(path);
  };

  const countLabel =
    results.length < recents.length && search.trim()
      ? t("gitRepo.extras.quickOpen.countFiltered", {
          shown: results.length,
          total: recents.length,
        })
      : t("gitRepo.extras.quickOpen.countTotal", { count: recents.length });

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label={t("gitRepo.extras.quickOpen.title")}
      shouldFilter={false}
      className="border-border bg-popover fixed top-24 left-1/2 z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-lg border shadow-sm"
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={t("gitRepo.extras.quickOpen.placeholder")}
        className="border-border placeholder:text-muted-foreground w-full border-b bg-transparent px-4 py-3 text-sm outline-none"
      />
      <Command.List className="max-h-96 overflow-y-auto p-1.5">
        <Command.Empty className="text-muted-foreground px-3 py-6 text-center text-sm">
          {recents.length === 0
            ? t("gitRepo.extras.quickOpen.empty")
            : t("gitRepo.extras.quickOpen.noMatch", { query: search.trim() })}
        </Command.Empty>
        {results.map((repo) => {
          const gone = missing.has(repo.path);
          const isCurrent = repo.path === current;
          return (
            <Command.Item
              key={repo.path}
              value={repo.path}
              onSelect={() => choose(repo.path)}
              className="data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground flex cursor-default items-center gap-3 rounded-md px-3 py-2 text-sm"
            >
              <span className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-md">
                {gone ? (
                  <AlertTriangle className="text-destructive size-4" />
                ) : (
                  <FolderGit2 className="size-4" />
                )}
              </span>
              <span className="min-w-0 flex-1">
                <span
                  className={
                    gone
                      ? "text-muted-foreground block truncate font-medium"
                      : "block truncate font-medium"
                  }
                >
                  {repo.name}
                </span>
                <span className="text-muted-foreground/70 block truncate font-mono text-[11px]">
                  {parentOf(repo.path)}
                </span>
              </span>
              {gone ? (
                <span className="text-destructive flex items-center gap-1 text-xs">
                  <AlertTriangle className="size-3.5" />
                  {t("gitRepo.extras.quickOpen.folderMissing")}
                </span>
              ) : (
                isCurrent && (
                  <span className="text-muted-foreground/70 text-xs">
                    {t("gitRepo.extras.quickOpen.current")}
                  </span>
                )
              )}
            </Command.Item>
          );
        })}
      </Command.List>
      <footer className="border-border text-muted-foreground/70 flex items-center justify-between gap-2 border-t px-3 py-2 text-[11px]">
        <span className="flex items-center gap-3">
          <span>{t("gitRepo.extras.quickOpen.hintMove")}</span>
          <span>{t("gitRepo.extras.quickOpen.hintOpen")}</span>
          <span>{t("gitRepo.extras.quickOpen.hintClose")}</span>
        </span>
        <span>{countLabel}</span>
      </footer>
    </Command.Dialog>
  );
}
