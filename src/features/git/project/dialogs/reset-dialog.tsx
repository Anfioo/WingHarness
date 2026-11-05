import { RotateCcw } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { resetTo } from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitInfo } from "@/lib/git-core";
import { runGitAction, useGitActions } from "../actions";

type ResetMode = "soft" | "mixed" | "hard";

const MODES: ResetMode[] = ["soft", "mixed", "hard"];

/** Picks how much of the working copy a reset to the selected commit keeps. */
export function ResetDialog({
  repo,
  commit,
  onClose,
}: {
  repo: string | null;
  commit: CommitInfo | null;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  const busy = useGitActions((state) => state.busy);
  if (!repo || !commit) return null;

  const run = (mode: ResetMode) => {
    onClose();
    void runGitAction({
      id: `reset.${mode}`,
      label: t("projectGit.menu.commit.resetTo"),
      success: t("projectGit.toast.reset", { oid: commit.shortOid }),
      run: () => resetTo(repo, commit.oid, mode),
    });
  };

  const choose = async (mode: ResetMode) => {
    if (mode === "hard") {
      const confirmed = await confirmDialog({
        title: t("gitRepo.graph.commitMenu.hardResetConfirm.title", { oid: commit.shortOid }),
        description: t("gitRepo.graph.commitMenu.hardResetConfirm.description"),
        confirmLabel: t("gitRepo.graph.commitMenu.hardResetConfirm.confirm"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    run(mode);
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RotateCcw className="text-primary size-4" />
            {t("projectGit.dialog.reset.title", { oid: commit.shortOid })}
          </DialogTitle>
          <DialogDescription>{t("projectGit.dialog.reset.description")}</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-1">
          {MODES.map((mode) => (
            <button
              key={mode}
              type="button"
              disabled={busy !== null}
              onClick={() => void choose(mode)}
              className="hover:bg-muted flex flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors disabled:opacity-50"
            >
              <span className="text-xs font-medium">{t(`projectGit.dialog.reset.${mode}`)}</span>
              <span className="text-muted-foreground text-[11px]">
                {t(`projectGit.dialog.reset.${mode}Hint`)}
              </span>
            </button>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy !== null}>
            {t("projectGit.dialog.reset.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
