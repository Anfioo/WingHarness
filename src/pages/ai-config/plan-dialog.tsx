import { Loader2, MinusCircle, Pencil, PlusCircle } from "lucide-react";
import type { ChangeLineView, PlanView } from "@/commands";
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
import { cn } from "@/lib/utils";

const ACTION_META: Record<
  ChangeLineView["action"],
  { icon: typeof PlusCircle; className: string; sign: string }
> = {
  create: { icon: PlusCircle, className: "text-emerald-600 dark:text-emerald-400", sign: "+" },
  update: { icon: Pencil, className: "text-amber-600 dark:text-amber-400", sign: "~" },
  delete: { icon: MinusCircle, className: "text-destructive", sign: "-" },
  remove: { icon: MinusCircle, className: "text-destructive", sign: "-" },
  noop: { icon: Pencil, className: "text-muted-foreground", sign: " " },
};

/**
 * Shows exactly what `sync` would change for one agent+scope before anything
 * is written — the TUI diff-preview screen. No write happens without passing
 * through here.
 */
export function PlanDialog({
  plan,
  applying,
  onClose,
  onApply,
}: {
  plan: PlanView | null;
  applying: boolean;
  onClose: () => void;
  onApply: () => void;
}) {
  const { t } = useAppTranslation();
  const hasChanges = plan !== null && !plan.isEmpty;

  return (
    <Dialog open={plan !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>
            {t("aiConfig.plan.title")}
            {plan && (
              <span className="text-muted-foreground ml-2 text-sm">
                {plan.agent} / {plan.scope}
                {plan.isMcp ? " (mcp)" : ""}
              </span>
            )}
          </DialogTitle>
          <DialogDescription>{t("aiConfig.plan.description")}</DialogDescription>
        </DialogHeader>

        <div className="border-border max-h-80 overflow-auto rounded-md border">
          {plan &&
          plan.changes.length === 0 &&
          plan.skipped.length === 0 &&
          plan.warnings.length === 0 ? (
            <p className="text-muted-foreground p-4 text-sm">{t("aiConfig.plan.inSync")}</p>
          ) : (
            <ul className="divide-border divide-y font-mono text-xs">
              {plan?.changes.map((change, index) => {
                const meta = ACTION_META[change.action];
                return (
                  <li key={`c-${index}`} className="flex items-center gap-2 px-3 py-1.5">
                    <span className={cn("w-4 shrink-0 text-center", meta.className)}>
                      {meta.sign}
                    </span>
                    <span className={cn("w-16 shrink-0", meta.className)}>{change.action}</span>
                    <span className="truncate">{change.target}</span>
                  </li>
                );
              })}
              {plan?.skipped.map((note, index) => (
                <li
                  key={`s-${index}`}
                  className="px-3 py-1.5 pl-9 text-amber-600 dark:text-amber-400"
                >
                  [skip] {note}
                </li>
              ))}
              {plan?.warnings.map((note, index) => (
                <li
                  key={`w-${index}`}
                  className="px-3 py-1.5 pl-9 text-amber-600 dark:text-amber-400"
                >
                  [warn] {note}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={applying}>
            {t("aiConfig.cancel")}
          </Button>
          <Button onClick={onApply} disabled={applying || !hasChanges}>
            {applying && <Loader2 className="size-4 animate-spin" />}
            {t("aiConfig.plan.apply")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
