import { ArrowDownToLine, ArrowUpFromLine } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface PushRejectedDialogProps {
  open: boolean;
  remote: string;
  branch: string | null;
  onPullRebase: () => void;
  onForcePush: () => void;
  onClose: () => void;
}

export function PushRejectedDialog({
  open,
  remote,
  branch,
  onPullRebase,
  onForcePush,
  onClose,
}: PushRejectedDialogProps) {
  const { t } = useAppTranslation();
  const target = branch ? `${remote}/${branch}` : remote;

  return (
    <Dialog open={open} onOpenChange={(value) => !value && onClose()}>
      <DialogContent className="max-w-md" data-push-rejected>
        <DialogHeader>
          <DialogTitle>{t("gitRepo.remote.pushRejected.title")}</DialogTitle>
          <DialogDescription>
            {t("gitRepo.remote.pushRejected.description", { target })}
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-2">
          <button
            type="button"
            autoFocus
            className="border-border bg-card hover:border-primary/60 hover:bg-muted flex items-start gap-3 rounded-md border p-3 text-left transition-colors"
            onClick={onPullRebase}
          >
            <ArrowDownToLine className="text-primary mt-0.5 size-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {t("gitRepo.remote.pushRejected.pullRebase.title")}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("gitRepo.remote.pushRejected.pullRebase.description")}
              </span>
            </span>
          </button>
          <button
            type="button"
            className="border-border bg-card hover:border-destructive/60 hover:bg-destructive/5 flex items-start gap-3 rounded-md border p-3 text-left transition-colors"
            onClick={onForcePush}
          >
            <ArrowUpFromLine className="text-destructive mt-0.5 size-4 shrink-0" />
            <span className="flex flex-col gap-0.5">
              <span className="text-sm font-medium">
                {t("gitRepo.remote.pushRejected.forcePush.title")}
              </span>
              <span className="text-muted-foreground text-xs">
                {t("gitRepo.remote.pushRejected.forcePush.description")}
              </span>
            </span>
          </button>
        </div>
        <DialogFooter>
          <Button variant="secondary" onClick={onClose}>
            {t("gitRepo.remote.pushRejected.cancel")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
