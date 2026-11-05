import { useTranslation } from "react-i18next";
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

/**
 * A name prompt for creating or renaming a collection, folder or request.
 * Purely presentational: the pane owns the pending value and the action.
 */
export interface NodeNameDialogProps {
  open: boolean;
  value: string;
  title: string;
  description: string;
  onChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

export function NodeNameDialog({
  open,
  value,
  title,
  description,
  onChange,
  onCancel,
  onSubmit,
}: NodeNameDialogProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.collection.nameDialog" });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <label className="text-xs font-medium" htmlFor="api-collection-name">
            {t("nameLabel")}
          </label>
          <Input
            id="api-collection-name"
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onSubmit();
            }}
            placeholder={t("namePlaceholder")}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button onClick={onSubmit} disabled={value.trim() === ""}>
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** A destructive yes/no confirmation. Presentational; the pane runs the action. */
export interface ConfirmDeleteDialogProps {
  open: boolean;
  title: string;
  description: string;
  onCancel: () => void;
  onConfirm: () => void;
}

export function ConfirmDeleteDialog({
  open,
  title,
  description,
  onCancel,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.collection.delete" });
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button variant="destructive" onClick={onConfirm}>
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
