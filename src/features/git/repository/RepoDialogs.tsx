import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Check } from "lucide-react";
import { Checkbox as CheckboxPrimitive } from "radix-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  branchCreate,
  branchRename,
  cherryPick,
  cherryPickMany,
  historyCommit,
  stashCreate,
  tagCreate,
  type OpOutcome,
} from "@/commands";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { useUndo } from "@/features/git/history/undoStore";
import { basename, dirname } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";

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

export function RepoDialogs() {
  const { t } = useAppTranslation();
  const repo = useRepo((s) => s.repo);
  const dialog = useUi((s) => s.dialog);
  const rawContext = useUi((s) => s.dialogContext);
  const closeDialog = useUi((s) => s.closeDialog);

  const path = repo?.path ?? "";
  const dialogContext = typeof rawContext === "string" ? rawContext : null;

  const pickOids = useMemo(() => {
    if (dialog !== "cherryPick" || !rawContext) return [] as string[];
    if (typeof rawContext === "string") return [rawContext];
    return "oids" in rawContext ? rawContext.oids : [];
  }, [dialog, rawContext]);

  const stashPaths = useMemo(() => {
    if (dialog !== "createStash") return [] as string[];
    if (!rawContext || typeof rawContext === "string") return [] as string[];
    return "paths" in rawContext ? rawContext.paths : [];
  }, [dialog, rawContext]);

  const [pickSummaries, setPickSummaries] = useState<Record<string, string>>({});

  useEffect(() => {
    if (dialog !== "cherryPick" || pickOids.length === 0 || !path) {
      setPickSummaries({});
      return;
    }
    let active = true;
    (async () => {
      const entries = await Promise.all(
        pickOids.map(async (oid) => {
          try {
            const commit = await historyCommit(path, oid);
            return [oid, commit.summary] as const;
          } catch {
            return [oid, undefined] as const;
          }
        })
      );
      if (!active) return;
      const summaries: Record<string, string> = {};
      for (const [oid, summary] of entries) {
        if (summary) summaries[oid] = summary;
      }
      setPickSummaries(summaries);
    })();
    return () => {
      active = false;
    };
  }, [dialog, path, pickOids]);

  const [name, setName] = useState("");
  const [message, setMessage] = useState("");
  const [checkout, setCheckout] = useState(true);
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [recordOrigin, setRecordOrigin] = useState(true);
  const [busy, setBusy] = useState(false);
  const cherryPickRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    setName(dialog === "rename" ? (dialogContext ?? "") : "");
    setMessage("");
    setCheckout(true);
    setIncludeUntracked(true);
    setBusy(false);
  }, [dialog, dialogContext]);

  async function submit(label: string, op: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    try {
      await op();
      toast.success(t("gitRepo.sidebar.dialogs.done", { label }));
      closeDialog();
      await useRepo.getState().refresh();
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.dialogs.failed", {
          label,
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  function submitCreateBranch() {
    if (!name.trim()) return;
    void submit(t("gitRepo.sidebar.dialogs.label.createBranch"), () =>
      useUndo.getState().tracked({
        path,
        kind: "branchCreate",
        label: t("gitRepo.sidebar.dialogs.label.createBranchNamed", { name: name.trim() }),
        extra: { branch: name.trim(), oid: dialogContext ?? repo?.headOid ?? "" },
        action: () => branchCreate(path, name.trim(), dialogContext, checkout),
      })
    );
  }

  function submitCreateTag() {
    if (!name.trim()) return;
    void submit(t("gitRepo.sidebar.dialogs.label.createTag"), () =>
      tagCreate(path, name.trim(), dialogContext, message.trim() || undefined)
    );
  }

  function submitStash() {
    void submit(t("gitRepo.sidebar.dialogs.label.stash"), () =>
      stashCreate(
        path,
        message.trim() || undefined,
        stashPaths.length > 0 || includeUntracked,
        stashPaths
      )
    );
  }

  async function submitCherryPick() {
    if (busy || pickOids.length === 0) return;
    setBusy(true);
    try {
      const label =
        pickOids.length === 1
          ? t("gitRepo.sidebar.dialogs.label.cherryPickOne", { oid: pickOids[0].slice(0, 8) })
          : t("gitRepo.sidebar.dialogs.label.cherryPickMany", { count: pickOids.length });
      const outcome = await useUndo.getState().tracked({
        path,
        kind: "cherryPick",
        label,
        action: () =>
          pickOids.length === 1
            ? cherryPick(path, pickOids[0], recordOrigin)
            : cherryPickMany(path, pickOids, recordOrigin),
        shouldRecord: (result) => (result as OpOutcome)?.status === "ok",
      });
      const status = (outcome as OpOutcome)?.status;
      if (status === "ok") {
        toast.success(t("gitRepo.sidebar.dialogs.done", { label }));
      } else if (status === "conflicts") {
        toast.warning(t("gitRepo.sidebar.dialogs.cherryPick.conflicts"));
      } else {
        toast.info(t("gitRepo.sidebar.dialogs.cherryPick.upToDate"));
      }
      closeDialog();
      await useRepo.getState().refresh();
    } catch (error) {
      toast.error(
        t("gitRepo.sidebar.dialogs.failed", {
          label: t("gitRepo.sidebar.dialogs.label.cherryPick"),
          error: (error as { message?: string })?.message ?? String(error),
        })
      );
    } finally {
      setBusy(false);
    }
  }

  function submitRename() {
    const target = dialogContext ?? "";
    if (!name.trim() || name.trim() === target) return;
    void submit(t("gitRepo.sidebar.dialogs.label.rename"), () =>
      useUndo.getState().tracked({
        path,
        kind: "branchRename",
        label: t("gitRepo.sidebar.dialogs.label.renameFromTo", { from: target, to: name.trim() }),
        extra: { from: target, to: name.trim() },
        action: () => branchRename(path, target, name.trim()),
      })
    );
  }

  const relevant =
    dialog === "createBranch" ||
    dialog === "createTag" ||
    dialog === "createStash" ||
    dialog === "rename" ||
    dialog === "cherryPick";
  if (!relevant) return null;

  return (
    <>
      <Dialog open={dialog === "createBranch"} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitRepo.sidebar.dialogs.createBranch.title")}</DialogTitle>
            <DialogDescription>
              {dialogContext
                ? t("gitRepo.sidebar.dialogs.createBranch.fromCommit", {
                    oid: dialogContext.slice(0, 8),
                  })
                : t("gitRepo.sidebar.dialogs.createBranch.fromHead")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="create-branch-name" className="text-muted-foreground text-xs">
              {t("gitRepo.sidebar.dialogs.createBranch.nameLabel")}
            </Label>
            <Input
              id="create-branch-name"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submitCreateBranch()}
              placeholder={t("gitRepo.sidebar.dialogs.createBranch.namePlaceholder")}
              className="font-mono"
            />
          </div>
          <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
            <Checkbox checked={checkout} onCheckedChange={setCheckout} />
            {t("gitRepo.sidebar.dialogs.createBranch.checkout")}
          </label>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("gitRepo.sidebar.dialogs.cancel")}
            </Button>
            <Button disabled={busy || !name.trim()} onClick={submitCreateBranch}>
              {t("gitRepo.sidebar.dialogs.createBranch.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "createTag"} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitRepo.sidebar.dialogs.createTag.title")}</DialogTitle>
            <DialogDescription>
              {dialogContext
                ? t("gitRepo.sidebar.dialogs.createTag.atCommit", {
                    oid: dialogContext.slice(0, 8),
                  })
                : t("gitRepo.sidebar.dialogs.createTag.atHead")}{" "}
              {t("gitRepo.sidebar.dialogs.createTag.hint")}
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="create-tag-name" className="text-muted-foreground text-xs">
                {t("gitRepo.sidebar.dialogs.createTag.nameLabel")}
              </Label>
              <Input
                id="create-tag-name"
                autoFocus
                value={name}
                onChange={(event) => setName(event.target.value)}
                onKeyDown={(event) => event.key === "Enter" && submitCreateTag()}
                placeholder={t("gitRepo.sidebar.dialogs.createTag.namePlaceholder")}
                className="font-mono"
              />
            </div>
            <Textarea
              rows={3}
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              placeholder={t("gitRepo.sidebar.dialogs.createTag.messagePlaceholder")}
            />
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("gitRepo.sidebar.dialogs.cancel")}
            </Button>
            <Button disabled={busy || !name.trim()} onClick={submitCreateTag}>
              {t("gitRepo.sidebar.dialogs.createTag.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "createStash"} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {stashPaths.length > 0
                ? t("gitRepo.sidebar.dialogs.createStash.titleSelected")
                : t("gitRepo.sidebar.dialogs.createStash.title")}
            </DialogTitle>
            <DialogDescription>
              {stashPaths.length === 1
                ? t("gitRepo.sidebar.dialogs.createStash.descSelectedOne")
                : stashPaths.length > 1
                  ? t("gitRepo.sidebar.dialogs.createStash.descSelectedMany", {
                      count: stashPaths.length,
                    })
                  : t("gitRepo.sidebar.dialogs.createStash.descAll")}
            </DialogDescription>
          </DialogHeader>
          {stashPaths.length > 0 && (
            <ul className="border-border bg-muted/50 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
              {stashPaths.map((file) => (
                <li key={file} className="flex items-baseline gap-2 font-mono text-xs">
                  <span className="truncate">{basename(file)}</span>
                  <span className="text-muted-foreground/70 truncate">{dirname(file)}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-col gap-3">
            <Input
              autoFocus
              value={message}
              onChange={(event) => setMessage(event.target.value)}
              onKeyDown={(event) => event.key === "Enter" && submitStash()}
              placeholder={t("gitRepo.sidebar.dialogs.createStash.messagePlaceholder")}
            />
            {stashPaths.length === 0 && (
              <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
                <Checkbox checked={includeUntracked} onCheckedChange={setIncludeUntracked} />
                {t("gitRepo.sidebar.dialogs.createStash.includeUntracked")}
              </label>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("gitRepo.sidebar.dialogs.cancel")}
            </Button>
            <Button disabled={busy} onClick={submitStash}>
              {t("gitRepo.sidebar.dialogs.createStash.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "rename"} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{t("gitRepo.sidebar.dialogs.rename.title")}</DialogTitle>
            <DialogDescription>
              {t("gitRepo.sidebar.dialogs.rename.description", { name: dialogContext ?? "" })}
            </DialogDescription>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => event.key === "Enter" && submitRename()}
            className="font-mono"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("gitRepo.sidebar.dialogs.cancel")}
            </Button>
            <Button
              disabled={busy || !name.trim() || name.trim() === dialogContext}
              onClick={submitRename}
            >
              {t("gitRepo.sidebar.dialogs.rename.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={dialog === "cherryPick"} onOpenChange={(next) => !next && closeDialog()}>
        <DialogContent
          className="max-w-md"
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cherryPickRef.current?.focus();
          }}
        >
          <DialogHeader>
            <DialogTitle>
              {pickOids.length > 1
                ? t("gitRepo.sidebar.dialogs.cherryPick.titleMany", { count: pickOids.length })
                : t("gitRepo.sidebar.dialogs.cherryPick.title")}
            </DialogTitle>
            <DialogDescription>
              {t("gitRepo.sidebar.dialogs.cherryPick.description", {
                branch: repo?.headBranch ?? t("gitRepo.sidebar.dialogs.cherryPick.currentBranch"),
              })}
            </DialogDescription>
          </DialogHeader>
          <ul className="border-border bg-muted/50 flex max-h-40 flex-col gap-1 overflow-y-auto rounded-md border p-2">
            {pickOids.map((oid) => (
              <li key={oid} className="flex items-baseline gap-2 font-mono text-xs">
                <span className="text-muted-foreground/70 shrink-0">{oid.slice(0, 8)}</span>
                <span className="truncate">{pickSummaries[oid] ?? ""}</span>
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-1">
            <label className="text-muted-foreground flex cursor-pointer items-center gap-2 text-xs">
              <Checkbox checked={recordOrigin} onCheckedChange={setRecordOrigin} />
              {t("gitRepo.sidebar.dialogs.cherryPick.recordOrigin")}
            </label>
            <p className="text-muted-foreground/70 text-[11px]">
              {t("gitRepo.sidebar.dialogs.cherryPick.recordOriginHint")}
            </p>
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={closeDialog}>
              {t("gitRepo.sidebar.dialogs.cancel")}
            </Button>
            <Button ref={cherryPickRef} disabled={busy} onClick={submitCherryPick}>
              {t("gitRepo.sidebar.dialogs.cherryPick.submit")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
