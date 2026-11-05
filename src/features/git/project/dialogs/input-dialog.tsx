import { useState } from "react";
import { Loader2 } from "lucide-react";
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
import { useAppTranslation } from "@/hooks/use-app-translation";

export interface InputDialogState {
  title: string;
  description?: string;
  label: string;
  placeholder?: string;
  initialValue?: string;
  confirmLabel: string;
  /** A multi-line message (commit messages); Enter inserts a newline and mod+Enter submits. */
  multiline?: boolean;
  /** Returns an i18n error message, or null when the value can be submitted. */
  validate?: (value: string) => string | null;
  /** Resolves to close the dialog; throwing keeps it open with the error shown. */
  submit: (value: string) => Promise<void>;
}

/** One text field, used for branch names, renames and tags. */
export function InputDialog({
  request,
  onClose,
}: {
  request: InputDialogState | null;
  onClose: () => void;
}) {
  if (!request) return null;
  return (
    <InputDialogBody
      key={`${request.title}:${request.initialValue ?? ""}`}
      request={request}
      onClose={onClose}
    />
  );
}

function InputDialogBody({ request, onClose }: { request: InputDialogState; onClose: () => void }) {
  const { t } = useAppTranslation();
  const [value, setValue] = useState(request.initialValue ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    const trimmed = value.trim();
    const invalid =
      request.validate?.(trimmed) ?? (trimmed ? null : t("projectGit.dialog.required"));
    if (invalid) {
      setError(invalid);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await request.submit(trimmed);
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{request.title}</DialogTitle>
          {request.description && <DialogDescription>{request.description}</DialogDescription>}
        </DialogHeader>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="project-git-input" className="text-muted-foreground text-xs">
            {request.label}
          </Label>
          {request.multiline ? (
            <Textarea
              id="project-git-input"
              autoFocus
              rows={8}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) void submit();
              }}
              placeholder={request.placeholder}
              className="font-mono text-xs"
            />
          ) : (
            <Input
              id="project-git-input"
              autoFocus
              value={value}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") void submit();
              }}
              placeholder={request.placeholder}
              className="font-mono"
            />
          )}
          {error && (
            <p className="text-destructive text-[11px] [overflow-wrap:anywhere]">{error}</p>
          )}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            {t("projectGit.dialog.cancel")}
          </Button>
          <Button onClick={() => void submit()} disabled={busy}>
            {busy && <Loader2 className="animate-spin" />}
            {request.confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
