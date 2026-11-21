// The second stage shared by every configuration write: the unified diff, the
// target path and the create marker, with save / back buttons. The save itself
// runs here so a failure keeps the preview open with the error code; the caller
// only supplies the command and the callback that closes its own dialog.

import { useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  miseErrorCode,
  type MiseConfigSavePreview,
  type MiseConfigSaveResult,
  type MiseErrorCode,
} from "@/commands";
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
import { miseErrorKey } from "@/lib/mise/error-key";
import { cn } from "@/lib/utils";

export type ConfigDiffDialogProps = {
  open: boolean;
  preview: MiseConfigSavePreview;
  /** Set while the host is generating the preview or otherwise cannot write. */
  busy?: boolean;
  onSave: () => Promise<MiseConfigSaveResult>;
  /** Called after a successful save, before the dialog closes. */
  onSaved?: (result: MiseConfigSaveResult) => void;
  onBack: () => void;
  onOpenChange: (open: boolean) => void;
};

/** `+` lines green, `-` lines red, everything else neutral. */
function lineClassName(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) {
    return "text-muted-foreground font-semibold";
  }
  if (line.startsWith("@@")) return "text-sky-600 dark:text-sky-400";
  if (line.startsWith("+")) return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400";
  if (line.startsWith("-")) return "bg-red-500/10 text-red-600 dark:text-red-400";
  return "";
}

export function ConfigDiffDialog({
  open,
  preview,
  busy = false,
  onSave,
  onSaved,
  onBack,
  onOpenChange,
}: ConfigDiffDialogProps) {
  const { t } = useAppTranslation();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const blocked = busy || saving;

  const save = async () => {
    if (blocked || !preview.hasChanges) return;

    setSaving(true);
    setError(null);
    try {
      const result = await onSave();
      toast.success(
        result.backupPath
          ? t("mise.config.save.savedWithBackup", { path: result.backupPath })
          : t("mise.config.save.saved")
      );
      onSaved?.(result);
      onOpenChange(false);
    } catch (failure) {
      setError(miseErrorCode(failure) ?? "internal");
    } finally {
      setSaving(false);
    }
  };

  const lines = preview.diff.split("\n");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!blocked) onOpenChange(next);
      }}
    >
      <DialogContent className="flex max-h-[85vh] flex-col gap-4 sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("mise.config.diff.title")}</DialogTitle>
          <DialogDescription>{t("mise.config.diff.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-muted-foreground text-xs font-medium">
            {t("mise.config.diff.path")}
          </span>
          <span className="font-mono text-xs break-all select-text">{preview.path}</span>
          {preview.createsFile && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              {t("mise.config.diff.createsFile")}
            </span>
          )}
        </div>

        {error && (
          <div
            role="alert"
            className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0" />
            <span className="min-w-0 break-words">{t(miseErrorKey(error))}</span>
          </div>
        )}

        {preview.hasChanges ? (
          <div className="border-border bg-muted/30 min-h-0 flex-1 overflow-auto rounded-md border">
            <pre className="m-0 p-2 font-mono text-xs leading-relaxed whitespace-pre select-text">
              {lines.map((line, index) => (
                <div key={index} className={cn("px-1", lineClassName(line))}>
                  {line === "" ? " " : line}
                </div>
              ))}
            </pre>
          </div>
        ) : (
          <p className="text-muted-foreground py-6 text-center text-sm">
            {t("mise.config.diff.noChanges")}
          </p>
        )}

        <DialogFooter>
          <Button variant="outline" disabled={blocked} onClick={onBack}>
            <ArrowLeft />
            {t("mise.actions.edit")}
          </Button>
          <Button disabled={blocked || !preview.hasChanges} onClick={() => void save()}>
            {saving && <Loader2 className="animate-spin" />}
            {saving ? t("mise.config.save.saving") : t("mise.config.save.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
