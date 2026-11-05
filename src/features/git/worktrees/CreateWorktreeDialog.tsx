import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check, FolderOpen, FolderTree, Loader2 } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { cn } from "@/lib/utils";
import { parentDirectory, suggestWorktreePath } from "@/lib/git-core/worktree";
import { worktreeAdd } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useUi, type CreateWorktreePreset } from "@/features/git/ui-store";
import { basename } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";

type Mode = "existing" | "new";

function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      className="border-border focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-[3px]"
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

export function CreateWorktreeDialog() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const branches = useRepo((s) => s.branches);
  const worktrees = useRepo((s) => s.worktrees);
  const refresh = useRepo((s) => s.refresh);
  const dialog = useUi((s) => s.dialog);
  const rawContext = useUi((s) => s.dialogContext);
  const closeDialog = useUi((s) => s.closeDialog);

  const open = dialog === "createWorktree";
  const preset =
    rawContext &&
    typeof rawContext === "object" &&
    !("oids" in rawContext) &&
    !("baseOid" in rawContext)
      ? (rawContext as CreateWorktreePreset)
      : null;

  const path = repo?.path ?? "";
  const mainPath = repo?.mainPath ?? repo?.path ?? "";
  const repoName = basename(mainPath) || "worktree";
  const defaultParent = parentDirectory(mainPath);

  const [mode, setMode] = useState<Mode>("new");
  const [existingBranch, setExistingBranch] = useState("");
  const [newBranch, setNewBranch] = useState("");
  const [directory, setDirectory] = useState("");
  const [openAfter, setOpenAfter] = useState(true);
  const [busy, setBusy] = useState(false);
  const directoryTouched = useRef(false);

  const heldBranches = useMemo(() => {
    const held = new Map<string, string>();
    for (const worktree of worktrees) {
      if (worktree.branch) held.set(worktree.branch, worktree.name);
    }
    return held;
  }, [worktrees]);

  const availableBranches = useMemo(() => {
    const localNames = new Set(branches.filter((b) => !b.isRemote).map((b) => b.name));
    const locals = branches.filter((b) => !b.isRemote && !heldBranches.has(b.name) && !b.isHead);
    const remotes = branches.filter((b) => {
      if (!b.isRemote) return false;
      const local = b.name.split("/").slice(1).join("/");
      return !localNames.has(local) && !heldBranches.has(local);
    });
    return { locals, remotes };
  }, [branches, heldBranches]);

  const baseOid = preset?.oid ?? null;
  const baseLabel = baseOid
    ? baseOid.slice(0, 8)
    : (repo?.headBranch ?? t("gitRepo.sidebar.worktree.currentHead"));

  useEffect(() => {
    if (!open) return;
    directoryTouched.current = false;
    setBusy(false);
    setOpenAfter(true);
    setNewBranch("");
    if (preset?.branch) {
      setMode("existing");
      setExistingBranch(preset.branch);
    } else {
      setMode("new");
      setExistingBranch("");
    }
  }, [open, preset?.branch, preset?.oid]);

  const branch = mode === "existing" ? existingBranch : newBranch.trim();
  const effectiveBranch =
    mode === "existing" && branch.includes("/") ? branch.split("/").slice(1).join("/") : branch;

  useEffect(() => {
    if (!open || directoryTouched.current) return;
    setDirectory(suggestWorktreePath(defaultParent, repoName, effectiveBranch || "new"));
  }, [open, defaultParent, repoName, effectiveBranch]);

  const canSubmit = !busy && branch.length > 0 && directory.trim().length > 0;

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      const created = await worktreeAdd(path, {
        directory: directory.trim(),
        branch,
        createBranch: mode === "new",
        base: mode === "new" ? baseOid : null,
      });
      toast.success(t("gitRepo.sidebar.worktree.ready", { name: basename(created) }), {
        description: t("gitRepo.sidebar.worktree.readyDescription"),
      });
      closeDialog();
      if (openAfter) await useRepo.getState().open(created);
      else await refresh();
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.worktree.failed", {
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function browse() {
    const dir = await pickDirectory({ directory: true });
    if (typeof dir !== "string") return;
    directoryTouched.current = true;
    setDirectory(suggestWorktreePath(dir, repoName, effectiveBranch || "new"));
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="text-primary size-4" />
            {t("gitRepo.sidebar.worktree.title")}
          </DialogTitle>
          <DialogDescription>{t("gitRepo.sidebar.worktree.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Tabs value={mode} onValueChange={(value) => setMode(value as Mode)}>
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="new">{t("gitRepo.sidebar.worktree.modeNew")}</TabsTrigger>
              <TabsTrigger value="existing">
                {t("gitRepo.sidebar.worktree.modeExisting")}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {mode === "new" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="worktree-new-branch" className="text-muted-foreground text-xs">
                {t("gitRepo.sidebar.worktree.branchLabel")}
              </Label>
              <Input
                id="worktree-new-branch"
                autoFocus
                value={newBranch}
                onChange={(event) => setNewBranch(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submit()}
                placeholder={t("gitRepo.sidebar.worktree.branchPlaceholder")}
                className="font-mono"
              />
              <p className="text-muted-foreground/70 text-[11px] [overflow-wrap:anywhere]">
                {t("gitRepo.sidebar.worktree.startsFrom", { base: baseLabel })}
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1.5">
              <Label className="text-muted-foreground text-xs">
                {t("gitRepo.sidebar.worktree.branchSelectLabel")}
              </Label>
              <Select value={existingBranch} onValueChange={setExistingBranch}>
                <SelectTrigger className="h-9 font-mono">
                  <SelectValue placeholder={t("gitRepo.sidebar.worktree.chooseBranch")} />
                </SelectTrigger>
                <SelectContent>
                  {availableBranches.locals.length === 0 &&
                    availableBranches.remotes.length === 0 && (
                      <div className="text-muted-foreground px-2 py-1.5 text-xs">
                        {t("gitRepo.sidebar.worktree.allCheckedOut")}
                      </div>
                    )}
                  {availableBranches.locals.map((item) => (
                    <SelectItem key={item.name} value={item.name} className="font-mono">
                      {item.name}
                    </SelectItem>
                  ))}
                  {availableBranches.remotes.map((item) => (
                    <SelectItem key={item.name} value={item.name} className="font-mono">
                      {item.name}
                      <span className="text-muted-foreground/70 ml-2 text-[10px]">
                        {t("gitRepo.sidebar.worktree.remoteTag")}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-muted-foreground/70 text-[11px]">
                {t("gitRepo.sidebar.worktree.heldHint")}
              </p>
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="worktree-directory" className="text-muted-foreground text-xs">
              {t("gitRepo.sidebar.worktree.folderLabel")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="worktree-directory"
                value={directory}
                onChange={(event) => {
                  directoryTouched.current = true;
                  setDirectory(event.target.value);
                }}
                onKeyDown={(event) => event.key === "Enter" && submit()}
                placeholder={t("gitRepo.sidebar.worktree.folderPlaceholder")}
                className="font-mono"
              />
              <Button
                type="button"
                variant="secondary"
                size="icon"
                aria-label={t("gitRepo.sidebar.worktree.browse")}
                onClick={browse}
              >
                <FolderOpen />
              </Button>
            </div>
            <p className="text-muted-foreground/70 text-[11px]">
              {t("gitRepo.sidebar.worktree.folderHint")}
            </p>
          </div>

          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={openAfter} onCheckedChange={setOpenAfter} />
            {t("gitRepo.sidebar.worktree.openAfter")}
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={closeDialog}>
            {t("gitRepo.sidebar.worktree.cancel")}
          </Button>
          <Button disabled={!canSubmit} className={cn(busy && "gap-2")} onClick={submit}>
            {busy ? <Loader2 className="animate-spin" /> : null}
            {t("gitRepo.sidebar.worktree.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
