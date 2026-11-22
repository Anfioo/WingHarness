// Confirmation dialog for a mise action: the exact script, the files and scope
// it touches, the risk notes, and the confirm/cancel pair. Tool actions in the
// tools tab open this before anything runs; while `busy` the dialog cannot be
// dismissed by the user.

import { AlertTriangle, Copy, Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { ActionPreviewDialogProps } from "@/components/mise/props";
import { StatusBadge } from "@/components/mise/status-badge";
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

export function ActionPreviewDialog({
  open,
  title,
  summary,
  command,
  level,
  affectedFiles,
  impactScope,
  riskNotes,
  confirmLabel,
  busy = false,
  onConfirm,
  onOpenChange,
}: ActionPreviewDialogProps) {
  const { t } = useAppTranslation();

  const copyCommand = async () => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("mise.shell.guideCopied"));
    } catch {
      // Clipboard access can be refused; the command stays selectable by hand.
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <div className="flex min-w-0 flex-wrap items-center gap-2 pr-6">
            <StatusBadge level={level} />
            <DialogTitle className="min-w-0 break-words">{title}</DialogTitle>
          </div>
          <DialogDescription className="break-words">{summary}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <section className="flex flex-col gap-1.5">
            <h3 className="text-sm font-medium">{t("mise.tools.commandPreview")}</h3>
            <div className="relative">
              <pre className="bg-muted max-h-56 overflow-auto rounded-md p-3 pr-11 font-mono text-xs leading-relaxed break-all whitespace-pre-wrap select-text">
                {command}
              </pre>
              <Button
                variant="ghost"
                size="icon-xs"
                className="absolute top-1.5 right-1.5"
                aria-label={t("mise.actions.copy")}
                title={t("mise.actions.copy")}
                onClick={() => void copyCommand()}
              >
                <Copy />
              </Button>
            </div>
          </section>

          {affectedFiles && affectedFiles.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{t("mise.actionPreview.affectedFiles")}</h3>
              <ul className="bg-muted/50 flex flex-col gap-1 rounded-md p-2">
                {affectedFiles.map((file) => (
                  <li key={file} className="font-mono text-xs break-all select-text">
                    {file}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {impactScope && impactScope.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{t("mise.actionPreview.impactScope")}</h3>
              <ul className="bg-muted/50 flex flex-col gap-1 rounded-md p-2">
                {impactScope.map((item) => (
                  <li key={item} className="text-xs break-words">
                    {item}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {riskNotes && riskNotes.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <h3 className="text-sm font-medium">{t("mise.actionPreview.riskNotes")}</h3>
              <ul className="flex flex-col gap-1.5">
                {riskNotes.map((note) => (
                  <li
                    key={note}
                    className="flex items-start gap-1.5 text-xs break-words text-amber-600"
                  >
                    <AlertTriangle className="mt-px size-3.5 shrink-0" />
                    <span>{note}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={() => onOpenChange(false)}>
            {t("mise.actions.cancel")}
          </Button>
          <Button disabled={busy} onClick={onConfirm}>
            {busy && <Loader2 className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
