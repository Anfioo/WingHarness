import { useEffect, useRef, useState } from "react";
import { FolderOpen, FolderTree, Loader2 } from "lucide-react";
import { toast } from "sonner";
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
import { worktreeAdd } from "@/commands";
import { basename } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { parentDirectory, suggestWorktreePath } from "@/lib/git-core/worktree";
import type { BranchInfo } from "@/lib/git-core";
import { refreshGitViews } from "../actions";

/** Creates a worktree for the branch the menu was opened on. */
export function WorktreeDialog({
  repo,
  branch,
  onClose,
}: {
  repo: string | null;
  branch: BranchInfo | null;
  onClose: () => void;
}) {
  if (!repo || !branch) return null;
  return (
    <WorktreeDialogBody
      key={`${repo}:${branch.name}`}
      repo={repo}
      branch={branch}
      onClose={onClose}
    />
  );
}

function WorktreeDialogBody({
  repo,
  branch,
  onClose,
}: {
  repo: string;
  branch: BranchInfo;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  // A remote branch is checked out locally under its own name without the remote prefix.
  const localName = branch.isRemote ? branch.name.split("/").slice(1).join("/") : branch.name;
  const [directory, setDirectory] = useState(() =>
    suggestWorktreePath(parentDirectory(repo), basename(repo), localName)
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const touched = useRef(false);

  useEffect(() => {
    if (touched.current) return;
    setDirectory(suggestWorktreePath(parentDirectory(repo), basename(repo), localName));
  }, [repo, localName]);

  const browse = async () => {
    const picked = await pickDirectory({ directory: true });
    if (typeof picked !== "string") return;
    touched.current = true;
    setDirectory(suggestWorktreePath(picked, basename(repo), localName));
  };

  const create = async () => {
    if (busy || directory.trim().length === 0) return;
    setBusy(true);
    setError(null);
    try {
      await worktreeAdd(repo, {
        directory: directory.trim(),
        branch: localName,
        createBranch: branch.isRemote,
        base: branch.isRemote ? branch.targetOid : null,
      });
      toast.success(t("gitRepo.sidebar.worktree.ready", { name: basename(directory.trim()) }), {
        description: t("gitRepo.sidebar.worktree.readyDescription"),
      });
      await refreshGitViews();
      onClose();
    } catch (cause) {
      setError(
        t("projectGit.dialog.worktreeFailed", {
          error: cause instanceof Error ? cause.message : String(cause),
        })
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderTree className="text-primary size-4" />
            {t("gitRepo.sidebar.worktree.title")}
          </DialogTitle>
          <DialogDescription>
            {t("gitRepo.sidebar.worktree.startsFrom", { base: branch.name })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-worktree-directory" className="text-muted-foreground text-xs">
            {t("projectGit.dialog.worktreeFolder")}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="project-worktree-directory"
              autoFocus
              value={directory}
              onChange={(event) => {
                touched.current = true;
                setDirectory(event.target.value);
              }}
              onKeyDown={(event) => event.key === "Enter" && void create()}
              className="font-mono"
            />
            <Button
              type="button"
              variant="secondary"
              size="icon"
              aria-label={t("projectGit.dialog.worktreeBrowse")}
              onClick={() => void browse()}
            >
              <FolderOpen />
            </Button>
          </div>
          <p className="text-muted-foreground/70 text-[11px]">
            {t("projectGit.dialog.worktreeFolderHint")}
          </p>
          {error && (
            <p className="text-destructive text-[11px] [overflow-wrap:anywhere]">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("projectGit.dialog.cancel")}
          </Button>
          <Button onClick={() => void create()} disabled={busy || directory.trim().length === 0}>
            {busy && <Loader2 className="animate-spin" />}
            {t("projectGit.dialog.worktreeCreate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
