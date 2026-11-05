import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
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
import { Input } from "@/components/ui/input";
import {
  groupRepos,
  nextRepoGroupColor,
  repoGroupNameProblem,
  REPO_GROUP_COLORS,
  REPO_GROUP_COLOR_NAMES,
} from "@/lib/git-core";
import { cn } from "@/lib/utils";
import { useRepo } from "@/features/git/repository-store";
import { useGitSettings } from "@/features/git/settings";
import { Field } from "@/features/git/settings/SettingCard";
import { useRepoTabs } from "./tabs";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { deleteRepoGroup, repoGroupColor } from "./groups";
import { repoDisplayName } from "./RepoShortcutDialog";

export interface RepoGroupPreset {
  groupId: string | null;
  repoPath: string | null;
}

interface RepoGroupDialogState {
  preset: RepoGroupPreset | null;
  open: (preset: RepoGroupPreset) => void;
  close: () => void;
}

const useRepoGroupDialogState = create<RepoGroupDialogState>((set) => ({
  preset: null,
  open: (preset) => set({ preset }),
  close: () => set({ preset: null }),
}));

export function openRepoGroupDialog(preset: RepoGroupPreset): void {
  useRepoGroupDialogState.getState().open(preset);
}

export function RepoGroupDialog() {
  const { t } = useAppTranslation();
  const preset = useRepoGroupDialogState((s) => s.preset);
  const closeDialog = useRepoGroupDialogState((s) => s.close);
  const groups = useGitSettings((s) => s.repoGroups);
  const groupOf = useGitSettings((s) => s.repoGroupOf);
  const addRepoGroup = useGitSettings((s) => s.addRepoGroup);
  const updateRepoGroup = useGitSettings((s) => s.updateRepoGroup);
  const setRepoGroup = useGitSettings((s) => s.setRepoGroup);
  const mains = useRepoTabs((s) => s.worktreeMains);
  const recents = useRepo((s) => s.recents);

  const open = preset !== null;
  const effective: RepoGroupPreset = preset ?? { groupId: null, repoPath: null };
  const existing = effective.groupId
    ? (groups.find((group) => group.id === effective.groupId) ?? null)
    : null;
  const repoName = effective.repoPath ? repoDisplayName(effective.repoPath, recents) : null;
  const repoCount = useMemo(
    () =>
      existing
        ? (groupRepos(recents, groups, groupOf, mains).sections.find(
            (s) => s.group.id === existing.id
          )?.repos.length ?? 0)
        : 0,
    [existing, recents, groups, groupOf, mains]
  );

  const [name, setName] = useState("");
  const [color, setColor] = useState(0);

  useEffect(() => {
    if (!open) return;
    setName(existing?.name ?? "");
    setColor(existing?.color ?? nextRepoGroupColor(groups));
  }, [open, effective.groupId, existing, groups]);

  const problem = repoGroupNameProblem(name, groups, existing?.id);
  const unchanged = !!existing && existing.name === name.trim() && existing.color === color;
  const canSave = !problem && !unchanged;

  const save = () => {
    if (!canSave) return;
    const trimmed = name.trim();
    if (existing) {
      updateRepoGroup(existing.id, { name: trimmed, color });
    } else {
      const group = addRepoGroup(trimmed);
      if (group.color !== color) updateRepoGroup(group.id, { color });
      if (effective.repoPath) setRepoGroup(effective.repoPath, group.id);
      toast.success(
        repoName
          ? t("gitRepo.extras.repoGroup.addedTo", { name: repoName, group: trimmed })
          : t("gitRepo.extras.repoGroup.created", { name: trimmed })
      );
    }
    closeDialog();
  };

  const remove = async () => {
    if (!existing) return;
    closeDialog();
    await deleteRepoGroup(existing, repoCount);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {existing
              ? t("gitRepo.extras.repoGroup.titleEdit")
              : t("gitRepo.extras.repoGroup.titleCreate")}
          </DialogTitle>
          <DialogDescription>
            {existing
              ? t("gitRepo.extras.repoGroup.descEdit")
              : repoName
                ? t("gitRepo.extras.repoGroup.descCreateRepo", { name: repoName })
                : t("gitRepo.extras.repoGroup.descCreate")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          <Field
            label={t("gitRepo.extras.repoGroup.nameLabel")}
            hint={problem === "taken" ? t("gitRepo.extras.repoGroup.nameTaken") : undefined}
          >
            <Input
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  save();
                }
              }}
              placeholder={t("gitRepo.extras.repoGroup.namePlaceholder")}
              aria-invalid={problem === "taken" || undefined}
              data-group-name
            />
          </Field>
          <div className="flex flex-col gap-1.5">
            <span className="text-muted-foreground text-xs font-medium">
              {t("gitRepo.extras.repoGroup.colour")}
            </span>
            <div
              className="flex flex-wrap gap-2"
              role="radiogroup"
              aria-label={t("gitRepo.extras.repoGroup.colourAria")}
            >
              {Array.from({ length: REPO_GROUP_COLORS }, (_, index) => {
                const selected = index === color;
                return (
                  <button
                    key={index}
                    type="button"
                    role="radio"
                    aria-checked={selected}
                    aria-label={REPO_GROUP_COLOR_NAMES[index]}
                    onClick={() => setColor(index)}
                    className={cn(
                      "flex size-7 items-center justify-center rounded-full transition-transform",
                      "focus-visible:ring-primary/60 focus-visible:ring-offset-background focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none",
                      selected ? "scale-110" : "hover:scale-105"
                    )}
                    style={{ backgroundColor: repoGroupColor(index) }}
                  >
                    {selected && <Check className="text-background size-3.5" strokeWidth={3} />}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
        <DialogFooter>
          {existing && (
            <Button
              variant="ghost"
              className="text-destructive hover:text-destructive mr-auto"
              onClick={() => void remove()}
            >
              {t("gitRepo.extras.repoGroup.ungroup")}
            </Button>
          )}
          <Button variant="ghost" onClick={closeDialog}>
            {t("gitRepo.extras.repoGroup.cancel")}
          </Button>
          <Button disabled={!canSave} onClick={save}>
            {existing ? t("gitRepo.extras.repoGroup.save") : t("gitRepo.extras.repoGroup.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
