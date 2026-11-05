import { Loader2, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";

type RecoveryDialogProps = {
  open: boolean;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

/** Confirms rolling every recorded setting back to its original value. */
export function RecoveryDialog({ open, busy, onOpenChange, onConfirm }: RecoveryDialogProps) {
  const { t } = useAppTranslation();

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && busy) return;
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!busy} className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("systools.optimize.rollback.title")}</DialogTitle>
          <DialogDescription>{t("systools.optimize.rollback.description")}</DialogDescription>
        </DialogHeader>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
            {t("systools.optimize.plan.cancel")}
          </Button>
          <Button size="sm" onClick={onConfirm} disabled={busy}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}
            {busy
              ? t("systools.optimize.rollback.restoring")
              : t("systools.optimize.rollback.restore")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
