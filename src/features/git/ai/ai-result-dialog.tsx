import type { ReactNode } from "react";
import { toast } from "sonner";
import { Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { AiReport, type AiReportLocate } from "./ai-report";

export function AiResultDialog({
  open,
  onOpenChange,
  title,
  icon,
  text,
  locate,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  icon?: ReactNode;
  text: string;
  locate?: AiReportLocate;
}) {
  const { t } = useAppTranslation();
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        aria-describedby={undefined}
        className="flex max-h-[85vh] w-[min(56rem,90vw)] max-w-none flex-col"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {icon} {title}
          </DialogTitle>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-y-auto pr-1">
          <AiReport
            text={text}
            className="text-foreground/90 text-sm leading-relaxed"
            locate={locate}
          />
        </div>
        <div className="mt-4 flex shrink-0 items-center justify-end gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              navigator.clipboard
                .writeText(text)
                .then(() => toast.success(t("gitRepo.ai.toast.copied")))
                .catch(() => toast.error(t("gitRepo.ai.toast.copyFailed")));
            }}
          >
            <Copy className="size-3" /> {t("gitRepo.ai.actions.copy")}
          </Button>
          <Button size="sm" onClick={() => onOpenChange(false)}>
            {t("gitRepo.ai.actions.done")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
