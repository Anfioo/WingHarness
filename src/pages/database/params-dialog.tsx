// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.

/**
 * Asks for the value of every parameter of the statement about to run. Names
 * are deduplicated in first-seen order; an empty value is allowed and is left
 * to the SQL side, and the caller decides whether to run at all.
 */

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
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
import { useAppTranslation } from "@/hooks/use-app-translation";

export type ParamsDialogProps = {
  open: boolean;
  names: string[];
  onOpenChange(open: boolean): void;
  onSubmit(values: Record<string, string>): void;
};

export function ParamsDialog({
  open,
  names,
  onOpenChange,
  onSubmit,
}: ParamsDialogProps): ReactNode {
  const { t } = useAppTranslation();

  // One value per distinct name, in the order the statement first mentions it.
  const unique = useMemo(() => Array.from(new Set(names)), [names]);
  const signature = unique.join("\n");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!open) return;
    const next: Record<string, string> = {};
    for (const name of signature ? signature.split("\n") : []) next[name] = "";
    setValues(next);
  }, [open, signature]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (unique.length === 0) return;
    const submitted: Record<string, string> = {};
    for (const name of unique) submitted[name] = values[name] ?? "";
    onSubmit(submitted);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("database.params.title")}</DialogTitle>
          <DialogDescription>{t("database.params.description")}</DialogDescription>
        </DialogHeader>

        <form className="flex flex-col gap-3" onSubmit={submit}>
          {unique.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t("database.params.empty")}</p>
          ) : (
            unique.map((name, index) => (
              <div key={name} className="grid grid-cols-[minmax(0,10rem)_1fr] items-center gap-3">
                <Label
                  htmlFor={`database-param-${index}`}
                  className="truncate font-mono text-xs"
                  title={name}
                >
                  {name}
                </Label>
                <Input
                  id={`database-param-${index}`}
                  autoFocus={index === 0}
                  value={values[name] ?? ""}
                  placeholder={t("database.params.value")}
                  spellCheck={false}
                  onChange={(event) =>
                    setValues((current) => ({ ...current, [name]: event.target.value }))
                  }
                />
              </div>
            ))
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t("database.params.cancel")}
            </Button>
            <Button type="submit" disabled={unique.length === 0}>
              {t("database.params.run")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
