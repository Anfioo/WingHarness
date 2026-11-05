import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { create } from "zustand";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useRepo } from "@/features/git/repository-store";
import { basename, isMac } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import {
  chordFromEvent,
  chordId,
  chordLabels,
  chordProblem,
  chordText,
  parseChordId,
  repoShortcutsStore,
  type KeyChord,
} from "./use-repo-shortcuts";

interface RepoShortcutPreset {
  repoPath: string;
}

interface RepoShortcutDialogState {
  preset: RepoShortcutPreset | null;
  open: (preset: RepoShortcutPreset) => void;
  close: () => void;
}

const useRepoShortcutDialogState = create<RepoShortcutDialogState>((set) => ({
  preset: null,
  open: (preset) => set({ preset }),
  close: () => set({ preset: null }),
}));

export function openRepoShortcutDialog(repoPath: string): void {
  useRepoShortcutDialogState.getState().open({ repoPath });
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "border-border bg-muted text-muted-foreground inline-flex h-6 min-w-6 items-center justify-center rounded border px-1.5 font-mono text-[11px]",
        className
      )}
    >
      {children}
    </kbd>
  );
}

export function repoDisplayName(
  path: string,
  recents: Array<{ path: string; name: string }>
): string {
  return recents.find((repo) => repo.path === path)?.name ?? basename(path);
}

export function RepoShortcutDialog() {
  const { t } = useAppTranslation();
  const preset = useRepoShortcutDialogState((s) => s.preset);
  const closeDialog = useRepoShortcutDialogState((s) => s.close);
  const shortcuts = repoShortcutsStore((s) => s.repoShortcuts);
  const setRepoShortcut = repoShortcutsStore((s) => s.setRepoShortcut);
  const recents = useRepo((s) => s.recents);

  const open = preset !== null;
  const repoPath = preset?.repoPath ?? "";
  const name = repoPath ? repoDisplayName(repoPath, recents) : "";
  const current = shortcuts[repoPath] ?? null;
  const [draft, setDraft] = useState<KeyChord | null>(null);

  useEffect(() => {
    setDraft(current ? parseChordId(current) : null);
  }, [open, repoPath, current]);

  const draftId = draft ? chordId(draft) : null;
  const problem = draft ? chordProblem(draft, isMac) : null;
  const takenBy = draftId
    ? Object.entries(shortcuts).find(([path, id]) => path !== repoPath && id === draftId)?.[0]
    : undefined;
  const canSave = !!draftId && !problem && draftId !== current;
  const modifiers = t(
    isMac ? "gitRepo.extras.repoShortcut.modifierMac" : "gitRepo.extras.repoShortcut.modifierOther"
  );

  const save = () => {
    if (!draft || !draftId || !canSave) return;
    setRepoShortcut(repoPath, draftId);
    toast.success(t("gitRepo.extras.repoShortcut.saved", { chord: chordText(draft, isMac), name }));
    closeDialog();
  };

  const remove = () => {
    setRepoShortcut(repoPath, null);
    toast.success(t("gitRepo.extras.repoShortcut.removed", { name }));
    closeDialog();
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Tab") return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "Backspace" || event.key === "Delete") {
      setDraft(null);
      return;
    }
    if (event.key === "Enter" && !event.ctrlKey && !event.metaKey && !event.altKey) {
      save();
      return;
    }
    const chord = chordFromEvent(event.nativeEvent);
    if (chord) setDraft(chord);
  };

  const hint = !draft
    ? current
      ? t("gitRepo.extras.repoShortcut.hintChange")
      : t("gitRepo.extras.repoShortcut.hintNew", { modifiers })
    : problem === "no_modifier"
      ? t("gitRepo.extras.repoShortcut.hintNoModifier", { modifiers })
      : problem === "reserved"
        ? t("gitRepo.extras.repoShortcut.hintReserved")
        : takenBy
          ? t("gitRepo.extras.repoShortcut.hintTaken", {
              name: repoDisplayName(takenBy, recents),
            })
          : draftId === current
            ? t("gitRepo.extras.repoShortcut.hintCurrent")
            : t("gitRepo.extras.repoShortcut.hintReady", {
                chord: chordText(draft, isMac),
                name,
              });
  const tone = problem ? "text-destructive" : takenBy ? "text-primary" : "text-muted-foreground";

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("gitRepo.extras.repoShortcut.title")}</DialogTitle>
          <DialogDescription>
            {t("gitRepo.extras.repoShortcut.descBefore")}{" "}
            <span className="text-foreground font-medium">{name}</span>{" "}
            {t("gitRepo.extras.repoShortcut.descAfter")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <div
            role="textbox"
            aria-label={t("gitRepo.extras.repoShortcut.captureAria")}
            aria-readonly
            tabIndex={0}
            autoFocus
            data-shortcut-capture
            data-shortcut-problem={problem ?? undefined}
            onKeyDown={onKeyDown}
            className={cn(
              "bg-muted/50 flex h-16 items-center justify-center gap-1.5 rounded-md border border-dashed transition-colors outline-none",
              "focus-visible:border-primary focus-visible:ring-primary/30 focus-visible:ring-2",
              problem ? "border-destructive/60" : "border-border"
            )}
          >
            {draft ? (
              chordLabels(draft, isMac).map((label, index) => (
                <Kbd key={index} className="text-foreground h-8 min-w-8 px-2.5 text-sm">
                  {label}
                </Kbd>
              ))
            ) : (
              <span className="text-muted-foreground/70 text-sm">
                {t("gitRepo.extras.repoShortcut.pressKeys")}
              </span>
            )}
          </div>
          <p className={cn("text-xs", tone)} data-shortcut-hint>
            {hint}
          </p>
        </div>
        <DialogFooter>
          {current && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive mr-auto"
              onClick={remove}
            >
              {t("gitRepo.extras.repoShortcut.remove")}
            </Button>
          )}
          <Button variant="ghost" onClick={closeDialog}>
            {t("gitRepo.extras.repoShortcut.cancel")}
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {t("gitRepo.extras.repoShortcut.save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
