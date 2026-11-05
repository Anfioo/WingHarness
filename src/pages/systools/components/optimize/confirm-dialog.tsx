import { AlertTriangle } from "lucide-react";
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

type HighRiskDialogProps = {
  open: boolean;
  itemNames: string[];
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
};

/** Confirmation shown before a plan containing high-risk settings is prepared. */
export function HighRiskDialog({ open, itemNames, onOpenChange, onConfirm }: HighRiskDialogProps) {
  const { t } = useAppTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="flex items-start gap-3">
            <span className="bg-muted text-destructive flex size-9 shrink-0 items-center justify-center rounded-full">
              <AlertTriangle className="size-4" />
            </span>
            <div className="min-w-0 space-y-1">
              <DialogTitle>{t("systools.optimize.riskDialog.title")}</DialogTitle>
              <DialogDescription>{t("systools.optimize.riskDialog.description")}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <ul className="max-h-40 divide-y overflow-y-auto rounded-md border text-xs">
          {itemNames.map((name, index) => (
            <li key={`${name}-${index}`} className="px-3 py-1.5">
              {name}
            </li>
          ))}
        </ul>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>
            {t("systools.optimize.riskDialog.cancel")}
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm}>
            {t("systools.optimize.riskDialog.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
