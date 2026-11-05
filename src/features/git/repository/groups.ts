import { toast } from "sonner";
import { pathsExist } from "@/commands";
import type { RepoGroup } from "@/lib/git-core";
import { confirmDialog } from "@/components/confirm";
import { openGitRepoWindow } from "@/lib/git-windows";
import { useGitSettings } from "@/features/git/settings";
import i18n from "@/i18n";
import { closeRepoTabs, useRepoTabs } from "./tabs";

export function repoGroupColor(color: number): string {
  return `hsl(var(--graph-${color % 10}))`;
}

export function repoGroupTint(color: number): string {
  return `hsl(var(--graph-${color % 10}) / 0.15)`;
}

export function plural(count: number, noun: string): string {
  if (count === 1) return `1 ${noun}`;
  return `${count} ${noun.endsWith("y") ? `${noun.slice(0, -1)}ies` : `${noun}s`}`;
}

/**
 * Open every repository in the group in a window of its own, skipping folders
 * that are gone.
 */
export async function openRepoGroup(group: RepoGroup, paths: string[]): Promise<void> {
  const exists = await pathsExist([...paths]);
  const present = paths.filter((_, index) => exists[index]);
  const missing = paths.length - present.length;
  if (present.length === 0) {
    toast.error(
      i18n.t(
        paths.length === 0
          ? "gitRepo.extras.repoGroup.groups.noRepos"
          : "gitRepo.extras.repoGroup.groups.noFolders",
        { name: group.name }
      )
    );
    return;
  }
  for (const path of present) {
    useRepoTabs.getState().addTab(path);
    void openGitRepoWindow(path).catch(() => useRepoTabs.getState().removeTab(path));
  }
  toast.success(
    i18n.t("gitRepo.extras.repoGroup.groups.opened", { name: group.name, count: present.length }),
    {
      description:
        missing > 0
          ? i18n.t("gitRepo.extras.repoGroup.groups.missing", { count: missing })
          : undefined,
    }
  );
}

/** Drop the group's tabs, stepping out of the group if the current one is in it. */
export function closeRepoGroup(group: RepoGroup, paths: string[]): void {
  const tabs = useRepoTabs.getState().tabs;
  const open = paths.filter((path) => tabs.includes(path));
  if (open.length === 0) return;
  closeRepoTabs(open);
  toast.success(i18n.t("gitRepo.extras.repoGroup.groups.closed", { name: group.name }));
}

export async function deleteRepoGroup(group: RepoGroup, repoCount: number): Promise<boolean> {
  if (repoCount > 0) {
    const ok = await confirmDialog({
      title: i18n.t("gitRepo.extras.repoGroup.groups.ungroupTitle", { name: group.name }),
      description: i18n.t("gitRepo.extras.repoGroup.groups.ungroupDesc", { count: repoCount }),
      confirmLabel: i18n.t("gitRepo.extras.repoGroup.ungroup"),
      destructive: true,
    });
    if (!ok) return false;
  }
  useGitSettings.getState().removeRepoGroup(group.id);
  toast.success(i18n.t("gitRepo.extras.repoGroup.groups.ungrouped", { name: group.name }));
  return true;
}
