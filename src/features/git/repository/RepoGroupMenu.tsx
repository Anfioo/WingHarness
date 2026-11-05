import { toast } from "sonner";
import { Check, FolderMinus, Folders, Plus } from "lucide-react";
import { repoGroupIdFor, type RepoGroup } from "@/lib/git-core";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useGitSettings } from "@/features/git/settings";
import { useRepo } from "@/features/git/repository-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { repoGroupColor, repoGroupTint } from "./groups";
import { openRepoGroupDialog } from "./RepoGroupDialog";
import { repoDisplayName } from "./RepoShortcutDialog";
import { useRepoTabs } from "./tabs";

export function GroupDot({ color, className }: { color: number; className?: string }) {
  return (
    <span className={cn("flex size-4 shrink-0 items-center justify-center", className)} aria-hidden>
      <span className="size-2 rounded-full" style={{ backgroundColor: repoGroupColor(color) }} />
    </span>
  );
}

export function GroupTile({ color, className }: { color: number | null; className?: string }) {
  return (
    <span
      data-group-tile
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded",
        color === null && "bg-foreground/[0.08] text-muted-foreground",
        className
      )}
      style={
        color === null
          ? undefined
          : { color: repoGroupColor(color), backgroundColor: repoGroupTint(color) }
      }
    >
      <Folders className="size-3" />
    </span>
  );
}

function GroupItems({ path }: { path: string }) {
  const { t } = useAppTranslation();
  const groups = useGitSettings((s) => s.repoGroups);
  const groupOf = useGitSettings((s) => s.repoGroupOf);
  const setRepoGroup = useGitSettings((s) => s.setRepoGroup);
  const mains = useRepoTabs((s) => s.worktreeMains);
  const recents = useRepo((s) => s.recents);
  const currentId = repoGroupIdFor(path, groupOf, mains);
  const direct = groupOf[path] ?? null;

  const move = (group: RepoGroup) => {
    if (group.id === currentId) return;
    setRepoGroup(path, group.id);
    toast.success(
      t("gitRepo.extras.repoGroup.moved", {
        name: repoDisplayName(path, recents),
        group: group.name,
      })
    );
  };

  return (
    <>
      {groups.map((group) => (
        <DropdownMenuItem key={group.id} onClick={() => move(group)}>
          {group.id === currentId ? (
            <Check className="text-primary" />
          ) : (
            <GroupDot color={group.color} />
          )}
          <span className="min-w-0 flex-1 truncate">{group.name}</span>
        </DropdownMenuItem>
      ))}
      {groups.length > 0 && <DropdownMenuSeparator />}
      <DropdownMenuItem onClick={() => openRepoGroupDialog({ groupId: null, repoPath: path })}>
        <Plus /> {t("gitRepo.extras.repoGroup.newGroup")}
      </DropdownMenuItem>
      {direct && (
        <>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setRepoGroup(path, null)}>
            <FolderMinus /> {t("gitRepo.extras.repoGroup.remove")}
          </DropdownMenuItem>
        </>
      )}
    </>
  );
}

export function RepoGroupSubmenu({ path }: { path: string }) {
  const { t } = useAppTranslation();
  const groupOf = useGitSettings((s) => s.repoGroupOf);
  const mains = useRepoTabs((s) => s.worktreeMains);
  const currentId = repoGroupIdFor(path, groupOf, mains);

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Folders />{" "}
        {currentId ? t("gitRepo.extras.repoGroup.moveTo") : t("gitRepo.extras.repoGroup.addTo")}
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-w-72">
        <GroupItems path={path} />
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function RepoGroupMenu({ path }: { path: string }) {
  const { t } = useAppTranslation();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon-sm" aria-label={t("gitRepo.extras.repoGroup.menu")}>
          <Folders />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-72">
        <GroupItems path={path} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
