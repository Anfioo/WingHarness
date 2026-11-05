import {
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  List,
  ListTree,
  Loader2,
  Search,
  Tag,
} from "lucide-react";
import { branchCreate, branchDelete, branchRename, tagCreate, tagDelete } from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { buildBranchTree, leafCount, type BranchTreeNode } from "@/features/git/branch-tree";
import type { BranchInfo, TagInfo } from "@/lib/git-core/types";
import { cn } from "@/lib/utils";
import { refreshGitViews, runGitAction } from "./actions";
import { BranchContextMenu, type BranchMenuTarget } from "./branch-context-menu";
import { InputDialog, type InputDialogState } from "./dialogs/input-dialog";
import { WorktreeDialog } from "./dialogs/worktree-dialog";
import { isValidRefName } from "./ref-name";
import type { ProjectTabOpeners } from "./tab-openers";

const ROW =
  "flex h-6 w-full items-center gap-1.5 rounded px-1.5 text-left text-xs transition-colors";
const ACTIVE = "bg-primary/10 text-foreground";
const IDLE = "text-muted-foreground hover:bg-muted hover:text-foreground";
const FOCUS = "bg-muted text-foreground";

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

function Section({
  label,
  count,
  open,
  onToggle,
  children,
}: {
  label: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="text-faint hover:text-foreground flex h-6 w-full items-center gap-1 px-1 text-[11px] font-medium tracking-wide uppercase transition-colors"
      >
        {open ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
        <span className="min-w-0 flex-1 truncate text-left">{label}</span>
        <span className="tabular-nums">{count}</span>
      </button>
      {open && <div className="pb-1">{children}</div>}
    </div>
  );
}

type Row =
  | { type: "folder"; key: string; label: string; count: number; depth: number; open: boolean }
  | { type: "branch"; key: string; branch: BranchInfo; label: string; depth: number };

type Focus = { kind: "branch"; branch: BranchInfo } | { kind: "tag"; tag: TagInfo };

/** Flattens the shared branch tree, folders first, into the rows the pane draws. */
function rowsOf(
  nodes: BranchTreeNode[],
  depth: number,
  prefix: string,
  isOpen: (key: string) => boolean
): Row[] {
  const rows: Row[] = [];
  for (const node of nodes) {
    if (node.branch) {
      rows.push({
        type: "branch",
        key: `ref:${node.branch.name}`,
        branch: node.branch,
        label: node.key,
        depth,
      });
      continue;
    }
    const key = `${prefix}:${node.path}`;
    const open = isOpen(key);
    rows.push({ type: "folder", key, label: node.key, count: leafCount(node), depth, open });
    if (open) rows.push(...rowsOf(node.children, depth + 1, prefix, isOpen));
  }
  return rows;
}

function RefRow({
  row,
  selected,
  focused,
  onSelect,
  onContextMenu,
  onToggleFolder,
}: {
  row: Row;
  selected: string | null;
  focused: boolean;
  onSelect: (branch: BranchInfo) => void;
  onContextMenu: (event: ReactMouseEvent, branch: BranchInfo) => void;
  onToggleFolder: (key: string) => void;
}) {
  const indent = { paddingLeft: 6 + row.depth * 10 };

  if (row.type === "folder") {
    return (
      <button
        type="button"
        aria-expanded={row.open}
        onClick={() => onToggleFolder(row.key)}
        style={indent}
        className={cn(ROW, IDLE)}
      >
        {row.open ? (
          <ChevronDown className="size-3 shrink-0" />
        ) : (
          <ChevronRight className="size-3 shrink-0" />
        )}
        {row.open ? (
          <FolderOpen className="size-3.5 shrink-0" />
        ) : (
          <Folder className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate">{row.label}</span>
        <span className="text-faint shrink-0 tabular-nums">{row.count}</span>
      </button>
    );
  }

  const { branch, label } = row;
  return (
    <button
      type="button"
      title={branch.name}
      onClick={() => onSelect(branch)}
      onContextMenu={(event) => onContextMenu(event, branch)}
      style={indent}
      className={cn(ROW, selected === branch.name ? ACTIVE : focused ? FOCUS : IDLE)}
    >
      {branch.isRemote ? (
        <Cloud className="size-3.5 shrink-0" />
      ) : (
        <GitBranch className="size-3.5 shrink-0" />
      )}
      <span className={cn("min-w-0 flex-1 truncate", branch.isHead && "font-medium")}>{label}</span>
      {branch.ahead > 0 && (
        <span className="text-faint shrink-0 font-mono text-[10px]">↑{branch.ahead}</span>
      )}
      {branch.behind > 0 && (
        <span className="text-faint shrink-0 font-mono text-[10px]">↓{branch.behind}</span>
      )}
      {branch.isHead && <Check className="text-success size-3 shrink-0" />}
    </button>
  );
}

/**
 * The refs the log can be filtered to: every branch, then locals, remotes and
 * tags, the way openidea's rail lists them. Clicking picks a filter, it does not
 * check anything out; the right-click menu is where a ref is acted on.
 *
 * Branch names are shown as a tree by default: `feat/x` under a `feat` folder,
 * a remote's branches under the remote's name, so `origin/feat/x` reads as
 * `origin › feat › x`. The toggle in the filter bar lists full names instead.
 */
export function BranchesPane({
  repo,
  branches,
  tags,
  loading,
  error,
  selected,
  openers,
  onSelect,
  onRetry,
}: {
  repo: string | null;
  branches: readonly BranchInfo[];
  tags: readonly TagInfo[];
  loading: boolean;
  error: string | null;
  /** The branch the log is filtered to, or null for all of them. */
  selected: string | null;
  openers: ProjectTabOpeners;
  onSelect: (branch: string | null) => void;
  onRetry: () => void;
}) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [grouped, setGrouped] = useState(true);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [shut, setShut] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState<Focus | null>(null);
  const [menu, setMenu] = useState<BranchMenuTarget | null>(null);
  const [input, setInput] = useState<InputDialogState | null>(null);
  const [worktree, setWorktree] = useState<BranchInfo | null>(null);

  const toggle = (id: string) => setClosed((state) => ({ ...state, [id]: !state[id] }));
  const toggleFolder = (key: string) => setShut((state) => ({ ...state, [key]: !state[key] }));

  const needle = query.trim().toLowerCase();
  const matches = (name: string) => needle.length === 0 || name.toLowerCase().includes(needle);

  const locals = branches
    .filter((branch) => !branch.isRemote && matches(branch.name))
    .sort((a, b) => Number(b.isHead) - Number(a.isHead) || byName(a, b));
  const remotes = branches
    .filter((branch) => branch.isRemote && !branch.name.endsWith("/HEAD") && matches(branch.name))
    .sort(byName);
  const visibleTags = tags.filter((tag) => matches(tag.name)).sort(byName);

  const rowsOfGroup = (list: BranchInfo[], prefix: string) => {
    if (!grouped) {
      return [...list]
        .sort((a, b) => Number(b.isHead) - Number(a.isHead) || byName(a, b))
        .map(
          (branch): Row => ({
            type: "branch",
            key: `ref:${branch.name}`,
            branch,
            label: branch.name,
            depth: 0,
          })
        );
    }
    return rowsOf(buildBranchTree(list), 0, prefix, (key) => !shut[key]);
  };

  const localRows = rowsOfGroup(locals, "local");
  const remoteRows = rowsOfGroup(remotes, "remote");

  const empty = locals.length === 0 && remotes.length === 0 && visibleTags.length === 0;

  const copyRevision = (oid: string) => {
    void navigator.clipboard.writeText(oid);
    toast.success(t("projectGit.toast.revisionCopied"));
  };

  const openNewBranch = (source: { name: string; oid: string }) => {
    if (!repo) return;
    setInput({
      title: t("gitRepo.sidebar.dialogs.createBranch.title"),
      description: t("projectGit.dialog.branchFrom", { name: source.name }),
      label: t("gitRepo.sidebar.dialogs.createBranch.nameLabel"),
      placeholder: t("gitRepo.sidebar.dialogs.createBranch.namePlaceholder"),
      confirmLabel: t("gitRepo.sidebar.dialogs.createBranch.submit"),
      validate: (value) => (isValidRefName(value) ? null : t("projectGit.dialog.invalidBranch")),
      submit: async (name) => {
        await branchCreate(repo, name, source.oid, false);
        toast.success(t("projectGit.toast.branchCreated", { name }));
        await refreshGitViews();
      },
    });
  };

  const openRename = (branch: BranchInfo) => {
    if (!repo) return;
    setInput({
      title: t("gitRepo.sidebar.dialogs.rename.title"),
      description: t("gitRepo.sidebar.dialogs.rename.description", { name: branch.name }),
      label: t("gitRepo.sidebar.dialogs.createBranch.nameLabel"),
      initialValue: branch.name,
      confirmLabel: t("gitRepo.sidebar.dialogs.rename.submit"),
      validate: (value) => (isValidRefName(value) ? null : t("projectGit.dialog.invalidBranch")),
      submit: async (name) => {
        await branchRename(repo, branch.name, name);
        toast.success(t("projectGit.toast.branchRenamed", { name }));
        await refreshGitViews();
      },
    });
  };

  const openNewTag = (branch: BranchInfo) => {
    if (!repo) return;
    setInput({
      title: t("projectGit.dialog.tagTitle"),
      description: t("projectGit.dialog.tagDescription", { oid: branch.targetOid.slice(0, 8) }),
      label: t("projectGit.dialog.tagLabel"),
      placeholder: t("projectGit.dialog.tagPlaceholder"),
      confirmLabel: t("projectGit.dialog.tagSubmit"),
      validate: (value) => (isValidRefName(value) ? null : t("projectGit.dialog.invalidTag")),
      submit: async (name) => {
        await tagCreate(repo, name, branch.targetOid);
        toast.success(t("projectGit.toast.tagCreated", { name }));
        await refreshGitViews();
      },
    });
  };

  const deleteBranch = async (branch: BranchInfo) => {
    if (!repo) return;
    const confirmed = await confirmDialog({
      title: t("projectGit.confirm.deleteBranch.title", { name: branch.name }),
      description: t("projectGit.confirm.deleteBranch.description"),
      confirmLabel: t("projectGit.confirm.deleteBranch.confirm"),
      destructive: true,
    });
    if (!confirmed) return;
    if (focus?.kind === "branch" && focus.branch.name === branch.name) setFocus(null);
    await runGitAction({
      id: "branch.delete",
      label: t("gitRepo.sidebar.label.branchDelete", { name: branch.name }),
      success: t("projectGit.toast.branchDeleted", { name: branch.name }),
      run: () => branchDelete(repo, branch.name, false),
    });
  };

  const deleteTag = async (tag: TagInfo) => {
    if (!repo) return;
    const confirmed = await confirmDialog({
      title: t("projectGit.confirm.deleteTag.title", { name: tag.name }),
      description: t("projectGit.confirm.deleteTag.description"),
      confirmLabel: t("projectGit.confirm.deleteTag.confirm"),
      destructive: true,
    });
    if (!confirmed) return;
    if (focus?.kind === "tag" && focus.tag.name === tag.name) setFocus(null);
    await runGitAction({
      id: "tag.delete",
      label: t("gitRepo.sidebar.label.tagDelete", { name: tag.name }),
      success: t("projectGit.toast.tagDeleted", { name: tag.name }),
      run: () => tagDelete(repo, tag.name),
    });
  };

  const openMenu = (event: ReactMouseEvent, target: Focus) => {
    event.preventDefault();
    if (!repo) return;
    setFocus(target);
    const point = { x: event.clientX, y: event.clientY };
    setMenu("branch" in target ? { point, branch: target.branch } : { point, tag: target.tag });
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    if (
      target instanceof HTMLElement &&
      target.closest("input, textarea, [contenteditable='true']")
    )
      return;
    if (!focus) return;

    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const key = event.key.toLowerCase();

    if (event.key === "Delete" || (plain && key === "d")) {
      event.preventDefault();
      if (focus.kind === "branch") void deleteBranch(focus.branch);
      else void deleteTag(focus.tag);
      return;
    }

    if (plain && event.key === "0") {
      event.preventDefault();
      copyRevision(focus.kind === "branch" ? focus.branch.targetOid : focus.tag.targetOid);
      return;
    }

    if (key === "c" && (plain || (event.ctrlKey && event.altKey && !event.metaKey))) {
      event.preventDefault();
      openNewBranch(
        focus.kind === "branch"
          ? { name: focus.branch.name, oid: focus.branch.targetOid }
          : { name: focus.tag.name, oid: focus.tag.targetOid }
      );
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col" onKeyDown={onKeyDown}>
      <div className="border-border flex h-8 shrink-0 items-center gap-1 border-b px-2">
        <Search className="text-faint size-3.5 shrink-0" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("gitRepo.sidebar.rail.filterPlaceholder")}
          aria-label={t("gitRepo.sidebar.rail.filterPlaceholder")}
          className="placeholder:text-faint min-w-0 flex-1 bg-transparent text-xs outline-none"
        />
        <Button
          variant="ghost"
          size="icon-xs"
          aria-pressed={grouped}
          aria-label={t("projectGit.groupByPrefix")}
          title={t("projectGit.groupByPrefix")}
          onClick={() => setGrouped((value) => !value)}
        >
          {grouped ? <ListTree className="size-3.5" /> : <List className="size-3.5" />}
        </Button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-1 py-1">
        {loading ? (
          <div className="flex h-16 items-center justify-center">
            <Loader2 className="text-muted-foreground size-4 animate-spin" />
          </div>
        ) : error ? (
          <div className="flex flex-col items-start gap-2 px-2 py-3">
            <p className="text-destructive text-[11px] [overflow-wrap:anywhere]">{error}</p>
            <Button variant="ghost" size="sm" onClick={onRetry}>
              {t("gitRepo.diff.panel.retry")}
            </Button>
          </div>
        ) : (
          <>
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={cn(ROW, "mb-1", selected === null ? ACTIVE : IDLE)}
            >
              <GitBranch className="size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate">{t("projectGit.allBranches")}</span>
            </button>

            {empty ? (
              <p className="text-faint px-2 py-3 text-[11px]">
                {t("gitRepo.sidebar.list.noRefsMatch")}
              </p>
            ) : (
              <div className="flex flex-col gap-1">
                {locals.length > 0 && (
                  <Section
                    label={t("gitRepo.sidebar.sections.branches")}
                    count={locals.length}
                    open={!closed.locals}
                    onToggle={() => toggle("locals")}
                  >
                    {localRows.map((row) => (
                      <RefRow
                        key={row.key}
                        row={row}
                        selected={selected}
                        focused={
                          focus?.kind === "branch" &&
                          row.type === "branch" &&
                          focus.branch.name === row.branch.name
                        }
                        onSelect={(branch) => {
                          setFocus({ kind: "branch", branch });
                          onSelect(branch.name);
                        }}
                        onContextMenu={(event, branch) =>
                          openMenu(event, { kind: "branch", branch })
                        }
                        onToggleFolder={toggleFolder}
                      />
                    ))}
                  </Section>
                )}

                {remotes.length > 0 && (
                  <Section
                    label={t("gitRepo.sidebar.sections.remotes")}
                    count={remotes.length}
                    open={!closed.remotes}
                    onToggle={() => toggle("remotes")}
                  >
                    {remoteRows.map((row) => (
                      <RefRow
                        key={row.key}
                        row={row}
                        selected={selected}
                        focused={
                          focus?.kind === "branch" &&
                          row.type === "branch" &&
                          focus.branch.name === row.branch.name
                        }
                        onSelect={(branch) => {
                          setFocus({ kind: "branch", branch });
                          onSelect(branch.name);
                        }}
                        onContextMenu={(event, branch) =>
                          openMenu(event, { kind: "branch", branch })
                        }
                        onToggleFolder={toggleFolder}
                      />
                    ))}
                  </Section>
                )}

                {visibleTags.length > 0 && (
                  <Section
                    label={t("gitRepo.sidebar.sections.tags")}
                    count={visibleTags.length}
                    open={!closed.tags}
                    onToggle={() => toggle("tags")}
                  >
                    {visibleTags.map((tag) => (
                      <button
                        key={tag.name}
                        type="button"
                        title={tag.message ?? tag.name}
                        onClick={() => {
                          setFocus({ kind: "tag", tag });
                          onSelect(tag.name);
                        }}
                        onContextMenu={(event) => openMenu(event, { kind: "tag", tag })}
                        className={cn(
                          ROW,
                          selected === tag.name
                            ? ACTIVE
                            : focus?.kind === "tag" && focus.tag.name === tag.name
                              ? FOCUS
                              : IDLE
                        )}
                      >
                        <Tag className="size-3.5 shrink-0" />
                        <span className="min-w-0 flex-1 truncate">{tag.name}</span>
                      </button>
                    ))}
                  </Section>
                )}
              </div>
            )}
          </>
        )}
      </div>

      <BranchContextMenu
        repo={repo}
        target={menu}
        currentBranch={branches.find((branch) => branch.isHead)?.name ?? null}
        openers={openers}
        onClose={() => setMenu(null)}
        onNewBranch={openNewBranch}
        onRename={openRename}
        onNewTag={openNewTag}
        onWorktree={setWorktree}
        onDeleteBranch={(branch) => void deleteBranch(branch)}
        onDeleteTag={(tag) => void deleteTag(tag)}
      />
      <InputDialog request={input} onClose={() => setInput(null)} />
      <WorktreeDialog repo={repo} branch={worktree} onClose={() => setWorktree(null)} />
    </div>
  );
}
