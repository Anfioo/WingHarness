import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitInfo } from "@/lib/git-core";

/** Picks the older commit a fixup or squash folds the selected commit into. */
export function FixupSquashDialog({
  source,
  mode,
  candidates,
  onPick,
  onClose,
}: {
  source: CommitInfo | null;
  mode: "fixup" | "squash";
  candidates: readonly CommitInfo[];
  onPick: (target: CommitInfo) => void;
  onClose: () => void;
}) {
  const { t } = useAppTranslation();
  if (!source) return null;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(`projectGit.dialog.${mode}.title`, { summary: source.summary })}
          </DialogTitle>
          <DialogDescription>{t(`projectGit.dialog.${mode}.description`)}</DialogDescription>
        </DialogHeader>
        {candidates.length === 0 ? (
          <p className="text-muted-foreground px-1 py-4 text-xs">
            {t(`projectGit.dialog.${mode}.empty`)}
          </p>
        ) : (
          <div className="flex max-h-[50vh] flex-col overflow-y-auto">
            {candidates.map((commit) => (
              <button
                key={commit.oid}
                type="button"
                onClick={() => {
                  onClose();
                  onPick(commit);
                }}
                className="hover:bg-muted flex h-8 items-center gap-2 rounded px-2 text-left text-xs transition-colors"
              >
                <code className="text-faint shrink-0 font-mono text-[10px]">{commit.shortOid}</code>
                <span className="min-w-0 flex-1 truncate" title={commit.summary}>
                  {commit.summary}
                </span>
                <span className="text-faint shrink-0 text-[10px]">{commit.author.name}</span>
              </button>
            ))}
          </div>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t(`projectGit.dialog.${mode}.cancel`)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
