import { useState } from "react";
import { toast } from "sonner";
import { remoteAdd, remoteEdit, remoteFetch } from "@/commands";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { useUi } from "@/features/git/ui-store";
import { useRepo } from "@/features/git/repository-store";
import { activateTab } from "@/features/git/repository/tabs";
import { toastOutcome } from "@/features/git/toast-outcome";
import { CloneDialog } from "@/features/git/repository/CloneDialog";
import { ScanRepositoriesDialog } from "@/features/git/repository/ScanRepositoriesDialog";
import { useRemoteUi } from "./store";

export function RemoteDialogs() {
  const dialog = useUi((state) => state.dialog);
  return (
    <>
      {dialog === "clone" && <CloneDialog onCloned={activateTab} />}
      {dialog === "scanRepositories" && <ScanRepositoriesDialog />}
      <EditRemoteDialog />
    </>
  );
}

function EditRemoteDialog() {
  const { t } = useAppTranslation();
  const repo = useRepo((state) => state.repo);
  const remotes = useRepo((state) => state.remotes);
  const setBusy = useRepo((state) => state.setBusy);
  const editRemote = useRemoteUi((state) => state.editRemote);
  const closeEditRemote = useRemoteUi((state) => state.closeEditRemote);
  const updateEditRemote = useRemoteUi((state) => state.updateEditRemote);
  const [saving, setSaving] = useState(false);

  const isAdd = editRemote?.original === null;

  const submit = async () => {
    if (!repo || !editRemote) return;
    const name = editRemote.name.trim();
    const url = editRemote.url.trim();
    if (!name || !url) return;
    const label = isAdd
      ? t("gitRepo.remote.remoteForm.addLabel", { name })
      : t("gitRepo.remote.remoteForm.updateLabel", { name });
    setSaving(true);
    setBusy(label);
    try {
      let outcome: { status?: string; message?: string } | undefined;
      if (isAdd) {
        await remoteAdd(repo.path, name, url);
        outcome = await remoteFetch(repo.path, name, true, false);
      } else {
        await remoteEdit(repo.path, editRemote.original as string, name, url);
      }
      toastOutcome(outcome, t("gitRepo.remote.remoteForm.complete", { label }));
      await useRepo.getState().refresh();
      closeEditRemote();
    } catch (error) {
      toast.error((error as { message?: string })?.message ?? String(error));
    } finally {
      setSaving(false);
      setBusy(null);
    }
  };

  return (
    <Dialog open={editRemote !== null} onOpenChange={(open) => !open && closeEditRemote()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {isAdd
              ? t("gitRepo.remote.remoteForm.addTitle")
              : t("gitRepo.remote.remoteForm.editTitle")}
          </DialogTitle>
          <DialogDescription>
            {isAdd
              ? t("gitRepo.remote.remoteForm.addDescription")
              : t("gitRepo.remote.remoteForm.editDescription")}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3">
          <label className="text-muted-foreground flex flex-col gap-1.5 text-xs">
            {t("gitRepo.remote.remoteForm.name")}
            <Input
              value={editRemote?.name ?? ""}
              onChange={(event) => updateEditRemote({ name: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder={remotes.length === 0 ? "origin" : "upstream"}
              autoFocus
            />
          </label>
          <label className="text-muted-foreground flex flex-col gap-1.5 text-xs">
            {t("gitRepo.remote.remoteForm.url")}
            <Input
              value={editRemote?.url ?? ""}
              onChange={(event) => updateEditRemote({ url: event.target.value })}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder="https://github.com/user/repo.git"
              className="font-mono"
            />
          </label>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={() => closeEditRemote()}>
            {t("gitRepo.remote.remoteForm.cancel")}
          </Button>
          <Button
            disabled={saving || !editRemote?.name.trim() || !editRemote?.url.trim()}
            onClick={() => void submit()}
          >
            {isAdd
              ? t("gitRepo.remote.remoteForm.addAction")
              : t("gitRepo.remote.remoteForm.saveAction")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
