import { useState } from "react";
import { open as pickDirectory } from "@tauri-apps/plugin-dialog";
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  Check,
  ChevronDown,
  Code,
  Command,
  FolderGit2,
  FolderOpen,
  GitBranchPlus,
  Home,
  Loader2,
  PanelLeft,
  Redo2,
  RefreshCw,
  Settings,
  SquareTerminal,
  Tag,
  Undo2,
  UserRound,
} from "lucide-react";
import { toast } from "sonner";
import { rebaseAbort, rebaseContinue, stateCleanup, stashPop } from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Hint, Kbd } from "@/features/git/diff/diff-ui";
import { useUndo } from "@/features/git/history/undoStore";
import { applyProfileToRepo, useIdentity } from "@/features/git/identity";
import { RemoteActions } from "@/features/git/remote";
import { abortMergeFlow } from "@/features/git/repository/merge";
import { activateTab, goToRepoHome } from "@/features/git/repository/tabs";
import { useRepo } from "@/features/git/repository-store";
import { useGitSettings } from "@/features/git/settings";
import { openInEditor, preferredEditor, useEditors } from "@/features/git/settings/editors";
import { toastOutcome } from "@/features/git/toast-outcome";
import { sidebarVisible, useUi } from "@/features/git/ui-store";
import { modKey, shortenHome } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

function RepoSwitcher() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const recents = useRepo((state) => state.recents);
  const loadRecents = useRepo((state) => state.loadRecents);
  const profileId = useRepo((state) => state.profileId);
  const setRepoSwitcherOpen = useUi((state) => state.setRepoSwitcherOpen);
  const openDialog = useUi((state) => state.openDialog);
  const profiles = useIdentity((state) => state.profiles);

  const assigned = profiles.find((profile) => profile.id === profileId) ?? null;

  const switchTo = (path: string) => {
    if (path === repo?.path) return;
    activateTab(path);
  };

  const openPicked = async () => {
    const dir = await pickDirectory({
      directory: true,
      title: t("gitRepo.shell.toolbar.openRepository"),
    });
    if (typeof dir === "string") switchTo(dir);
  };

  const assignProfile = (profile: (typeof profiles)[number]) => {
    if (!repo) return;
    void applyProfileToRepo(repo.path, profile)
      .then(() =>
        toast.success(t("gitRepo.shell.toolbar.profileApplied", { label: profile.label }))
      )
      .catch((error: unknown) =>
        toast.error((error as { message?: string })?.message ?? String(error))
      );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("gitRepo.shell.toolbar.switchRepository")}
          className="hover:bg-accent focus-visible:ring-ring/50 mx-1 flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          <FolderGit2 className="text-foreground size-4 shrink-0" />
          <span className="min-w-0">
            <span className="block truncate text-sm leading-4 font-medium">
              {repo?.name ?? t("gitRepo.shell.statusBar.noRepository")}
            </span>
            <span className="text-muted-foreground/70 block truncate text-[10px] leading-4">
              {repo?.isDetached
                ? t("gitRepo.shell.refs.detached")
                : (repo?.headBranch ?? t("gitRepo.shell.statusBar.noRepository"))}
              {repo?.isWorktree ? " · worktree" : ""}
              {assigned ? ` · ${assigned.label}` : ""}
            </span>
          </span>
          <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-72">
        {repo ? (
          <>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate font-medium">{repo.name}</span>
              <span className="text-muted-foreground/70 truncate font-mono text-[10px] font-normal">
                {shortenHome(repo.path)}
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        ) : null}
        {recents.slice(0, 6).map((recent) => (
          <DropdownMenuItem key={recent.path} onSelect={() => switchTo(recent.path)}>
            {recent.path === repo?.path ? <Check className="text-primary" /> : <FolderGit2 />}
            <span className="flex min-w-0 flex-col">
              <span className="truncate">{recent.name}</span>
              <span className="text-muted-foreground/70 truncate font-mono text-[10px]">
                {shortenHome(recent.path)}
              </span>
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onSelect={() => {
            void loadRecents();
            setRepoSwitcherOpen(true);
          }}
        >
          <FolderGit2 />
          {t("gitRepo.shell.toolbar.switchRepository")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void openPicked()}>
          <FolderOpen />
          {t("gitRepo.shell.toolbar.openRepository")}
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => openDialog("clone")}>
          <ArrowDownToLine />
          {t("gitRepo.shell.toolbar.cloneRepository")}
        </DropdownMenuItem>
        {repo && profiles.length > 0 ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>
                <UserRound />
                {t("gitRepo.shell.toolbar.profile")}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent>
                {profiles.map((profile) => (
                  <DropdownMenuCheckboxItem
                    key={profile.id}
                    checked={profile.id === profileId}
                    onSelect={() => assignProfile(profile)}
                  >
                    {profile.label}
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function StateActions() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const refresh = useRepo((state) => state.refresh);
  const [busy, setBusy] = useState(false);

  if (!repo || repo.state === "clean") return null;
  const state = repo.state;
  const label = t(`gitRepo.shell.state.${state}`);

  const run = async (op: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    try {
      const outcome = await op();
      toastOutcome(
        outcome as { status?: string; message?: string } | undefined,
        t("gitRepo.shell.toolbar.stateActions", { state: label })
      );
      await refresh();
    } catch (error) {
      toast.error((error as { message?: string })?.message ?? String(error));
    } finally {
      setBusy(false);
    }
  };

  const continueRebase = () => void run(() => rebaseContinue(repo.path));

  const abortRebase = async () => {
    const ok = await confirmDialog({
      title: t("gitRepo.shell.toolbar.abortRebaseTitle"),
      description: t("gitRepo.shell.toolbar.abortRebaseDescription"),
      confirmLabel: t("gitRepo.shell.toolbar.abortRebaseConfirm"),
      destructive: true,
    });
    if (ok) void run(() => rebaseAbort(repo.path));
  };

  const abortMerge = () => void abortMergeFlow(repo.path);

  const clearState = async () => {
    const ok = await confirmDialog({
      title: t("gitRepo.shell.toolbar.clearStateTitle"),
      description: t("gitRepo.shell.toolbar.clearStateDescription"),
      confirmLabel: t("gitRepo.shell.toolbar.clearStateConfirm"),
    });
    if (ok) void run(() => stateCleanup(repo.path));
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={t("gitRepo.shell.toolbar.stateActions", { state: label })}
          className="border-destructive/40 bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/40 flex items-center gap-1 rounded-md border px-2 py-1 font-mono text-[11px] transition-colors focus-visible:ring-2 focus-visible:outline-none"
        >
          {label}
          <ChevronDown className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuLabel>{label}</DropdownMenuLabel>
        {state === "rebase" ? (
          <>
            <DropdownMenuItem onSelect={continueRebase}>
              <Redo2 />
              {t("gitRepo.shell.toolbar.continueRebase")}
            </DropdownMenuItem>
            <DropdownMenuItem variant="destructive" onSelect={() => void abortRebase()}>
              <Undo2 />
              {t("gitRepo.shell.toolbar.abortRebase")}
            </DropdownMenuItem>
          </>
        ) : null}
        {state === "merge" ? (
          <DropdownMenuItem variant="destructive" onSelect={abortMerge}>
            <Undo2 />
            {t("gitRepo.shell.toolbar.abortMerge")}
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void clearState()}>
          <Check />
          {t("gitRepo.shell.toolbar.clearState")}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function UndoRedoButtons() {
  const { t } = useAppTranslation();
  const path = useRepo((state) => state.repo?.path ?? null);
  const refresh = useRepo((state) => state.refresh);
  const undoStack = useUndo((state) => state.undoStack);
  const redoStack = useUndo((state) => state.redoStack);

  if (!path) return null;

  const nextUndo = [...undoStack].reverse().find((entry) => entry.repoPath === path);
  const nextRedo = [...redoStack].reverse().find((entry) => entry.repoPath === path);

  const run = (direction: "undo" | "redo") => {
    const action = useUndo.getState()[direction];
    void action(path).then((ok) => {
      if (ok) void refresh();
    });
  };

  return (
    <>
      <Hint
        label={
          nextUndo
            ? t("gitRepo.shell.toolbar.undoTooltip", { label: nextUndo.label })
            : t("gitRepo.shell.toolbar.undo")
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.undo")}
          disabled={!nextUndo}
          onClick={() => run("undo")}
        >
          <Undo2 />
        </Button>
      </Hint>
      <Hint
        label={
          nextRedo
            ? t("gitRepo.shell.toolbar.redoTooltip", { label: nextRedo.label })
            : t("gitRepo.shell.toolbar.redo")
        }
      >
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.redo")}
          disabled={!nextRedo}
          onClick={() => run("redo")}
        >
          <Redo2 />
        </Button>
      </Hint>
    </>
  );
}

export function Toolbar({ className }: { className?: string }) {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const stashes = useRepo((state) => state.stashes);
  const busy = useRepo((state) => state.busy);
  const refresh = useRepo((state) => state.refresh);
  const showSidebar = useUi(sidebarVisible);
  const toggleSidebar = useUi((state) => state.toggleSidebar);
  const toggleTerminal = useUi((state) => state.toggleTerminal);
  const setPaletteOpen = useUi((state) => state.setPaletteOpen);
  const openDialog = useUi((state) => state.openDialog);
  const editorId = useGitSettings((state) => state.editorId);
  const { editors } = useEditors();
  const [spinning, setSpinning] = useState(false);

  const editor = preferredEditor(editors, editorId);
  const latestStash = stashes[0];

  const popStash = () => {
    if (!repo) return;
    useRepo.getState().setBusy(t("gitRepo.shell.toolbar.popStash"));
    void stashPop(repo.path, 0)
      .then(async () => {
        toast.success(t("gitRepo.shell.toolbar.popStash"));
        await useRepo.getState().refresh();
      })
      .catch((error: unknown) =>
        toast.error((error as { message?: string })?.message ?? String(error))
      )
      .finally(() => useRepo.getState().setBusy(null));
  };

  return (
    <header
      className={cn(
        "border-border bg-card flex h-12 shrink-0 items-center gap-1 border-b px-2",
        className
      )}
    >
      <Hint label={t("gitRepo.shell.toolbar.home")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.home")}
          onClick={() => goToRepoHome(repo?.path)}
        >
          <Home />
        </Button>
      </Hint>

      <Hint label={t("gitRepo.shell.toolbar.toggleSidebar")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.toggleSidebar")}
          onClick={toggleSidebar}
        >
          <PanelLeft className={cn(!showSidebar && "text-primary")} />
        </Button>
      </Hint>

      <RepoSwitcher />
      <StateActions />
      <UndoRedoButtons />

      <div className="bg-border mx-1 h-5 w-px shrink-0" />

      <RemoteActions />

      <div className="bg-border mx-1 h-5 w-px shrink-0" />

      <Hint label={t("gitRepo.shell.toolbar.createBranch")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.createBranch")}
          disabled={!repo || !!busy}
          onClick={() => openDialog("createBranch")}
        >
          <GitBranchPlus />
        </Button>
      </Hint>
      <Hint label={t("gitRepo.shell.toolbar.createTag")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.createTag")}
          disabled={!repo || !!busy}
          onClick={() => openDialog("createTag")}
        >
          <Tag />
        </Button>
      </Hint>
      <Hint label={t("gitRepo.shell.toolbar.stashChanges")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.stashChanges")}
          disabled={!repo || !!busy}
          onClick={() => openDialog("createStash")}
        >
          <Archive />
        </Button>
      </Hint>
      <Hint label={t("gitRepo.shell.toolbar.popStash")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.shell.toolbar.popStash")}
          disabled={!latestStash || !!busy}
          onClick={popStash}
        >
          <ArchiveRestore />
        </Button>
      </Hint>

      <div className="flex">
        <Hint
          label={
            editor
              ? `${t("gitRepo.shell.toolbar.openInEditor")} · ${editor.label}`
              : t("gitRepo.shell.toolbar.openInEditor")
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            className="rounded-r-none"
            aria-label={t("gitRepo.shell.toolbar.openInEditor")}
            disabled={!repo || !editor}
            onClick={() => {
              if (repo && editor) openInEditor(editor.id, repo.path);
            }}
          >
            <Code />
          </Button>
        </Hint>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-l-none px-0"
              aria-label={t("gitRepo.shell.toolbar.more")}
              disabled={!repo || editors.length === 0}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            {editors.map((candidate) => (
              <DropdownMenuItem
                key={candidate.id}
                onSelect={() => {
                  if (repo) openInEditor(candidate.id, repo.path);
                }}
              >
                {candidate.id === editor?.id ? <Check className="text-primary" /> : <Code />}
                {candidate.label}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="ml-auto flex items-center gap-1">
        {busy ? (
          <span className="text-muted-foreground mr-1 flex items-center gap-2 text-xs">
            <Loader2 className="size-3.5 animate-spin" />
            {busy}…
          </span>
        ) : null}

        <Hint
          label={
            <>
              {t("gitRepo.shell.toolbar.palette")} <Kbd>{modKey()}</Kbd>
              <Kbd>K</Kbd>
            </>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.shell.toolbar.palette")}
            onClick={() => setPaletteOpen(true)}
          >
            <Command />
          </Button>
        </Hint>
        <Hint
          label={
            <>
              {t("gitRepo.shell.toolbar.terminal")} <Kbd>{modKey()}</Kbd>
              <Kbd>`</Kbd>
            </>
          }
        >
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.shell.toolbar.terminal")}
            onClick={toggleTerminal}
          >
            <SquareTerminal />
          </Button>
        </Hint>
        <Hint label={t("gitRepo.shell.toolbar.refresh")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.shell.toolbar.refresh")}
            disabled={!repo || spinning}
            onClick={() => {
              setSpinning(true);
              void refresh().finally(() => setSpinning(false));
            }}
          >
            <RefreshCw className={cn(spinning && "animate-spin")} />
          </Button>
        </Hint>
        <Hint label={t("gitRepo.shell.toolbar.settings")}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t("gitRepo.shell.toolbar.settings")}
            onClick={() => openDialog("settings")}
          >
            <Settings />
          </Button>
        </Hint>
      </div>
    </header>
  );
}
