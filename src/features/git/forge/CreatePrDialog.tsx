import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  ArrowRight,
  Check,
  GitPullRequest,
  Info,
  Loader2,
  Users,
} from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";
import {
  defaultForgeTarget,
  forgeNoun,
  forgeTargets,
  sameForgeRepo,
  type ForgeUser,
} from "@/lib/git-core/forge";
import { accountList, remotePush } from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { forgeProviderFor, useForge } from "./store";

const TRUNK_BRANCHES = new Set([
  "main",
  "master",
  "develop",
  "dev",
  "trunk",
  "release",
  "staging",
  "production",
]);

function titleFromBranch(branch: string): string {
  if (!branch || TRUNK_BRANCHES.has(branch.toLowerCase())) return "";
  const leaf = branch.split("/").pop() ?? branch;
  const words = leaf.replace(/[-_]+/g, " ").trim();
  if (!words) return branch;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function Checkbox({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (value: boolean) => void;
}) {
  return (
    <CheckboxPrimitive.Root
      checked={checked}
      onCheckedChange={(value) => onCheckedChange(value === true)}
      className="border-border focus-visible:ring-ring/50 data-[state=checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground flex size-4 shrink-0 items-center justify-center rounded-sm border transition-colors outline-none focus-visible:ring-[3px]"
    >
      <CheckboxPrimitive.Indicator>
        <Check className="size-3.5" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
}

function DialogNote({ tone, children }: { tone: "info" | "attention"; children: ReactNode }) {
  const Icon = tone === "info" ? Info : AlertTriangle;
  return (
    <div className="bg-muted/70 text-muted-foreground flex items-start gap-2 rounded-md px-3 py-2 text-xs">
      <Icon
        className={cn("mt-px size-3.5 shrink-0", tone === "info" ? "text-info" : "text-primary")}
      />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{children}</span>
    </div>
  );
}

interface DialogMeta {
  defaultBranch: string | null;
  users: ForgeUser[] | null;
}

const dialogMetaCache = new Map<string, DialogMeta>();

export function CreatePrDialog() {
  const { t } = useAppTranslation();
  const open = useUi((state) => state.dialog === "createPullRequest");
  const closeDialog = useUi((state) => state.closeDialog);
  const repo = useRepo((state) => state.repo);
  const remotes = useRepo((state) => state.remotes);
  const branches = useRepo((state) => state.branches);
  const remote = useForge((state) => state.remote);
  const remoteName = useForge((state) => state.remoteName);

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [base, setBase] = useState("");
  const [draft, setDraft] = useState(false);
  const [candidates, setCandidates] = useState<ForgeUser[]>([]);
  const [candidatesLoading, setCandidatesLoading] = useState(false);
  const [reviewers, setReviewers] = useState<string[]>([]);
  const [defaultBranchName, setDefaultBranchName] = useState<string | null>(null);
  const [accountUsername, setAccountUsername] = useState<string | null>(null);
  const [accountLookupFailed, setAccountLookupFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [targetName, setTargetName] = useState<string | null>(null);
  const baseTouched = useRef(false);

  const path = repo?.path ?? "";
  const source = repo?.headBranch ?? "";
  const sourceName = remoteName ?? "origin";

  const targets = useMemo(() => (remote ? forgeTargets(remotes, remote) : []), [remotes, remote]);
  const activeTargetName =
    targetName ?? (remote ? defaultForgeTarget(targets, sourceName) : sourceName);
  const targetRemote = targets.find((target) => target.name === activeTargetName)?.remote ?? remote;
  const crossRepo = !!remote && !!targetRemote && !sameForgeRepo(remote, targetRemote);
  const provider = useMemo(
    () => (targetRemote && path ? forgeProviderFor(path, targetRemote) : null),
    [targetRemote, path]
  );
  const noun = forgeNoun(provider?.kind ?? null);

  const remotePrefix = `${activeTargetName}/`;
  const baseOptions = useMemo(() => {
    const names = branches
      .filter((branch) => branch.isRemote && branch.name.startsWith(remotePrefix))
      .map((branch) => branch.name.slice(remotePrefix.length))
      .filter((name) => name && name !== source && name !== "HEAD");
    return [...new Set(names)].sort();
  }, [branches, remotePrefix, source]);

  const head = branches.find((branch) => !branch.isRemote && branch.isHead);
  const notPushed = !head?.upstream;
  const unpushed = head?.ahead ?? 0;

  useEffect(() => {
    if (!open) return;
    setTitle(titleFromBranch(source));
    setBody("");
    setDraft(false);
    setError(null);
    setSubmitting(false);
    setPushing(false);
    setTargetName(null);
  }, [open, source]);

  useEffect(() => {
    baseTouched.current = false;
    setBase("");
    setReviewers([]);
    const key = targetRemote ? `${path}|${targetRemote.webUrl}` : "";
    const cached = key ? dialogMetaCache.get(key) : undefined;
    setDefaultBranchName(cached?.defaultBranch ?? null);
    setCandidates(cached?.users ?? []);
    setCandidatesLoading(!!key && !cached?.users);
    setAccountLookupFailed(false);

    let cancelled = false;
    accountList()
      .then((accounts) => {
        const host = remote?.host.toLowerCase().split(":")[0];
        const match = accounts.find((account) => account.host.toLowerCase().split(":")[0] === host);
        if (!cancelled) setAccountUsername(match?.username ?? null);
      })
      .catch(() => {
        if (!cancelled) {
          setAccountUsername(null);
          setAccountLookupFailed(true);
        }
      });

    if (open && provider && key) {
      const meta = dialogMetaCache.get(key);
      if (meta?.defaultBranch == null) {
        provider
          .defaultBranch()
          .then((branch) => {
            const prev = dialogMetaCache.get(key) ?? { defaultBranch: null, users: null };
            dialogMetaCache.set(key, { ...prev, defaultBranch: branch });
            if (!cancelled) setDefaultBranchName(branch);
          })
          .catch(() => {});
      }
      if (meta?.users == null) {
        provider
          .listReviewerCandidates()
          .then((users) => {
            const prev = dialogMetaCache.get(key) ?? { defaultBranch: null, users: null };
            dialogMetaCache.set(key, { ...prev, users });
            if (!cancelled) {
              setCandidates(users);
              setCandidatesLoading(false);
            }
          })
          .catch(() => {
            if (!cancelled) setCandidatesLoading(false);
          });
      }
    }

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, provider, remote?.host, path, targetRemote?.webUrl]);

  useEffect(() => {
    if (!open || baseTouched.current || baseOptions.length === 0) return;
    const preferred = baseOptions.includes(defaultBranchName ?? "")
      ? (defaultBranchName as string)
      : baseOptions.includes("main")
        ? "main"
        : baseOptions.includes("master")
          ? "master"
          : baseOptions[0];
    if (preferred !== base) setBase(preferred);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, baseOptions, defaultBranchName]);

  const visibleCandidates = useMemo(() => {
    if (!accountUsername) return candidates;
    return candidates.filter(
      (user) => user.username.toLowerCase() !== accountUsername.toLowerCase()
    );
  }, [candidates, accountUsername]);

  async function pushBranch() {
    if (!repo || !head || pushing) return;
    setPushing(true);
    setError(null);
    try {
      const outcome = await remotePush(repo.path, sourceName, head.name, false, false, true);
      toast.success(
        outcome.message || t("gitRepo.forge.pushed", { branch: head.name, remote: sourceName })
      );
      await useRepo.getState().refresh();
    } catch (err) {
      setError(
        t("gitRepo.forge.pushFailed", {
          branch: head.name,
          error: (err as { message?: string })?.message ?? String(err),
        })
      );
    } finally {
      setPushing(false);
    }
  }

  async function submit() {
    if (!provider || !title.trim() || !base || !source || notPushed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const pr = await provider.createPullRequest({
        title: title.trim(),
        body,
        sourceBranch: source,
        targetBranch: base,
        draft,
        reviewerIds: reviewers,
        ...(crossRepo && remote ? { sourceRepo: { owner: remote.owner, repo: remote.repo } } : {}),
      });
      closeDialog();
      toast.success(
        t("gitRepo.forge.created", { provider: provider.label, noun, number: pr.number }),
        {
          action: { label: t("gitRepo.forge.open"), onClick: () => void openUrl(pr.url) },
        }
      );
      void useForge.getState().load(true);
    } catch (err) {
      setError((err as { message?: string }).message ?? String(err));
      setSubmitting(false);
    }
  }

  if (!provider) return null;

  return (
    <Dialog open={open} onOpenChange={(next) => !next && closeDialog()}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="text-primary size-4" />
            {t("gitRepo.forge.title", { noun })}
          </DialogTitle>
          <DialogDescription>
            {crossRepo && remote && targetRemote
              ? t("gitRepo.forge.descriptionCrossRepo", {
                  noun,
                  source: `${remote.owner}/${remote.repo}`,
                  target: `${targetRemote.owner}/${targetRemote.repo}`,
                  provider: provider.label,
                })
              : t("gitRepo.forge.description", { noun, provider: provider.label })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          {targets.length > 1 && (
            <div className="flex items-center gap-2">
              <span className="text-muted-foreground text-xs">
                {t("gitRepo.forge.intoRepository")}
              </span>
              <Select
                value={activeTargetName}
                onValueChange={(value) => {
                  setTargetName(value);
                  baseTouched.current = false;
                }}
              >
                <SelectTrigger
                  className="h-8 flex-1"
                  aria-label={t("gitRepo.forge.targetRepository")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((target) => (
                    <SelectItem key={target.name} value={target.name}>
                      <span className="font-mono">{target.name}</span>
                      <span className="text-muted-foreground/70 ml-2 text-[10px]">
                        {target.remote.owner}/{target.remote.repo}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="max-w-56 min-w-0">
              <span className="truncate">{source}</span>
            </Badge>
            <ArrowRight className="text-muted-foreground/70 size-3.5 shrink-0" />
            <Select
              value={base}
              onValueChange={(value) => {
                baseTouched.current = true;
                setBase(value);
              }}
            >
              <SelectTrigger className="h-8 flex-1">
                <SelectValue placeholder={t("gitRepo.forge.targetBranch")} />
              </SelectTrigger>
              <SelectContent>
                {baseOptions.map((name) => (
                  <SelectItem key={name} value={name} className="font-mono">
                    {name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <Input
            autoFocus
            placeholder={t("gitRepo.forge.titlePlaceholder")}
            value={title}
            onChange={(event) => setTitle(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submit()}
          />

          <Textarea
            placeholder={t("gitRepo.forge.descriptionPlaceholder")}
            value={body}
            onChange={(event) => setBody(event.target.value)}
            className="min-h-32 font-mono text-xs"
          />

          <div className="flex items-center gap-2">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="secondary" size="sm" className="shrink-0">
                  <Users />
                  {reviewers.length > 0
                    ? t("gitRepo.forge.reviewers", { count: reviewers.length })
                    : t("gitRepo.forge.addReviewers")}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="max-h-64 w-72 overflow-y-auto">
                {candidatesLoading ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    {t("gitRepo.forge.loadingReviewers")}
                  </div>
                ) : visibleCandidates.length === 0 ? (
                  <div className="text-muted-foreground px-2 py-1.5 text-xs">
                    {accountLookupFailed
                      ? t("gitRepo.forge.reviewersFailed")
                      : t("gitRepo.forge.noReviewers")}
                  </div>
                ) : (
                  visibleCandidates.map((user) => (
                    <DropdownMenuCheckboxItem
                      key={user.id}
                      checked={reviewers.includes(user.id)}
                      onCheckedChange={(checked) =>
                        setReviewers((prev) =>
                          checked ? [...prev, user.id] : prev.filter((id) => id !== user.id)
                        )
                      }
                      onSelect={(event) => event.preventDefault()}
                    >
                      <span className="flex min-w-0 items-center gap-2">
                        {user.avatarUrl ? (
                          <img
                            src={user.avatarUrl}
                            alt=""
                            className="size-4 shrink-0 rounded-full"
                          />
                        ) : null}
                        <span className="truncate">{user.name}</span>
                        <span className="text-muted-foreground/70">@{user.username}</span>
                      </span>
                    </DropdownMenuCheckboxItem>
                  ))
                )}
              </DropdownMenuContent>
            </DropdownMenu>
            <span className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {reviewers.length > 0
                ? candidates
                    .filter((user) => reviewers.includes(user.id))
                    .map((user) => user.name)
                    .join(", ")
                : t("gitRepo.forge.optional")}
            </span>
          </div>

          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={draft} onCheckedChange={setDraft} />
            {t("gitRepo.forge.createAsDraft")}
          </label>

          {baseOptions.length === 0 && (
            <DialogNote tone="info">
              {t("gitRepo.forge.noBranches", { name: activeTargetName })}
            </DialogNote>
          )}

          {notPushed && (
            <DialogNote tone="attention">
              <span className="flex flex-wrap items-center justify-between gap-2">
                <span>{t("gitRepo.forge.notPushed", { branch: head?.name ?? source })}</span>
                <Button
                  size="sm"
                  variant="secondary"
                  className="shrink-0"
                  disabled={pushing || !head}
                  onClick={pushBranch}
                >
                  {pushing && <Loader2 className="size-3 animate-spin" />}
                  {t("gitRepo.forge.pushBranch", {
                    branch: head?.name ?? "branch",
                    remote: sourceName,
                  })}
                </Button>
              </span>
            </DialogNote>
          )}

          {!notPushed && unpushed > 0 && (
            <DialogNote tone="attention">
              {t("gitRepo.forge.unpushed", { count: unpushed, noun })}
            </DialogNote>
          )}

          {error && <p className="text-destructive text-xs [overflow-wrap:anywhere]">{error}</p>}
        </div>

        <DialogFooter>
          <Button variant="secondary" onClick={closeDialog}>
            {t("gitRepo.forge.cancel")}
          </Button>
          <Button
            disabled={!title.trim() || !base || !source || notPushed || submitting}
            className={cn(submitting && "gap-2")}
            onClick={submit}
          >
            {submitting && <Loader2 className="size-3.5 animate-spin" />}
            {t("gitRepo.forge.create", { noun })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
