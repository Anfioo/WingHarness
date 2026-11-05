import { useCallback, useState } from "react";
import type { ReactNode } from "react";
import { toast } from "sonner";
import { Check, Diff, GitMerge, MoreHorizontal, Plus, Undo2, UserRoundSearch } from "lucide-react";
import { deleteUnversioned, revealWorkspaceFile, svnAdd, svnResolve, svnRevert } from "@/commands";
import { writeClipboardText } from "@/lib/svn-core/clipboard";
import type { SvnStatus } from "@/lib/svn-core/types";
import { confirmDialog } from "@/components/confirm";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";

/** The strategies the engine's `svn_resolve` expects. */
export const RESOLVE_STRATEGIES = ["working", "mine-full", "theirs-full"] as const;

export interface ChangeActions {
  busy: boolean;
  disabled: boolean;
  diff: (path: string) => void;
  blame: (path: string) => void;
  add: (path: string) => void;
  remove: (path: string) => void;
  revert: (path: string) => void;
  resolve: (path: string, strategy: string) => void;
  reveal: (path: string) => void;
  copy: (path: string, absolute: boolean) => void;
}

export function isUnversioned(entry: SvnStatus): boolean {
  return entry.statusCode === "unversioned";
}

export function isConflicted(entry: SvnStatus): boolean {
  return entry.statusCode === "conflicted" || entry.propStatus === "conflicted";
}

function joinWorkspacePath(workspacePath: string, filePath: string): string {
  if (/^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.startsWith("/")) {
    return filePath;
  }
  const separator = workspacePath.includes("\\") ? "\\" : "/";
  return `${workspacePath.replace(/[\\/]+$/, "")}${separator}${filePath.replace(/^[\\/]+/, "")}`;
}

/**
 * The working-copy mutations the changes list can run. Every mutation goes
 * through the Rust command and then `refreshStatusAfterMutation()`, so the list
 * is never left showing a state the engine has already moved past.
 */
export function useChangeActions(): ChangeActions {
  const { t } = useAppTranslation();
  const workspacePath = useSvnWorkspaceStore((s) => s.workspacePath);
  const statusIsStale = useSvnWorkspaceStore((s) => s.statusIsStale);
  const openDiff = useSvnWorkspaceStore((s) => s.openDiff);
  const openBlame = useSvnWorkspaceStore((s) => s.openBlame);
  const { refreshStatusAfterMutation } = useSvnWorkspace();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (successKey: string, fn: () => Promise<unknown>) => {
      if (!workspacePath) return;
      setBusy(true);
      try {
        await fn();
        await refreshStatusAfterMutation();
        toast.success(t(successKey));
      } catch (err) {
        toast.error(t("svnWorkspace.changes.toast.failed", { error: String(err) }));
      } finally {
        setBusy(false);
      }
    },
    [workspacePath, refreshStatusAfterMutation, t]
  );

  const add = useCallback(
    (path: string) => {
      if (!workspacePath) return;
      void run("svnWorkspace.changes.toast.added", () => svnAdd(workspacePath, [path]));
    },
    [run, workspacePath]
  );

  const remove = useCallback(
    async (path: string) => {
      if (!workspacePath) return;
      const ok = await confirmDialog({
        title: t("svnWorkspace.changes.confirm.deleteTitle"),
        description: t("svnWorkspace.changes.confirm.deleteDescription"),
        path: joinWorkspacePath(workspacePath, path),
        confirmLabel: t("svnWorkspace.changes.actions.delete"),
        destructive: true,
      });
      if (!ok) return;
      void run("svnWorkspace.changes.toast.deleted", () =>
        deleteUnversioned(workspacePath, [path])
      );
    },
    [run, workspacePath, t]
  );

  const revert = useCallback(
    async (path: string) => {
      if (!workspacePath) return;
      const ok = await confirmDialog({
        title: t("svnWorkspace.changes.confirm.revertTitle"),
        description: t("svnWorkspace.changes.confirm.revertDescription"),
        path: joinWorkspacePath(workspacePath, path),
        confirmLabel: t("svnWorkspace.changes.actions.revert"),
        destructive: true,
      });
      if (!ok) return;
      void run("svnWorkspace.changes.toast.reverted", () => svnRevert(workspacePath, [path]));
    },
    [run, workspacePath, t]
  );

  const resolve = useCallback(
    (path: string, strategy: string) => {
      if (!workspacePath) return;
      void run("svnWorkspace.changes.toast.resolved", () =>
        svnResolve(workspacePath, [path], strategy)
      );
    },
    [run, workspacePath]
  );

  const reveal = useCallback(
    (path: string) => {
      if (!workspacePath) return;
      void revealWorkspaceFile(workspacePath, path).catch((err) =>
        toast.error(t("svnWorkspace.changes.toast.failed", { error: String(err) }))
      );
    },
    [workspacePath, t]
  );

  const copy = useCallback(
    async (path: string, absolute: boolean) => {
      if (!workspacePath) return;
      const value = absolute ? joinWorkspacePath(workspacePath, path) : path;
      try {
        await writeClipboardText(value);
        toast.success(t("svnWorkspace.changes.toast.pathCopied"));
      } catch {
        toast.error(t("svnWorkspace.changes.toast.copyFailed"));
      }
    },
    [workspacePath, t]
  );

  const diff = useCallback((path: string) => openDiff({ path }), [openDiff]);
  const blame = useCallback((path: string) => openBlame(path), [openBlame]);

  return {
    busy,
    disabled: busy || statusIsStale,
    diff,
    blame,
    add,
    remove,
    revert,
    resolve,
    reveal,
    copy,
  };
}

export function resolveStrategyKey(strategy: string): string {
  switch (strategy) {
    case "mine-full":
      return "svnWorkspace.changes.resolve.mine";
    case "theirs-full":
      return "svnWorkspace.changes.resolve.theirs";
    default:
      return "svnWorkspace.changes.resolve.working";
  }
}

function Hint({ label, children }: { label: string; children: ReactNode }) {
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>{children}</TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

/** The inline hover actions: diff, blame, and the file's primary mutation. */
export function RowActionButtons({ entry, actions }: { entry: SvnStatus; actions: ChangeActions }) {
  const { t } = useAppTranslation();
  const unversioned = isUnversioned(entry);
  const conflicted = isConflicted(entry);

  return (
    <>
      <Hint label={t("svnWorkspace.changes.actions.diff")}>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("svnWorkspace.changes.actions.diff")}
          onClick={(event) => {
            event.stopPropagation();
            actions.diff(entry.path);
          }}
        >
          <Diff className="size-3" />
        </Button>
      </Hint>
      {!unversioned ? (
        <Hint label={t("svnWorkspace.changes.actions.blame")}>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("svnWorkspace.changes.actions.blame")}
            onClick={(event) => {
              event.stopPropagation();
              actions.blame(entry.path);
            }}
          >
            <UserRoundSearch className="size-3" />
          </Button>
        </Hint>
      ) : null}
      {unversioned ? (
        <Hint label={t("svnWorkspace.changes.actions.add")}>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={actions.disabled}
            aria-label={t("svnWorkspace.changes.actions.add")}
            onClick={(event) => {
              event.stopPropagation();
              actions.add(entry.path);
            }}
          >
            <Plus className="size-3" />
          </Button>
        </Hint>
      ) : conflicted ? (
        <DropdownMenu>
          <Hint label={t("svnWorkspace.changes.actions.resolve")}>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-xs"
                disabled={actions.disabled}
                aria-label={t("svnWorkspace.changes.actions.resolve")}
                onClick={(event) => event.stopPropagation()}
              >
                <GitMerge className="size-3" />
              </Button>
            </DropdownMenuTrigger>
          </Hint>
          <DropdownMenuContent align="end" onClick={(event) => event.stopPropagation()}>
            <DropdownMenuLabel>{t("svnWorkspace.changes.actions.resolve")}</DropdownMenuLabel>
            <DropdownMenuSeparator />
            {RESOLVE_STRATEGIES.map((strategy) => (
              <DropdownMenuItem
                key={strategy}
                onSelect={() => actions.resolve(entry.path, strategy)}
              >
                {t(resolveStrategyKey(strategy))}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Hint label={t("svnWorkspace.changes.actions.revert")}>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={actions.disabled}
            aria-label={t("svnWorkspace.changes.actions.revert")}
            onClick={(event) => {
              event.stopPropagation();
              actions.revert(entry.path);
            }}
          >
            <Undo2 className="size-3" />
          </Button>
        </Hint>
      )}
    </>
  );
}

/** The full action set for a file, shared by the overflow menu and right-click. */
export function ChangeActionItems({
  entry,
  actions,
  onDone,
}: {
  entry: SvnStatus;
  actions: ChangeActions;
  onDone: () => void;
}) {
  const { t } = useAppTranslation();
  const unversioned = isUnversioned(entry);
  const conflicted = isConflicted(entry);

  const item = (label: string, icon: ReactNode, run: () => void, destructive = false) => (
    <button
      type="button"
      className={
        destructive
          ? "text-destructive hover:bg-destructive/10 flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs"
          : "text-popover-foreground hover:bg-accent flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-xs"
      }
      onClick={() => {
        onDone();
        run();
      }}
    >
      <span className="text-muted-foreground">{icon}</span>
      {label}
    </button>
  );

  return (
    <div className="w-56 p-1">
      {item(t("svnWorkspace.changes.actions.diff"), <Diff className="size-3.5" />, () =>
        actions.diff(entry.path)
      )}
      {!unversioned
        ? item(
            t("svnWorkspace.changes.actions.blame"),
            <UserRoundSearch className="size-3.5" />,
            () => actions.blame(entry.path)
          )
        : null}
      {unversioned
        ? item(t("svnWorkspace.changes.actions.add"), <Plus className="size-3.5" />, () =>
            actions.add(entry.path)
          )
        : null}
      {unversioned
        ? item(
            t("svnWorkspace.changes.actions.delete"),
            <MoreHorizontal className="size-3.5" />,
            () => void actions.remove(entry.path),
            true
          )
        : null}
      {!unversioned && !conflicted
        ? item(
            t("svnWorkspace.changes.actions.revert"),
            <Undo2 className="size-3.5" />,
            () => void actions.revert(entry.path),
            true
          )
        : null}
      {conflicted
        ? RESOLVE_STRATEGIES.map((strategy) =>
            item(
              `${t("svnWorkspace.changes.actions.resolve")}: ${t(resolveStrategyKey(strategy))}`,
              <Check className="size-3.5" />,
              () => actions.resolve(entry.path, strategy)
            )
          )
        : null}
      <div className="bg-border my-1 h-px" />
      {item(t("svnWorkspace.changes.actions.reveal"), <Diff className="size-3.5" />, () =>
        actions.reveal(entry.path)
      )}
      {item(
        t("svnWorkspace.changes.actions.copyPath"),
        <Plus className="size-3.5" />,
        () => void actions.copy(entry.path, false)
      )}
      {item(
        t("svnWorkspace.changes.actions.copyAbsolutePath"),
        <Plus className="size-3.5" />,
        () => void actions.copy(entry.path, true)
      )}
    </div>
  );
}
