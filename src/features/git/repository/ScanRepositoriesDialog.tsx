import { useEffect, useMemo, useRef, useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import { toast } from "sonner";
import { Check, FolderGit2, FolderSearch, FolderTree, Loader2 } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { recentAddMany, repositoriesScan } from "@/commands";
import type { RepositoryScan, ScannedRepository } from "@/lib/git-core/types";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useUi, type DialogContext, type ScanRepositoriesPreset } from "@/features/git/ui-store";
import { useRepo } from "@/features/git/repository-store";
import { dirname, shortenHome } from "@/features/git/utils";

function scanPreset(context: DialogContext): ScanRepositoriesPreset | null {
  if (!context || typeof context === "string" || !("scanRoot" in context)) return null;
  return context as ScanRepositoriesPreset;
}

const normalized = (path: string) => path.replace(/\\/g, "/").replace(/\/+$/, "");

function relativeTo(root: string, path: string): string {
  const base = normalized(root);
  const target = normalized(path);
  if (target === base) return "";
  return target.startsWith(`${base}/`) ? target.slice(base.length + 1) : shortenHome(path);
}

export async function startRepositoryScan() {
  const dir = await pickDirectory({ directory: true });
  if (typeof dir === "string") {
    useUi.getState().openDialog("scanRepositories", { scanRoot: dir });
  }
}

function ScanCheckbox({
  checked,
  disabled,
  onToggle,
  ariaLabel,
}: {
  checked: boolean;
  disabled?: boolean;
  onToggle: () => void;
  ariaLabel: string;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      disabled={disabled}
      onCheckedChange={() => onToggle()}
      aria-label={ariaLabel}
      className="border-input bg-background focus-visible:ring-ring data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-[4px] border outline-none focus-visible:ring-2 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

function ScanEmpty({ title, description }: { title: string; description: string }) {
  return (
    <div className="border-border bg-muted/40 flex flex-col items-start gap-2 rounded-lg border border-dashed p-4">
      <span className="bg-primary/15 text-primary flex size-9 items-center justify-center rounded-md">
        <FolderGit2 className="size-4" />
      </span>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-muted-foreground text-xs">{description}</span>
    </div>
  );
}

function ScanDirName({ path, className }: { path: string; className?: string }) {
  const dir = dirname(path);
  if (!dir) return null;
  return (
    <span
      dir="rtl"
      className={cn("text-muted-foreground/70 min-w-0 flex-1 truncate text-left", className)}
    >
      <bdi>{dir}</bdi>
    </span>
  );
}

export function ScanRepositoriesDialog() {
  const { t } = useAppTranslation();
  const dialog = useUi((state) => state.dialog);
  const dialogContext = useUi((state) => state.dialogContext);
  const closeDialog = useUi((state) => state.closeDialog);
  const recents = useRepo((state) => state.recents);
  const loadRecents = useRepo((state) => state.loadRecents);
  const open = dialog === "scanRepositories";
  const [root, setRoot] = useState("");
  const [scan, setScan] = useState<RepositoryScan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [adding, setAdding] = useState(false);
  const seq = useRef(0);

  const known = useMemo(() => new Set(recents.map((repo) => normalized(repo.path))), [recents]);
  const isKnown = (repo: ScannedRepository) => known.has(normalized(repo.path));

  useEffect(() => {
    if (!open) {
      seq.current++;
      setRoot("");
      setScan(null);
      setError(null);
      setSelected(new Set());
      setAdding(false);
      return;
    }
    const preset = scanPreset(dialogContext);
    if (preset) setRoot(preset.scanRoot);
  }, [open, dialogContext]);

  useEffect(() => {
    if (!open || !root) return;
    const token = ++seq.current;
    setScan(null);
    setError(null);
    void repositoriesScan(root)
      .then((result) => {
        if (token !== seq.current) return;
        const current = new Set(useRepo.getState().recents.map((repo) => normalized(repo.path)));
        setScan(result);
        setSelected(
          new Set(
            result.repositories
              .filter((repo) => !current.has(normalized(repo.path)))
              .map((repo) => repo.path)
          )
        );
      })
      .catch((reason) => {
        if (token !== seq.current) return;
        setError((reason as { message?: string })?.message ?? String(reason));
      });
  }, [open, root]);

  const found = scan?.repositories ?? [];
  const fresh = found.filter((repo) => !isKnown(repo));
  const allPicked = fresh.length > 0 && fresh.every((repo) => selected.has(repo.path));

  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const changeRoot = async () => {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir === "string") setRoot(dir);
  };

  const add = async () => {
    const paths = found
      .filter((repo) => selected.has(repo.path) && !isKnown(repo))
      .map((repo) => repo.path);
    if (paths.length === 0 || adding) return;
    setAdding(true);
    try {
      await recentAddMany(paths);
      await loadRecents();
      toast.success(t("gitRepo.remote.scan.added", { count: paths.length }));
      closeDialog();
    } catch (reason) {
      toast.error(
        t("gitRepo.remote.scan.addFailed", {
          error: (reason as { message?: string })?.message ?? String(reason),
        })
      );
      setAdding(false);
    }
  };

  const pickedCount = fresh.filter((repo) => selected.has(repo.path)).length;
  const alreadyCount = found.length - fresh.length;

  return (
    <Dialog open={open} onOpenChange={(value) => !value && closeDialog()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.remote.scan.title")}</DialogTitle>
          <DialogDescription>{t("gitRepo.remote.scan.description")}</DialogDescription>
        </DialogHeader>

        <div className="border-border bg-muted/50 flex items-center gap-2 rounded-md border px-3 py-2">
          <FolderSearch className="text-muted-foreground size-4 shrink-0" />
          <span
            className="text-foreground min-w-0 flex-1 truncate font-mono text-xs"
            title={root}
            data-scan-root
          >
            {shortenHome(root)}
          </span>
          <Button variant="secondary" size="sm" onClick={() => void changeRoot()} disabled={adding}>
            {t("gitRepo.remote.scan.change")}
          </Button>
        </div>

        {error ? (
          <p className="text-destructive text-sm [overflow-wrap:anywhere]">{error}</p>
        ) : !scan ? (
          <div
            className="text-muted-foreground flex items-center gap-2 py-6 text-sm"
            data-scan-busy
          >
            <Loader2 className="text-primary size-4 animate-spin" />
            {t("gitRepo.remote.scan.scanning")}
          </div>
        ) : found.length === 0 ? (
          <ScanEmpty
            title={t("gitRepo.remote.scan.empty.title")}
            description={t("gitRepo.remote.scan.empty.description")}
          />
        ) : (
          <div className="flex flex-col gap-2">
            <div className="text-muted-foreground flex items-center gap-2 text-xs">
              <span data-scan-summary>
                {t("gitRepo.remote.scan.found", { count: found.length })}
                {scan.truncated ? "+" : ""}
                {alreadyCount > 0 &&
                  ` · ${t("gitRepo.remote.scan.alreadyInRecents", { count: alreadyCount })}`}
              </span>
              {fresh.length > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto h-6 px-2 text-xs"
                  onClick={() =>
                    setSelected(allPicked ? new Set() : new Set(fresh.map((repo) => repo.path)))
                  }
                >
                  {allPicked
                    ? t("gitRepo.remote.scan.selectNone")
                    : t("gitRepo.remote.scan.selectAll")}
                </Button>
              )}
            </div>
            <div
              className="border-border max-h-80 overflow-y-auto rounded-md border p-1"
              data-scan-results
            >
              {found.map((repo) => {
                const already = isKnown(repo);
                const rel = relativeTo(root, repo.path);
                return (
                  <label
                    key={repo.path}
                    className={cn(
                      "flex items-center gap-3 rounded px-2 py-1.5",
                      already ? "cursor-default opacity-60" : "hover:bg-muted cursor-pointer"
                    )}
                    title={repo.path}
                  >
                    <ScanCheckbox
                      checked={already || selected.has(repo.path)}
                      disabled={already}
                      onToggle={() => toggle(repo.path)}
                      ariaLabel={t("gitRepo.remote.scan.addLabel", { repo: repo.name })}
                    />
                    <span className="bg-primary/10 text-primary flex size-6 shrink-0 items-center justify-center rounded">
                      {repo.isWorktree ? (
                        <FolderTree className="size-3.5" />
                      ) : (
                        <FolderGit2 className="size-3.5" />
                      )}
                    </span>
                    <span className="text-foreground max-w-full shrink-0 truncate text-sm font-medium">
                      {repo.name}
                    </span>
                    <ScanDirName path={rel} className="font-mono text-[11px]" />
                    {already && (
                      <Badge className="ml-auto shrink-0">
                        {t("gitRepo.remote.scan.inRecents")}
                      </Badge>
                    )}
                  </label>
                );
              })}
            </div>
            {scan.truncated && (
              <p className="text-muted-foreground text-xs">
                {t("gitRepo.remote.scan.truncated", { count: found.length })}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>
            {t("gitRepo.remote.scan.cancel")}
          </Button>
          <Button autoFocus onClick={() => void add()} disabled={pickedCount === 0 || adding}>
            {adding ? <Loader2 className="animate-spin" /> : null}
            {t("gitRepo.remote.scan.add", { count: pickedCount })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
