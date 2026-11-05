import { useState } from "react";
import { ArrowDownToLine, ArrowUpFromLine, ChevronDown, Pencil, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { remoteFetch, remotePull, remotePush } from "@/commands";
import { pickRemote, pushSetsUpstream } from "@/lib/git-core";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HelpTip } from "@/components/ui/help-tip";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { confirmDialog } from "@/components/confirm";
import { PushRejectedDialog } from "@/components/git/push-rejected-dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useRepo } from "@/features/git/repository-store";
import { fetchRemotes, fetchResultMessage } from "@/features/git/repository/fetchRemotes";
import { toastOutcome } from "@/features/git/toast-outcome";
import { ensureRepoProfile } from "@/features/git/identity";
import { capCount } from "@/features/git/utils";
import { useRemoteUi } from "./store";

function isNonFastForward(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === "non_fast_forward" || /non-fast-?forward/i.test(e?.message ?? "");
}

export function RemoteActions() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const remotes = useRepo((state) => state.remotes);
  const branches = useRepo((state) => state.branches);
  const status = useRepo((state) => state.status);
  const busy = useRepo((state) => state.busy);
  const setBusy = useRepo((state) => state.setBusy);
  const markFetched = useRepo((state) => state.markFetched);
  const setFetchFailures = useRepo((state) => state.setFetchFailures);
  const openEditRemote = useRemoteUi((state) => state.openEditRemote);
  const [pushRejected, setPushRejected] = useState(false);

  const headUpstream =
    branches.find((branch) => !branch.isRemote && branch.isHead)?.upstream ?? null;
  const remote = pickRemote(remotes, headUpstream)?.name ?? "origin";

  const fetchLabel = t("gitRepo.remote.actions.labels.fetch");
  const pullLabel = t("gitRepo.remote.actions.labels.pull");
  const pushLabel = t("gitRepo.remote.actions.labels.push");

  const run = async (label: string, op: () => Promise<unknown>) => {
    if (busy || !repo) return;
    const repoPath = repo.path;
    setBusy(label);
    try {
      const outcome = await op();
      if (label === pullLabel && useRepo.getState().repo?.path === repoPath) markFetched();
      toastOutcome(
        outcome as { status?: string; message?: string } | undefined,
        t("gitRepo.remote.actions.complete", { label })
      );
      await useRepo.getState().refresh();
    } catch (error) {
      if (label === pushLabel && isNonFastForward(error)) {
        setPushRejected(true);
        return;
      }
      toast.error(
        t("gitRepo.remote.actions.failed", {
          label,
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(null);
    }
  };

  const runPush = async (label: string, op: () => Promise<unknown>) => {
    if (busy || !repo) return;
    await ensureRepoProfile(repo.path);
    await run(label, op);
    void import("@/features/git/forge/store").then(({ useForge }) =>
      useForge.getState().load(true)
    );
  };

  const confirmForcePush = async () => {
    if (!repo) return;
    const branch = repo.headBranch ?? t("gitRepo.remote.actions.currentBranch");
    const ok = await confirmDialog({
      title: t("gitRepo.remote.actions.forcePushConfirm.title"),
      description: t("gitRepo.remote.actions.forcePushConfirm.description", { remote, branch }),
      confirmLabel: t("gitRepo.remote.actions.forcePushConfirm.confirm"),
      destructive: true,
    });
    if (ok)
      void runPush(t("gitRepo.remote.actions.labels.pushForce"), () =>
        remotePush(repo.path, remote, null, true, false, true)
      );
  };

  const fetchHint =
    remotes.length === 0
      ? t("gitRepo.remote.actions.fetchHint.none")
      : remotes.length > 1
        ? t("gitRepo.remote.actions.fetchHint.all", {
            remotes: remotes.map((r) => r.name).join(", "),
          })
        : t("gitRepo.remote.actions.fetchHint.one", { remote });

  const pullHint =
    status && status.behind > 0
      ? t("gitRepo.remote.actions.pullHintBehind", { remote, count: status.behind })
      : t("gitRepo.remote.actions.pullHint", { remote });

  const pushHint =
    status && status.ahead > 0
      ? t("gitRepo.remote.actions.pushHintAhead", { remote, count: status.ahead })
      : t("gitRepo.remote.actions.pushHint", { remote });

  if (!repo) return null;

  return (
    <div className="flex items-center gap-1">
      <HelpTip title={fetchHint}>
        <Button
          variant="secondary"
          size="sm"
          disabled={!!busy || remotes.length === 0}
          onClick={() =>
            void run(fetchLabel, async () => {
              const result = await fetchRemotes(
                remotes.map((r) => r.name),
                (name) => remoteFetch(repo.path, name, true, true)
              );
              const message = fetchResultMessage(result);
              if (useRepo.getState().repo?.path === repo.path) {
                if (result.succeeded.length > 0) markFetched();
                setFetchFailures(result.failed.map(({ name }) => name));
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
        >
          <RefreshCw className={busy === fetchLabel ? "animate-spin" : ""} />
          {fetchLabel}
        </Button>
      </HelpTip>

      <div className="flex">
        <HelpTip title={pullHint}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-r-none"
            disabled={!!busy || remotes.length === 0}
            onClick={() => void run(pullLabel, () => remotePull(repo.path, remote))}
          >
            <ArrowDownToLine />
            {pullLabel}
            {status && status.behind > 0 && <Badge>{capCount(status.behind)}</Badge>}
          </Button>
        </HelpTip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-l-none"
              aria-label={t("gitRepo.remote.actions.pullOptions")}
              disabled={!!busy || remotes.length === 0}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem
              onSelect={() =>
                void run(t("gitRepo.remote.actions.labels.pullMerge"), () =>
                  remotePull(repo.path, remote, "merge")
                )
              }
            >
              {t("gitRepo.remote.actions.pullMerge")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void run(t("gitRepo.remote.actions.labels.pullRebase"), () =>
                  remotePull(repo.path, remote, "rebase")
                )
              }
            >
              {t("gitRepo.remote.actions.pullRebase")}
            </DropdownMenuItem>
            {remotes.length > 1 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("gitRepo.remote.actions.pullFrom")}</DropdownMenuLabel>
                {remotes.map((r) => (
                  <DropdownMenuCheckboxItem
                    key={r.name}
                    checked={r.name === remote}
                    onSelect={() =>
                      void run(
                        t("gitRepo.remote.actions.labels.pullFromRemote", { remote: r.name }),
                        () => remotePull(repo.path, r.name)
                      )
                    }
                  >
                    {r.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="flex">
        <HelpTip title={pushHint}>
          <Button
            variant="secondary"
            size="sm"
            className="rounded-r-none"
            disabled={!!busy || remotes.length === 0}
            onClick={() =>
              void runPush(pushLabel, () => remotePush(repo.path, remote, null, false, false, true))
            }
          >
            <ArrowUpFromLine />
            {pushLabel}
            {status && status.ahead > 0 && <Badge>{capCount(status.ahead)}</Badge>}
          </Button>
        </HelpTip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              className="rounded-l-none"
              aria-label={t("gitRepo.remote.actions.pushOptions")}
              disabled={!!busy || remotes.length === 0}
            >
              <ChevronDown />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuItem variant="destructive" onSelect={() => void confirmForcePush()}>
              {t("gitRepo.remote.actions.forcePush")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                void runPush(t("gitRepo.remote.actions.labels.pushWithTags"), () =>
                  remotePush(repo.path, remote, null, false, true, true)
                )
              }
            >
              {t("gitRepo.remote.actions.pushWithTags")}
            </DropdownMenuItem>
            {remotes.length > 1 && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel>{t("gitRepo.remote.actions.pushTo")}</DropdownMenuLabel>
                {remotes.map((r) => (
                  <DropdownMenuCheckboxItem
                    key={r.name}
                    checked={r.name === remote}
                    onSelect={() =>
                      void runPush(
                        t("gitRepo.remote.actions.labels.pushToRemote", { remote: r.name }),
                        () =>
                          remotePush(
                            repo.path,
                            r.name,
                            null,
                            false,
                            false,
                            pushSetsUpstream(headUpstream, r.name)
                          )
                      )
                    }
                  >
                    {r.name}
                  </DropdownMenuCheckboxItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                void run(t("gitRepo.remote.actions.labels.fetchTags"), () =>
                  remoteFetch(repo.path, remote, true, false)
                )
              }
            >
              {t("gitRepo.remote.actions.fetchTags")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <HelpTip title={t("gitRepo.remote.actions.editRemoteHint")}>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("gitRepo.remote.actions.editRemote")}
          disabled={!!busy || remotes.length === 0}
          onClick={() => {
            const current = remotes.find((r) => r.name === remote);
            if (current)
              openEditRemote({ original: current.name, name: current.name, url: current.url });
          }}
        >
          <Pencil />
        </Button>
      </HelpTip>

      <PushRejectedDialog
        open={pushRejected}
        remote={remote}
        branch={repo?.headBranch ?? null}
        onClose={() => setPushRejected(false)}
        onPullRebase={() => {
          setPushRejected(false);
          if (repo)
            void run(t("gitRepo.remote.actions.labels.pullRebase"), () =>
              remotePull(repo.path, remote, "rebase")
            );
        }}
        onForcePush={() => {
          setPushRejected(false);
          if (repo)
            void runPush(t("gitRepo.remote.actions.labels.pushForce"), () =>
              remotePush(repo.path, remote, null, true, false, true)
            );
        }}
      />
    </div>
  );
}
