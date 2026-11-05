import { useState } from "react";
import { HelpCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";

/**
 * The TUI's `?` overlay: a key-binding reference plus the one concept that
 * trips people up — the store (what sync pushes out) and each agent's files
 * already on disk are two separate things. The body is the same text as
 * `tui/src/screens/help.rs`.
 */
export function HelpButton() {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);

  const raw = t("aiConfig.help.lines", { returnObjects: true });
  const lines = Array.isArray(raw) ? (raw as unknown as string[]) : [];

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <HelpCircle className="size-4" />
        {t("aiConfig.help.open")}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("aiConfig.help.title")}</DialogTitle>
            <DialogDescription>{t("aiConfig.help.subtitle")}</DialogDescription>
          </DialogHeader>
          <div className="border-border bg-muted/30 max-h-[28rem] overflow-auto rounded-md border p-4">
            <pre className="font-mono text-xs leading-5 whitespace-pre-wrap">
              {lines.join("\n")}
            </pre>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
