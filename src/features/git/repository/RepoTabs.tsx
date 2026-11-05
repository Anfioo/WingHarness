import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronsLeftRight,
  ChevronsRightLeft,
  Copy,
  FolderGit2,
  FolderOpen,
  FolderTree,
  Keyboard,
  Pencil,
  Plus,
  Ungroup,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  groupRepos,
  repoGroupIdFor,
  tabClusters,
  type RepoGroup,
  type RepoGroupDropPosition,
} from "@/lib/git-core";
import { pathsExist } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useGitSettings } from "@/features/git/settings";
import { isMac, modKey } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { activateTab, closeRepoTabs, tabLabels, useRepoTabs } from "./tabs";
import { closeRepoGroup, deleteRepoGroup, openRepoGroup, plural, repoGroupColor } from "./groups";
import { GroupDot, RepoGroupSubmenu } from "./RepoGroupMenu";
import { openRepoGroupDialog } from "./RepoGroupDialog";
import { openRepoShortcutDialog } from "./RepoShortcutDialog";
import {
  chordText,
  openRepositoryInNewTab,
  parseChordId,
  repoShortcutsStore,
} from "./use-repo-shortcuts";

const DRAG_TYPE = "text/mabang-repo-tab";
const GROUP_DRAG_TYPE = "text/mabang-repo-group";
const chipZone = (group: RepoGroup) => `group:${group.id}`;

export function RepoTabs() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const recents = useRepo((s) => s.recents);
  const tabs = useRepoTabs((s) => s.tabs);
  const worktreeTabs = useRepoTabs((s) => s.worktreeTabs);
  const worktreeMains = useRepoTabs((s) => s.worktreeMains);
  const tabGroupsCollapsed = useRepoTabs((s) => s.tabGroupsCollapsed);
  const toggleTabGroupCollapsed = useRepoTabs((s) => s.toggleGroupCollapsed);
  const setTabGroupsCollapsed = useRepoTabs((s) => s.setGroupsCollapsed);
  const shortcuts = repoShortcutsStore((s) => s.repoShortcuts);
  const groups = useGitSettings((s) => s.repoGroups);
  const groupOf = useGitSettings((s) => s.repoGroupOf);
  const setRepoGroup = useGitSettings((s) => s.setRepoGroup);
  const moveRepoGroup = useGitSettings((s) => s.moveRepoGroup);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; path: string } | null>(null);
  const [chipMenu, setChipMenu] = useState<{ x: number; y: number; group: RepoGroup } | null>(null);
  const [draggingTab, setDraggingTab] = useState<string | null>(null);
  const [dropZone, setDropZone] = useState<string | null>(null);
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);
  const [groupDrop, setGroupDrop] = useState<{
    id: string;
    position: RepoGroupDropPosition;
  } | null>(null);
  const [overflowing, setOverflowing] = useState(false);
  const stripRef = useRef<HTMLDivElement>(null);

  const clusters = tabClusters(tabs, groups, groupOf, worktreeMains);
  const groupIdOf = (path: string) => repoGroupIdFor(path, groupOf, worktreeMains);
  const activePath = repo?.path ?? null;
  const tabsKey = tabs.join("\n");

  useEffect(() => {
    const paths = tabsKey ? tabsKey.split("\n") : [];
    if (paths.length === 0) return;
    let cancelled = false;
    void pathsExist(paths)
      .then((flags) => {
        if (cancelled) return;
        const current = useRepo.getState().repo?.path;
        const gone = paths.filter((path, i) => !flags[i] && path !== current);
        if (gone.length === 0) return;
        closeRepoTabs(gone);
        const names = gone.map((path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path);
        toast.info(
          gone.length === 1
            ? t("gitRepo.extras.tabs.closedMissing", { name: names[0] })
            : t("gitRepo.extras.tabs.closedMissingMany", { count: gone.length }),
          { description: gone.join("\n") }
        );
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [tabsKey, t]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !activePath) return;
    strip
      .querySelector(`[data-tab-path="${CSS.escape(activePath)}"]`)
      ?.scrollIntoView({ inline: "nearest", block: "nearest" });
  }, [activePath, tabs]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const measure = () => setOverflowing(strip.scrollWidth > strip.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [tabs, tabGroupsCollapsed, groups, groupOf]);

  const activate = (path: string) => activateTab(path);
  const close = (path: string) => closeRepoTabs([path]);
  const groupIds = clusters.flatMap((cluster) => (cluster.group ? [cluster.group.id] : []));
  const collapseOthers = (keep: string) =>
    setTabGroupsCollapsed(Object.fromEntries(groupIds.map((id) => [id, id !== keep])));
  const expandAll = () =>
    setTabGroupsCollapsed(Object.fromEntries(groupIds.map((id) => [id, false])));
  const anyCollapsed = groupIds.some((id) => tabGroupsCollapsed[id]);
  const addNew = () => void openRepositoryInNewTab();
  const labels = useMemo(() => tabLabels(tabs), [tabs]);
  const label = (path: string) => labels.get(path)?.name ?? path;
  const shortcutFor = (path: string) => {
    const chord = shortcuts[path] ? parseChordId(shortcuts[path]) : null;
    return chord ? chordText(chord, isMac) : null;
  };
  const closeOthers = (path: string) => {
    closeRepoTabs(tabs.filter((other) => other !== path));
    if (repo?.path !== path) activate(path);
  };
  const tabTitle = (path: string) => {
    const groupId = groupIdOf(path);
    const group = groupId ? groups.find((g) => g.id === groupId) : undefined;
    return `${path}${group ? ` · ${group.name}` : ""}${worktreeTabs.includes(path) ? " (worktree)" : ""}`;
  };
  const groupPaths = (group: RepoGroup) => {
    const known =
      groupRepos(recents, groups, groupOf, worktreeMains)
        .sections.find((section) => section.group.id === group.id)
        ?.repos.map((r) => r.path) ?? [];
    const open = clusters.find((cluster) => cluster.group?.id === group.id)?.tabs ?? [];
    return Array.from(new Set([...known, ...open]));
  };

  const endDrag = () => {
    setDraggingTab(null);
    setDropZone(null);
    setDraggingGroup(null);
    setGroupDrop(null);
  };
  const dragOver = (zone: string) => (e: React.DragEvent) => {
    if (!draggingTab || draggingTab === zone) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dropZone !== zone) setDropZone(zone);
  };
  const dragLeave = (zone: string) => () => setDropZone((z) => (z === zone ? null : z));
  const sourceOf = (e: React.DragEvent) => e.dataTransfer.getData(DRAG_TYPE) || draggingTab;
  const dropOnTab = (source: string, target: string, targetGroup: string | null) => {
    if (source === target) return;
    if (groupIdOf(source) !== targetGroup) setRepoGroup(source, targetGroup);
    useRepoTabs.getState().moveTab(source, target, "before");
  };
  const dropOnChip = (source: string, group: RepoGroup, first: string | undefined) => {
    if (groupIdOf(source) !== group.id) setRepoGroup(source, group.id);
    if (first && first !== source) useRepoTabs.getState().moveTab(source, first, "before");
  };

  const separator = (key: string) => (
    <span
      key={key}
      aria-hidden
      data-tab-separator
      className="bg-border mb-2 h-4 w-px shrink-0 transition-opacity [&:has(+[aria-selected=true])]:opacity-0 [&:has(+[role=tab]:hover)]:opacity-0 [[aria-selected=true]+&]:opacity-0 [[role=tab]:hover+&]:opacity-0"
    />
  );
  const renderRun = (paths: string[], clusterGroup: RepoGroup | null) =>
    paths.flatMap((path, index) =>
      index === 0
        ? [renderTab(path, clusterGroup)]
        : [separator(`sep:${path}`), renderTab(path, clusterGroup)]
    );

  const renderTab = (path: string, clusterGroup: RepoGroup | null) => {
    const active = path === repo?.path;
    return (
      <div
        key={path}
        role="tab"
        aria-selected={active}
        data-tab-path={path}
        title={tabTitle(path)}
        draggable
        onDragStart={(e) => {
          setDraggingTab(path);
          e.dataTransfer.setData(DRAG_TYPE, path);
          e.dataTransfer.effectAllowed = "move";
        }}
        onDragEnd={endDrag}
        onDragOver={dragOver(path)}
        onDragLeave={dragLeave(path)}
        onDrop={(e) => {
          if (!draggingTab) return;
          e.preventDefault();
          const source = sourceOf(e);
          endDrag();
          if (source && source !== path) dropOnTab(source, path, clusterGroup?.id ?? null);
        }}
        onClick={() => activate(path)}
        onContextMenu={(e) => {
          e.preventDefault();
          setTabMenu({ x: e.clientX, y: e.clientY, path });
        }}
        onAuxClick={(e) => {
          if (e.button === 1) close(path);
        }}
        className={cn(
          "group flex h-8 max-w-56 min-w-0 shrink-0 cursor-default items-center gap-1.5 rounded-t-md border border-b-0 px-3 text-xs",
          active
            ? "border-border bg-background text-foreground"
            : "text-muted-foreground hover:bg-muted hover:text-foreground border-transparent",
          draggingTab === path && "opacity-40",
          dropZone === path && "ring-primary/60 ring-1 ring-inset"
        )}
      >
        {worktreeTabs.includes(path) && (
          <FolderTree
            className={cn("size-3 shrink-0", active ? "text-primary" : "text-muted-foreground/70")}
            aria-label={t("gitRepo.extras.tabs.worktree")}
          />
        )}
        <span className={cn("min-w-0 truncate", labels.get(path)?.hint && "max-w-full shrink-0")}>
          {label(path)}
        </span>
        {labels.get(path)?.hint && (
          <span
            dir="rtl"
            className={cn(
              "min-w-0 truncate text-left text-[10px]",
              active ? "text-muted-foreground" : "text-muted-foreground/70"
            )}
            data-tab-hint
          >
            <bdi>{labels.get(path)?.hint}</bdi>
          </span>
        )}
        {shortcutFor(path) && (
          <span
            className={cn(
              "text-primary inline-flex h-4 shrink-0 items-center rounded px-1 font-mono text-[9px] font-medium tracking-wide",
              active ? "bg-primary/20" : "bg-primary/15"
            )}
            data-tab-shortcut
          >
            {shortcutFor(path)}
          </span>
        )}
        <button
          type="button"
          aria-label={t("gitRepo.extras.tabs.closeAria", { name: label(path) })}
          className={cn(
            "hover:bg-accent hover:text-foreground shrink-0 rounded-sm p-0.5",
            active ? "text-muted-foreground" : "group-hover:text-muted-foreground text-transparent"
          )}
          onClick={(e) => {
            e.stopPropagation();
            close(path);
          }}
        >
          <X className="size-3" />
        </button>
      </div>
    );
  };

  return (
    <div className="border-border bg-card flex h-9 shrink-0 items-end gap-0.5 border-b px-2">
      <div
        ref={stripRef}
        className="scrollbar-none flex min-w-0 flex-1 items-end gap-0.5 overflow-x-auto"
        onWheel={(e) => {
          if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
            e.currentTarget.scrollLeft += e.deltaY;
          }
        }}
      >
        {clusters.map((cluster) => {
          const group = cluster.group;
          if (!group) return renderRun(cluster.tabs, null);
          const collapsed = !!tabGroupsCollapsed[group.id];
          const shown = collapsed
            ? cluster.tabs.filter((path) => path === repo?.path)
            : cluster.tabs;
          const zone = chipZone(group);
          const groupDropHere = groupDrop?.id === group.id ? groupDrop.position : null;
          const tabCount = plural(cluster.tabs.length, "tab");
          return (
            <div
              key={group.id}
              data-tab-cluster={group.id}
              data-tab-cluster-collapsed={collapsed || undefined}
              className={cn(
                "relative mr-1.5 flex shrink-0 items-end gap-0.5 pr-1",
                draggingGroup === group.id && "opacity-40",
                groupDropHere === "before" && "shadow-[inset_2px_0_0_0_hsl(var(--primary))]",
                groupDropHere === "after" && "shadow-[inset_-2px_0_0_0_hsl(var(--primary))]"
              )}
              onDragOver={(e) => {
                if (!draggingGroup || draggingGroup === group.id) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = "move";
                const rect = e.currentTarget.getBoundingClientRect();
                const position: RepoGroupDropPosition =
                  e.clientX < rect.left + rect.width / 2 ? "before" : "after";
                if (groupDrop?.id !== group.id || groupDrop.position !== position)
                  setGroupDrop({ id: group.id, position });
              }}
              onDragLeave={(e) => {
                if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
                setGroupDrop((d) => (d?.id === group.id ? null : d));
              }}
              onDrop={(e) => {
                if (!draggingGroup) return;
                e.preventDefault();
                const moving = e.dataTransfer.getData(GROUP_DRAG_TYPE) || draggingGroup;
                const target = groupDrop;
                endDrag();
                if (moving && moving !== group.id && target?.id === group.id)
                  moveRepoGroup(moving, group.id, target.position);
              }}
            >
              <span
                aria-hidden
                data-tab-cluster-edge
                className="pointer-events-none absolute inset-x-0 top-0 h-0.5 rounded-full"
                style={{ backgroundColor: repoGroupColor(group.color) }}
              />
              <button
                type="button"
                data-tab-group={group.id}
                aria-expanded={!collapsed}
                aria-label={t("gitRepo.extras.tabs.groupAria", {
                  name: group.name,
                  tabs: tabCount,
                })}
                title={t(
                  collapsed
                    ? "gitRepo.extras.tabs.groupTitleExpand"
                    : "gitRepo.extras.tabs.groupTitleCollapse",
                  { name: group.name, tabs: tabCount }
                )}
                className={cn(
                  "flex h-8 max-w-36 shrink-0 items-center gap-1.5 rounded-t-md px-2.5 text-[11px] leading-none font-semibold transition-opacity hover:opacity-75",
                  dropZone === zone && "ring-primary/70 ring-1 ring-inset"
                )}
                style={{ color: repoGroupColor(group.color) }}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData(GROUP_DRAG_TYPE, group.id);
                  e.dataTransfer.effectAllowed = "move";
                  setDraggingGroup(group.id);
                }}
                onDragEnd={endDrag}
                onClick={() => toggleTabGroupCollapsed(group.id)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setChipMenu({ x: e.clientX, y: e.clientY, group });
                }}
                onDragOver={dragOver(zone)}
                onDragLeave={dragLeave(zone)}
                onDrop={(e) => {
                  if (!draggingTab) return;
                  e.preventDefault();
                  const source = sourceOf(e);
                  endDrag();
                  if (source) dropOnChip(source, group, cluster.tabs[0]);
                }}
              >
                <span className="truncate">{group.name}</span>
                {collapsed && (
                  <span className="shrink-0 font-mono text-[10px] opacity-80">
                    {cluster.tabs.length}
                  </span>
                )}
              </button>
              {renderRun(shown, group)}
            </div>
          );
        })}
      </div>
      {tabMenu && (
        <DropdownMenu open onOpenChange={(o) => !o && setTabMenu(null)}>
          <DropdownMenuTrigger asChild>
            <span style={{ position: "fixed", left: tabMenu.x, top: tabMenu.y }} />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="bottom">
            <DropdownMenuLabel className="max-w-72 truncate font-mono">
              {tabMenu.path}
            </DropdownMenuLabel>
            <DropdownMenuItem onClick={() => openRepoShortcutDialog(tabMenu.path)}>
              <Keyboard />{" "}
              {shortcuts[tabMenu.path]
                ? t("gitRepo.extras.tabs.shortcutChange")
                : t("gitRepo.extras.tabs.shortcutSet")}
            </DropdownMenuItem>
            <RepoGroupSubmenu path={tabMenu.path} />
            <DropdownMenuItem
              onClick={() => {
                void navigator.clipboard.writeText(tabMenu.path);
                toast.success(t("gitRepo.extras.tabs.pathCopied"));
              }}
            >
              <Copy /> {t("gitRepo.extras.tabs.copyPath")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => close(tabMenu.path)}>
              <X /> {t("gitRepo.extras.tabs.closeTab")}
            </DropdownMenuItem>
            <DropdownMenuItem disabled={tabs.length < 2} onClick={() => closeOthers(tabMenu.path)}>
              <X /> {t("gitRepo.extras.tabs.closeOthers")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      {chipMenu &&
        (() => {
          const { group } = chipMenu;
          const paths = groupPaths(group);
          const openCount = paths.filter((p) => tabs.includes(p)).length;
          const unopened = paths.length - openCount;
          const collapsed = !!tabGroupsCollapsed[group.id];
          return (
            <DropdownMenu open onOpenChange={(o) => !o && setChipMenu(null)}>
              <DropdownMenuTrigger asChild>
                <span style={{ position: "fixed", left: chipMenu.x, top: chipMenu.y }} />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="bottom" className="min-w-56">
                <DropdownMenuLabel className="flex items-center gap-1.5">
                  <GroupDot color={group.color} className="-ml-1" />
                  <span className="truncate">{group.name}</span>
                </DropdownMenuLabel>
                <DropdownMenuItem onClick={() => toggleTabGroupCollapsed(group.id)}>
                  {collapsed ? <ChevronsLeftRight /> : <ChevronsRightLeft />}{" "}
                  {collapsed
                    ? t("gitRepo.extras.tabs.expandItsTabs")
                    : t("gitRepo.extras.tabs.collapseItsTabs")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={groupIds.length < 2}
                  onClick={() => collapseOthers(group.id)}
                >
                  <ChevronsRightLeft /> {t("gitRepo.extras.tabs.collapseOtherGroups")}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!anyCollapsed} onClick={expandAll}>
                  <ChevronsLeftRight /> {t("gitRepo.extras.tabs.expandAllGroups")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={unopened === 0}
                  onClick={() => void openRepoGroup(group, paths)}
                >
                  <FolderOpen /> {t("gitRepo.extras.tabs.openRest")}
                  <DropdownMenuShortcut>{unopened}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => closeRepoGroup(group, paths)}>
                  <X /> {t("gitRepo.extras.tabs.closeItsTabs")}
                  <DropdownMenuShortcut>{openCount}</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => openRepoGroupDialog({ groupId: group.id, repoPath: null })}
                >
                  <Pencil /> {t("gitRepo.extras.tabs.editGroup")}
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => void deleteRepoGroup(group, paths.length)}>
                  <Ungroup />{" "}
                  {paths.length > 0
                    ? t("gitRepo.extras.tabs.ungroupEllipsis")
                    : t("gitRepo.extras.tabs.ungroup")}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          );
        })()}
      {overflowing && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="mb-0.5 shrink-0"
              aria-label={t("gitRepo.extras.tabs.allOpenTabs")}
              title={t("gitRepo.extras.tabs.allOpenTabs")}
              data-tab-overflow
            >
              <ChevronDown className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="end"
            className="flex max-h-[min(70vh,var(--radix-dropdown-menu-content-available-height))] min-w-64 flex-col"
          >
            <div className="min-h-0 flex-1 overflow-y-auto">
              {clusters.map((cluster) => (
                <div key={cluster.group?.id ?? "ungrouped"}>
                  {cluster.group ? (
                    <DropdownMenuLabel className="flex items-center gap-1.5">
                      <GroupDot color={cluster.group.color} className="-ml-1" />
                      <span className="truncate">{cluster.group.name}</span>
                    </DropdownMenuLabel>
                  ) : (
                    groups.length > 0 && (
                      <DropdownMenuLabel>{t("gitRepo.extras.tabs.other")}</DropdownMenuLabel>
                    )
                  )}
                  {cluster.tabs.map((path) => {
                    const active = path === repo?.path;
                    return (
                      <DropdownMenuItem key={path} onClick={() => activate(path)}>
                        {active ? <Check className="text-primary" /> : <FolderGit2 />}
                        <span className={cn("min-w-0 flex-1 truncate", active && "text-primary")}>
                          {label(path)}
                        </span>
                      </DropdownMenuItem>
                    );
                  })}
                </div>
              ))}
            </div>
            {groupIds.length > 0 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem disabled={!anyCollapsed} onClick={expandAll}>
                  <ChevronsLeftRight /> {t("gitRepo.extras.tabs.expandAllGroups")}
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={groupIds.every((id) => tabGroupsCollapsed[id])}
                  onClick={() =>
                    setTabGroupsCollapsed(Object.fromEntries(groupIds.map((id) => [id, true])))
                  }
                >
                  <ChevronsRightLeft /> {t("gitRepo.extras.tabs.collapseAllGroups")}
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      )}
      <Button
        variant="ghost"
        size="icon-sm"
        className="mb-0.5 shrink-0"
        aria-label={t("gitRepo.extras.tabs.openAnotherRepository")}
        title={t("gitRepo.extras.tabs.openAnotherHint", { mod: modKey() })}
        onClick={addNew}
      >
        <Plus className="size-4" />
      </Button>
    </div>
  );
}
