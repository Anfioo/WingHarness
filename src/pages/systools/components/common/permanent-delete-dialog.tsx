import type { ReactNode } from "react";
import { AlertTriangle, Loader2, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type DeleteStat = { label: string; value: string };

type PermanentDeleteDialogProps = {
  open: boolean;
  busy: boolean;
  title: ReactNode;
  description: ReactNode;
  stats?: DeleteStat[];
  preview?: ReactNode;
  extraNotice?: ReactNode;
  warning: ReactNode;
  cancelLabel: string;
  busyLabel: string;
  confirmLabel: string;
  confirmDisabled?: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

/** Confirmation for a permanent, unrecoverable deletion. */
export function PermanentDeleteDialog({
  open,
  busy,
  title,
  description,
  stats,
  preview,
  extraNotice,
  warning,
  cancelLabel,
  busyLabel,
  confirmLabel,
  confirmDisabled = false,
  onOpenChange,
  onConfirm,
}: PermanentDeleteDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>

        {stats && stats.length > 0 ? (
          <dl className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
            {stats.map((stat) => (
              <div key={stat.label} className="flex items-center justify-between gap-3 py-0.5">
                <dt className="text-muted-foreground">{stat.label}</dt>
                <dd className="font-medium tabular-nums">{stat.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {preview}
        {extraNotice}

        <p className="text-destructive flex items-start gap-2 text-xs">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
          <span>{warning}</span>
        </p>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            {cancelLabel}
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={busy || confirmDisabled}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            {busy ? busyLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
