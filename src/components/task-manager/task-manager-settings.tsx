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

type TaskManagerSettingsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

/**
 * A0 placeholder for the page's settings dialog. F3 replaces it with the
 * sampling-interval control and the service install/uninstall actions.
 */
export function TaskManagerSettings({ open, onOpenChange }: TaskManagerSettingsProps) {
  const { t } = useAppTranslation();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("taskManager.settings.title")}</DialogTitle>
          <DialogDescription>{t("taskManager.settings.placeholder")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            {t("taskManager.actions.close")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
