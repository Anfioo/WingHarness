// Batch conflict prompt: one decision per source, with an apply-to-all switch.

import { useEffect, useState } from "react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { ConflictChoice, ConflictItem } from "./types";

export type ConflictDialogProps = {
  open: boolean;
  items: ConflictItem[];
  defaultChoice: ConflictChoice;
  onCancel: () => void;
  onConfirm: (decisions: Map<string, ConflictChoice>) => void;
};

const CHOICES: ConflictChoice[] = ["overwrite", "skip", "rename"];

export function ConflictDialog({
  open,
  items,
  defaultChoice,
  onCancel,
  onConfirm,
}: ConflictDialogProps) {
  const { t } = useAppTranslation();
  const [choices, setChoices] = useState<Record<string, ConflictChoice>>({});
  const [applyAll, setApplyAll] = useState(true);
  const [sharedChoice, setSharedChoice] = useState<ConflictChoice>(defaultChoice);

  useEffect(() => {
    if (!open) return;
    const next: Record<string, ConflictChoice> = {};
    for (const item of items) next[item.source] = defaultChoice;
    setChoices(next);
    setSharedChoice(defaultChoice);
    setApplyAll(items.length > 1);
  }, [open, items, defaultChoice]);

  const label = (choice: ConflictChoice) => {
    if (choice === "skip") return t("servers.sftp.conflict.skip");
    if (choice === "rename") return t("servers.sftp.conflict.rename");
    return t("servers.sftp.conflict.overwrite");
  };

  const confirm = () => {
    const decisions = new Map<string, ConflictChoice>();
    for (const item of items) {
      decisions.set(item.source, applyAll ? sharedChoice : (choices[item.source] ?? defaultChoice));
    }
    onConfirm(decisions);
  };

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="text-destructive size-4 shrink-0" />
            {t("servers.sftp.conflict.title")}
          </DialogTitle>
          <DialogDescription>
            {t("servers.sftp.conflict.description", {
              defaultValue: "These items already exist in the target folder.",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="border-border max-h-64 overflow-auto rounded-md border">
          {items.map((item, index) => {
            const value = applyAll ? sharedChoice : (choices[item.source] ?? defaultChoice);
            return (
              <div
                key={item.source}
                className="border-border/60 flex items-center gap-2 border-b px-2 py-1.5 last:border-b-0"
              >
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={item.source}>
                  {item.name}
                </span>
                <Select
                  value={value}
                  disabled={applyAll && index > 0}
                  onValueChange={(next) => {
                    const choice = next as ConflictChoice;
                    if (applyAll) setSharedChoice(choice);
                    else setChoices((previous) => ({ ...previous, [item.source]: choice }));
                  }}
                >
                  <SelectTrigger size="sm" className="w-32">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CHOICES.map((choice) => (
                      <SelectItem key={choice} value={choice}>
                        {label(choice)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            );
          })}
        </div>

        {items.length > 1 && (
          <label className="flex items-center justify-between gap-3 text-xs">
            <span className="text-muted-foreground">{t("servers.sftp.conflict.applyAll")}</span>
            <Switch checked={applyAll} onCheckedChange={setApplyAll} />
          </label>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={onCancel}>
            {t("servers.form.cancel")}
          </Button>
          <Button onClick={confirm}>
            {t("servers.sftp.conflict.continue", { defaultValue: "Continue" })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
