// The document editor: the CodeEditor stage and the shared diff stage. The
// editor holds a draft only; nothing reaches disk before the diff is confirmed.
// Closing with unsaved edits asks first, and Ctrl/Cmd+S generates the preview.

import { useState } from "react";
import { AlertTriangle, Loader2 } from "lucide-react";
import { toast } from "sonner";

import {
  miseErrorCode,
  type MiseConfigDocument,
  type MiseConfigEdit,
  type MiseConfigSavePreview,
  type MiseConfigSaveResult,
  type MiseErrorCode,
} from "@/commands";
import { confirmDialog } from "@/components/confirm";
import { CodeEditor } from "@/components/code-editor";
import { ConfigDiffDialog } from "@/components/mise/config-diff-dialog";
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

export type ConfigDocumentEditorDialogProps = {
  open: boolean;
  document: MiseConfigDocument;
  onPreview: (edit: MiseConfigEdit) => Promise<MiseConfigSavePreview>;
  onSave: (path: string, nextContent: string) => Promise<MiseConfigSaveResult>;
  onOpenChange: (open: boolean) => void;
};

/** Compare drafts the way the engine writes them: LF endings, one final newline. */
function normalizeContent(value: string): string {
  const normalized = value.replace(/\r\n/g, "\n").trimEnd();
  return normalized === "" ? "" : `${normalized}\n`;
}

export function ConfigDocumentEditorDialog({
  open,
  document,
  onPreview,
  onSave,
  onOpenChange,
}: ConfigDocumentEditorDialogProps) {
  const { t } = useAppTranslation();
  const [content, setContent] = useState(document.content);
  const [preview, setPreview] = useState<MiseConfigSavePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<MiseErrorCode | null>(null);

  const dirty = normalizeContent(content) !== normalizeContent(document.content);

  const requestClose = async () => {
    if (previewBusy) return;
    if (dirty) {
      const discard = await confirmDialog({
        title: t("mise.config.diff.title"),
        description: t("mise.config.diff.description"),
        confirmLabel: t("mise.actions.close"),
        destructive: true,
      });
      if (!discard) return;
    }
    onOpenChange(false);
  };

  const generatePreview = async () => {
    if (!dirty || previewBusy) return;

    setPreviewBusy(true);
    setError(null);
    try {
      const next = await onPreview({ kind: "document", content });
      if (!next.hasChanges) {
        toast.info(t("mise.config.diff.noChanges"));
        return;
      }
      setPreview(next);
    } catch (failure) {
      setError(miseErrorCode(failure) ?? "internal");
    } finally {
      setPreviewBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          onOpenChange(true);
          return;
        }
        void requestClose();
      }}
    >
      <DialogContent className="flex h-[82vh] flex-col gap-3 sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("mise.config.document.edit")}</DialogTitle>
          <DialogDescription className="font-mono text-xs break-all select-text">
            {document.path}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span
            className={cn(
              "rounded-full border px-2 py-0.5",
              document.exists
                ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-600"
                : "border-amber-500/40 bg-amber-500/10 text-amber-600"
            )}
          >
            {document.exists ? t("mise.config.document.exists") : t("mise.config.document.missing")}
          </span>
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

        <div className="border-border flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
          <CodeEditor
            value={content}
            language="ini"
            highlight
            wrap
            onChange={setContent}
            onSave={() => void generatePreview()}
            ariaLabel={t("mise.config.document.content")}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" disabled={previewBusy} onClick={() => void requestClose()}>
            {t("mise.actions.cancel")}
          </Button>
          <Button disabled={!dirty || previewBusy} onClick={() => void generatePreview()}>
            {previewBusy && <Loader2 className="animate-spin" />}
            {previewBusy ? t("mise.common.loading") : t("mise.actions.preview")}
          </Button>
        </DialogFooter>
      </DialogContent>

      {preview && (
        <ConfigDiffDialog
          open
          preview={preview}
          onSave={() => onSave(preview.path, preview.nextContent)}
          onSaved={() => onOpenChange(false)}
          onBack={() => setPreview(null)}
          onOpenChange={(next) => {
            if (!next) setPreview(null);
          }}
        />
      )}
    </Dialog>
  );
}
