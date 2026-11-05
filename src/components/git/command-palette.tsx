import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { Command } from "cmdk";
import { toast } from "sonner";
import { openUrl } from "@tauri-apps/plugin-opener";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  Check,
  Code,
  FileClock,
  FolderGit2,
  FolderOpen,
  FolderTree,
  Folders,
  GitBranchPlus,
  GitPullRequest,
  Globe,
  History,
  PanelLeft,
  Redo2,
  RefreshCw,
  Settings,
  Tag as TagIcon,
  Undo2,
  UserRoundSearch,
} from "lucide-react";
import {
  branchCheckout,
  rebaseAbort,
  rebaseContinue,
  remoteFetch,
  remotePull,
  remotePush,
  repoFiles,
  stashPop,
  stateCleanup,
} from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRepo } from "@/features/git/repository-store";
import { abortMergeFlow } from "@/features/git/repository/merge";
import { fetchRemotes, fetchResultMessage } from "@/features/git/repository/fetchRemotes";
import { openRepoGroup } from "@/features/git/repository/groups";
import { activateTab, goToRepoHome } from "@/features/git/repository/tabs";
import { sidebarVisible, useUi } from "@/features/git/ui-store";
import { useGitSettings } from "@/features/git/settings/store";
import { openInEditor, preferredEditor, useEditors } from "@/features/git/settings/editors";
import { useUndo } from "@/features/git/history/undoStore";
import { useForge } from "@/features/git/forge/store";
import { toastOutcome } from "@/features/git/toast-outcome";
import {
  groupRepos,
  pickRemote,
  pushSetsUpstream,
  remoteWebUrl,
  repoGroupIdFor,
} from "@/lib/git-core";
import { forgeNoun } from "@/lib/git-core/forge";
import { currentPullRequestUrl, modKey, shortenHome } from "@/features/git/utils";

export function CommandPalette() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const editorId = useGitSettings((s) => s.editorId);
  const repoGroups = useGitSettings((s) => s.repoGroups);
  const repoGroupOf = useGitSettings((s) => s.repoGroupOf);
  const { editors } = useEditors();
  const editor = preferredEditor(editors, editorId);
  const branches = useRepo((s) => s.branches);
  const remotes = useRepo((s) => s.remotes);
  const recents = useRepo((s) => s.recents);
  const worktrees = useRepo((s) => s.worktrees);
  const stashes = useRepo((s) => s.stashes);
  const paletteOpen = useUi((s) => s.paletteOpen);
  const setPaletteOpen = useUi((s) => s.setPaletteOpen);
  const toggleSidebar = useUi((s) => s.toggleSidebar);
  const sidebarOpen = useUi(sidebarVisible);
  const openDialog = useUi((s) => s.openDialog);
  const forgeRepoPath = useForge((s) => s.repoPath);
  const forgeKind = useForge((s) => s.remote?.kind ?? null);
  const forgeAccount = useForge((s) => s.hasAccount);
  const undoStack = useUndo((s) => s.undoStack);
  const redoStack = useUndo((s) => s.redoStack);

  const path = repo?.path ?? "";
  const repoState = repo?.state ?? "clean";
  const headUpstream = useMemo(
    () => branches.find((b) => !b.isRemote && b.isHead)?.upstream ?? null,
    [branches]
  );
  const remote = pickRemote(remotes, headUpstream)?.name ?? "origin";
  const locals = useMemo(() => branches.filter((b) => !b.isRemote && !b.isHead), [branches]);
  const otherRepos = useMemo(
    () => recents.filter((r) => r.path !== path).slice(0, 8),
    [recents, path]
  );
  const groupSections = useMemo(
    () => groupRepos(recents, repoGroups, repoGroupOf).sections.filter((s) => s.repos.length > 0),
    [recents, repoGroups, repoGroupOf]
  );
  const groupNameOf = (repoPath: string): string | undefined => {
    const id = repoGroupIdFor(repoPath, repoGroupOf);
    return id ? repoGroups.find((g) => g.id === id)?.name : undefined;
  };
  const nextUndo = useMemo(
    () => [...undoStack].reverse().find((e) => e.repoPath === path),
    [undoStack, path]
  );
  const nextRedo = useMemo(
    () => [...redoStack].reverse().find((e) => e.repoPath === path),
    [redoStack, path]
  );

  const [mode, setMode] = useState<"commands" | "fileHistory" | "blame">("commands");
  const [search, setSearch] = useState("");
  const [files, setFiles] = useState<string[]>([]);
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState(false);
  const filesRequest = useRef(0);

  useEffect(() => {
    if (!paletteOpen) return;
    setMode("commands");
    setSearch("");
  }, [paletteOpen]);

  const enterFilePicker = (picker: "fileHistory" | "blame") => {
    setMode(picker);
    setSearch("");
    setFiles([]);
    setFilesError(false);
    setFilesLoading(true);
    const token = ++filesRequest.current;
    void repoFiles(path)
      .then((list) => {
        if (filesRequest.current !== token) return;
        setFiles(list);
        setFilesLoading(false);
      })
      .catch((error) => {
        if (filesRequest.current !== token) return;
        setFiles([]);
        setFilesError(true);
        setFilesLoading(false);
        toast.error(
          t("gitRepo.palette.toast.listingFailed", {
            error: (error as { message?: string }).message ?? error,
          })
        );
      });
  };

  const visibleFiles = useMemo(() => {
    if (mode === "commands") return [];
    const q = search.trim().toLowerCase();
    const matches = q ? files.filter((f) => f.toLowerCase().includes(q)) : files;
    return matches.slice(0, 50);
  }, [mode, files, search]);

  const visibleBranches = useMemo(() => {
    if (mode !== "commands") return [];
    const q = search.trim().toLowerCase();
    const matches = q ? locals.filter((b) => b.name.toLowerCase().includes(q)) : locals;
    return matches.slice(0, 100);
  }, [mode, locals, search]);

  const close = () => setPaletteOpen(false);

  const run = (label: string, op: () => Promise<unknown>, options?: { marksFetched?: boolean }) => {
    close();
    void (async () => {
      try {
        const result = (await op()) as { status?: string; message?: string } | undefined;
        if (options?.marksFetched && useRepo.getState().repo?.path === path)
          useRepo.getState().markFetched();
        toastOutcome(result, t("gitRepo.palette.toast.done", { label }));
        await useRepo.getState().refresh();
      } catch (error) {
        toast.error(
          t("gitRepo.palette.toast.failed", {
            label,
            error: (error as { message?: string }).message ?? error,
          })
        );
      }
    })();
  };

  const runHistory = (direction: "undo" | "redo") => {
    close();
    const fn = direction === "undo" ? useUndo.getState().undo : useUndo.getState().redo;
    void fn(path).then((ok) => {
      if (ok) void useRepo.getState().refresh();
    });
  };

  const openRepository = () => {
    close();
    const title = t("gitRepo.palette.openDialogTitle");
    void pickDirectory({ directory: true, title })
      .then((dir) => {
        if (!dir || dir === path) return;
        activateTab(dir);
      })
      .catch((error: unknown) =>
        toast.error(
          t("gitRepo.palette.toast.openFailed", {
            error: (error as { message?: string }).message ?? error,
          })
        )
      );
  };

  const continueRebase = () => {
    close();
    void (async () => {
      try {
        const outcome = await rebaseContinue(path);
        toastOutcome(outcome, t("gitRepo.palette.toast.rebaseContinued"));
      } catch (error) {
        toast.error(
          t("gitRepo.palette.toast.continueFailed", {
            error: (error as { message?: string }).message ?? error,
          })
        );
      }
      await useRepo.getState().refresh();
    })();
  };

  const abortRebase = () => {
    close();
    void (async () => {
      const ok = await confirmDialog({
        title: t("gitRepo.palette.confirm.abortRebaseTitle"),
        description: t("gitRepo.palette.confirm.abortRebaseDescription"),
        confirmLabel: t("gitRepo.palette.confirm.abortRebaseConfirm"),
        destructive: true,
      });
      if (!ok) return;
      try {
        await rebaseAbort(path);
        toast.success(t("gitRepo.palette.toast.rebaseAborted"));
      } catch (error) {
        toast.error(
          t("gitRepo.palette.toast.abortFailed", {
            error: (error as { message?: string }).message ?? error,
          })
        );
      }
      await useRepo.getState().refresh();
    })();
  };

  const abortMerge = () => {
    close();
    void abortMergeFlow(path);
  };

  const clearState = () => {
    close();
    void (async () => {
      const ok = await confirmDialog({
        title: t("gitRepo.palette.confirm.clearTitle", { state: repoState }),
        description: t("gitRepo.palette.confirm.clearDescription", { state: repoState }),
        confirmLabel: t("gitRepo.palette.confirm.clearConfirm"),
      });
      if (!ok) return;
      try {
        await stateCleanup(path);
        toast.success(t("gitRepo.palette.toast.stateCleared"));
      } catch (error) {
        toast.error(
          t("gitRepo.palette.toast.clearFailed", {
            error: (error as { message?: string }).message ?? error,
          })
        );
      }
      await useRepo.getState().refresh();
    })();
  };

  return (
    <Command.Dialog
      open={paletteOpen}
      onOpenChange={setPaletteOpen}
      label={t("gitRepo.palette.title")}
      shouldFilter={mode === "commands"}
      className="border-border bg-popover fixed top-24 left-1/2 z-50 w-full max-w-lg -translate-x-1/2 overflow-hidden rounded-lg border shadow-sm"
    >
      <Command.Input
        value={search}
        onValueChange={setSearch}
        placeholder={
          mode === "fileHistory"
            ? t("gitRepo.palette.placeholder.fileHistory")
            : mode === "blame"
              ? t("gitRepo.palette.placeholder.blame")
              : t("gitRepo.palette.placeholder.commands")
        }
        onKeyDown={(e) => {
          if (mode !== "commands" && e.key === "Backspace" && search === "") {
            e.preventDefault();
            setMode("commands");
          }
        }}
        className="border-border text-foreground placeholder:text-muted-foreground h-11 w-full border-b bg-transparent px-4 text-sm outline-none"
      />
      <Command.List className="[&_[cmdk-group-heading]]:text-muted-foreground max-h-80 overflow-y-auto p-1.5 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-[10px] [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:tracking-wide [&_[cmdk-group-heading]]:uppercase">
        {!(mode !== "commands" && (filesLoading || filesError)) && (
          <Command.Empty className="text-muted-foreground py-8 text-center text-sm">
            {t("gitRepo.palette.noResults")}
          </Command.Empty>
        )}
        {mode !== "commands" && filesLoading && (
          <div className="text-muted-foreground py-8 text-center text-sm">
            {t("gitRepo.palette.loadingFiles")}
          </div>
        )}
        {mode !== "commands" && !filesLoading && filesError && (
          <div className="text-muted-foreground py-8 text-center text-sm">
            {t("gitRepo.palette.listFailed")}
          </div>
        )}
        {mode !== "commands" && !filesLoading && !filesError && (
          <Command.Group
            heading={
              mode === "blame" ? t("gitRepo.palette.group.blame") : t("gitRepo.palette.group.files")
            }
          >
            {visibleFiles.map((file) => (
              <PaletteItem
                key={file}
                icon={mode === "blame" ? <UserRoundSearch /> : <FileClock />}
                label={file}
                onSelect={() => {
                  close();
                  if (mode === "blame") useUi.getState().openBlame(file);
                  else useUi.getState().openFileHistory(file);
                }}
              />
            ))}
          </Command.Group>
        )}
        {mode === "commands" && (
          <>
            <Command.Group heading={t("gitRepo.palette.group.actions")}>
              <PaletteItem
                icon={<History />}
                label={t("gitRepo.palette.item.fileHistory")}
                onSelect={() => enterFilePicker("fileHistory")}
              />
              <PaletteItem
                icon={<UserRoundSearch />}
                label={t("gitRepo.palette.item.blame")}
                onSelect={() => enterFilePicker("blame")}
              />
              <PaletteItem
                icon={<ArrowDownToLine />}
                label={t("gitRepo.palette.item.pull")}
                onSelect={() =>
                  run(t("gitRepo.palette.action.pull"), () => remotePull(path, remote), {
                    marksFetched: true,
                  })
                }
              />
              <PaletteItem
                icon={<ArrowDownToLine />}
                label={t("gitRepo.palette.item.pullRebase")}
                onSelect={() =>
                  run(
                    t("gitRepo.palette.action.pullRebase"),
                    () => remotePull(path, remote, "rebase"),
                    {
                      marksFetched: true,
                    }
                  )
                }
              />
              <PaletteItem
                icon={<ArrowUpFromLine />}
                label={t("gitRepo.palette.item.push")}
                onSelect={() =>
                  run(t("gitRepo.palette.action.push"), () =>
                    remotePush(path, remote, null, false, false, true)
                  )
                }
              />
              {remotes.length > 1 &&
                remotes.map((r) => (
                  <PaletteItem
                    key={`pull-${r.name}`}
                    icon={<ArrowDownToLine />}
                    label={t("gitRepo.palette.item.pullFrom", { name: r.name })}
                    onSelect={() =>
                      run(
                        t("gitRepo.palette.item.pullFrom", { name: r.name }),
                        () => remotePull(path, r.name),
                        {
                          marksFetched: true,
                        }
                      )
                    }
                  />
                ))}
              {remotes.length > 1 &&
                remotes.map((r) => (
                  <PaletteItem
                    key={`push-${r.name}`}
                    icon={<ArrowUpFromLine />}
                    label={t("gitRepo.palette.item.pushTo", { name: r.name })}
                    onSelect={() =>
                      run(t("gitRepo.palette.item.pushTo", { name: r.name }), () =>
                        remotePush(
                          path,
                          r.name,
                          null,
                          false,
                          false,
                          pushSetsUpstream(headUpstream, r.name)
                        )
                      )
                    }
                  />
                ))}
              {(() => {
                const pickedRemote = pickRemote(remotes, headUpstream);
                const prUrl = currentPullRequestUrl(repo, pickedRemote?.url);
                const webUrl = pickedRemote ? remoteWebUrl(pickedRemote.url) : null;
                const forgeCurrent = forgeRepoPath !== null && forgeRepoPath === repo?.path;
                const inApp = forgeCurrent && forgeKind !== null && forgeAccount;
                return (
                  <>
                    {webUrl && (
                      <PaletteItem
                        icon={<Globe />}
                        label={
                          remotes.length > 1
                            ? t("gitRepo.palette.item.openRemoteInBrowser", {
                                name: pickedRemote?.name,
                              })
                            : t("gitRepo.palette.item.openInBrowser")
                        }
                        onSelect={() => {
                          close();
                          void openUrl(webUrl);
                        }}
                      />
                    )}
                    {prUrl && (
                      <PaletteItem
                        icon={<GitPullRequest />}
                        label={t("gitRepo.palette.item.createPr", {
                          noun: forgeNoun(forgeCurrent ? forgeKind : null),
                        })}
                        onSelect={() => {
                          close();
                          if (inApp) openDialog("createPullRequest");
                          else void openUrl(prUrl);
                        }}
                      />
                    )}
                  </>
                );
              })()}
              <PaletteItem
                icon={<RefreshCw />}
                label={
                  remotes.length > 1
                    ? t("gitRepo.palette.item.fetchAll")
                    : t("gitRepo.palette.item.fetch")
                }
                onSelect={() =>
                  run(t("gitRepo.palette.action.fetch"), async () => {
                    const result = await fetchRemotes(
                      remotes.map((r) => r.name),
                      (name) => remoteFetch(path, name, true, true)
                    );
                    const message = fetchResultMessage(result);
                    if (useRepo.getState().repo?.path === path) {
                      if (result.succeeded.length > 0) useRepo.getState().markFetched();
                      useRepo.getState().setFetchFailures(result.failed.map(({ name }) => name));
                    }
                    return {
                      status:
                        result.succeeded.length === 0
                          ? "failed"
                          : result.failed.length > 0
                            ? "partial"
                            : "ok",
                      message,
                    };
                  })
                }
              />
              <PaletteItem
                icon={<GitBranchPlus />}
                label={t("gitRepo.palette.item.createBranch")}
                onSelect={() => {
                  close();
                  openDialog("createBranch");
                }}
              />
              <PaletteItem
                icon={<FolderTree />}
                label={t("gitRepo.palette.item.newWorktree")}
                onSelect={() => {
                  close();
                  openDialog("createWorktree");
                }}
              />
              <PaletteItem
                icon={<TagIcon />}
                label={t("gitRepo.palette.item.createTag")}
                onSelect={() => {
                  close();
                  openDialog("createTag");
                }}
              />
              <PaletteItem
                icon={<Archive />}
                label={t("gitRepo.palette.item.stashChanges")}
                onSelect={() => {
                  close();
                  openDialog("createStash");
                }}
              />
              {stashes.length > 0 && (
                <PaletteItem
                  icon={<ArchiveRestore />}
                  label={t("gitRepo.palette.item.popLatest", { message: stashes[0].message })}
                  onSelect={() =>
                    run(t("gitRepo.palette.action.popStash"), () => stashPop(path, 0))
                  }
                />
              )}
              {nextUndo && (
                <PaletteItem
                  icon={<Undo2 />}
                  label={t("gitRepo.palette.item.undo", { label: nextUndo.label })}
                  shortcut="Z"
                  onSelect={() => runHistory("undo")}
                />
              )}
              {nextRedo && (
                <PaletteItem
                  icon={<Redo2 />}
                  label={t("gitRepo.palette.item.redo", { label: nextRedo.label })}
                  onSelect={() => runHistory("redo")}
                />
              )}
              <PaletteItem
                icon={<RefreshCw />}
                label={t("gitRepo.palette.item.refresh")}
                shortcut="R"
                onSelect={() => {
                  close();
                  void useRepo.getState().refresh();
                }}
              />
            </Command.Group>
            {repoState !== "clean" && (
              <Command.Group heading={t("gitRepo.palette.group.state")}>
                {repoState === "rebase" && (
                  <>
                    <PaletteItem
                      icon={<Redo2 />}
                      label={t("gitRepo.palette.item.continueRebase")}
                      onSelect={continueRebase}
                    />
                    <PaletteItem
                      icon={<Undo2 />}
                      label={t("gitRepo.palette.item.abortRebase")}
                      onSelect={abortRebase}
                    />
                  </>
                )}
                {repoState === "merge" && (
                  <PaletteItem
                    icon={<Undo2 />}
                    label={t("gitRepo.palette.item.abortMerge")}
                    onSelect={abortMerge}
                  />
                )}
                <PaletteItem
                  icon={<Check />}
                  label={t("gitRepo.palette.item.clearState")}
                  onSelect={clearState}
                />
              </Command.Group>
            )}
            <Command.Group heading={t("gitRepo.palette.group.repository")}>
              <PaletteItem
                icon={<FolderOpen />}
                label={t("gitRepo.palette.item.openRepository")}
                onSelect={openRepository}
              />
              <PaletteItem
                icon={<GitBranchPlus />}
                label={t("gitRepo.palette.item.cloneRepository")}
                onSelect={() => {
                  close();
                  openDialog("clone");
                }}
              />
              <PaletteItem
                icon={<FolderGit2 />}
                label={t("gitRepo.palette.item.closeRepository")}
                onSelect={() => {
                  close();
                  goToRepoHome(useRepo.getState().repo?.path);
                }}
              />
            </Command.Group>
            {worktrees.some((w) => !w.isCurrent && !w.isMissing) && (
              <Command.Group heading={t("gitRepo.palette.group.worktree")}>
                {worktrees
                  .filter((w) => !w.isCurrent && !w.isMissing)
                  .map((w) => (
                    <PaletteItem
                      key={w.path}
                      icon={<FolderTree />}
                      label={`${w.name}${w.branch ? ` · ${w.branch}` : ""}`}
                      onSelect={() => {
                        close();
                        activateTab(w.path);
                      }}
                    />
                  ))}
              </Command.Group>
            )}
            {groupSections.length > 0 && (
              <Command.Group heading={t("gitRepo.palette.group.repoGroups")}>
                {groupSections.map((section) => {
                  const paths = section.repos.map((r) => r.path);
                  return (
                    <PaletteItem
                      key={`open:${section.group.id}`}
                      icon={<Folders />}
                      label={t("gitRepo.palette.item.openGroup", { name: section.group.name })}
                      detail={t("gitRepo.palette.repositoryCount", { count: paths.length })}
                      keywords={[section.group.name, "group"]}
                      onSelect={() => {
                        close();
                        void openRepoGroup(section.group, paths);
                      }}
                    />
                  );
                })}
              </Command.Group>
            )}
            {otherRepos.length > 0 && (
              <Command.Group heading={t("gitRepo.palette.group.repos")}>
                {otherRepos.map((recent) => (
                  <PaletteItem
                    key={recent.path}
                    icon={<FolderGit2 />}
                    label={recent.name}
                    detail={groupNameOf(recent.path) ?? shortenHome(recent.path)}
                    keywords={groupNameOf(recent.path) ? [groupNameOf(recent.path)!] : undefined}
                    onSelect={() => {
                      close();
                      activateTab(recent.path);
                    }}
                  />
                ))}
              </Command.Group>
            )}
            <Command.Group heading={t("gitRepo.palette.group.branches")}>
              {visibleBranches.map((branch) => (
                <PaletteItem
                  key={branch.name}
                  icon={<Check />}
                  label={branch.name}
                  onSelect={() =>
                    run(t("gitRepo.palette.action.checkout", { name: branch.name }), () =>
                      useUndo.getState().tracked({
                        path,
                        kind: "checkout",
                        label: t("gitRepo.palette.action.checkout", { name: branch.name }),
                        action: () => branchCheckout(path, branch.name),
                      })
                    )
                  }
                />
              ))}
            </Command.Group>
            <Command.Group heading={t("gitRepo.palette.group.view")}>
              <PaletteItem
                icon={<PanelLeft />}
                label={
                  sidebarOpen
                    ? t("gitRepo.palette.item.hideSidebar")
                    : t("gitRepo.palette.item.showSidebar")
                }
                shortcut="B"
                onSelect={() => {
                  close();
                  toggleSidebar();
                }}
              />
              <PaletteItem
                icon={<Settings />}
                label={t("gitRepo.palette.item.settings")}
                shortcut=","
                onSelect={() => {
                  close();
                  openDialog("settings");
                }}
              />
              {repo && editor && (
                <PaletteItem
                  icon={<Code />}
                  label={t("gitRepo.palette.item.openInEditor", { editor: editor.label })}
                  onSelect={() => {
                    close();
                    void openInEditor(editor.id, repo.path);
                  }}
                />
              )}
            </Command.Group>
          </>
        )}
      </Command.List>
      <div className="border-border text-muted-foreground flex items-center gap-4 border-t px-3 py-1.5 text-[10px]">
        <span>{t("gitRepo.palette.footer.move")}</span>
        <span>{t("gitRepo.palette.footer.run")}</span>
        <span>
          {mode === "commands"
            ? t("gitRepo.palette.footer.close")
            : t("gitRepo.palette.footer.back")}
        </span>
      </div>
    </Command.Dialog>
  );
}

function PaletteItem({
  icon,
  label,
  detail,
  shortcut,
  keywords,
  onSelect,
}: {
  icon: ReactNode;
  label: string;
  detail?: string;
  shortcut?: string;
  keywords?: string[];
  onSelect: () => void;
}) {
  return (
    <Command.Item
      onSelect={onSelect}
      keywords={keywords}
      className="text-foreground data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground [&_svg]:text-muted-foreground flex cursor-default items-center gap-2.5 rounded-md px-2 py-2 text-sm select-none [&_svg]:size-4"
    >
      {icon}
      <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
        <span className="truncate">{label}</span>
        {detail && <span className="text-muted-foreground/70 shrink-0 text-xs">{detail}</span>}
      </span>
      {shortcut && (
        <span className="text-muted-foreground/70 flex items-center gap-0.5 text-[10px]">
          <span className="border-border rounded border px-1">{modKey()}</span>
          <span className="border-border rounded border px-1">{shortcut}</span>
        </span>
      )}
    </Command.Item>
  );
}
