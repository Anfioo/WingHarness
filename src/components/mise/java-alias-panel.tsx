// The Java alias panel: the `[tool_alias.java.versions]` map as an alias/target
// table, and a dialog with add/remove rows. The whole map is rebuilt from the
// rows, so deleting a row removes the alias; the shared diff stage still shows
// the exact section that will be written.

import { useRef, useState } from "react";
import { AlertTriangle, Loader2, Pencil, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

import {
  miseErrorCode,
  type MiseConfigAlias,
  type MiseConfigEdit,
  type MiseConfigSavePreview,
  type MiseConfigSaveResult,
  type MiseErrorCode,
} from "@/commands";
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
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { miseErrorKey } from "@/lib/mise/error-key";

export type JavaAliasPanelProps = {
  aliases: MiseConfigAlias[];
  onPreview: (edit: MiseConfigEdit) => Promise<MiseConfigSavePreview>;
  onSave: (path: string, nextContent: string) => Promise<MiseConfigSaveResult>;
};

type AliasRow = {
  id: number;
  alias: string;
  target: string;
};

function toRows(aliases: MiseConfigAlias[]): AliasRow[] {
  return aliases.map((alias, index) => ({ id: index, alias: alias.alias, target: alias.target }));
}

export function JavaAliasPanel({ aliases, onPreview, onSave }: JavaAliasPanelProps) {
  const { t } = useAppTranslation();
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<AliasRow[]>([]);
  const [preview, setPreview] = useState<MiseConfigSavePreview | null>(null);
  const [previewBusy, setPreviewBusy] = useState(false);
  const [error, setError] = useState<MiseErrorCode | null>(null);
  const nextId = useRef(0);

  const openEditor = () => {
    const initial = toRows(aliases);
    nextId.current = initial.length;
    setRows(initial);
    setPreview(null);
    setError(null);
    setOpen(true);
  };

  const updateRow = (id: number, field: "alias" | "target", value: string) => {
    setRows((current) => current.map((row) => (row.id === id ? { ...row, [field]: value } : row)));
  };

  const removeRow = (id: number) => {
    setRows((current) => current.filter((row) => row.id !== id));
  };

  const addRow = () => {
    const id = nextId.current + 1;
    nextId.current = id;
    setRows((current) => [...current, { id, alias: "", target: "" }]);
  };

  const aliasesInRows = rows.map((row) => row.alias.trim()).filter((alias) => alias !== "");
  const hasEmptyAlias = rows.some((row) => row.alias.trim() === "");
  const hasDuplicateAlias = new Set(aliasesInRows).size !== aliasesInRows.length;
  const invalid = hasEmptyAlias || hasDuplicateAlias;

  const buildEdit = (): MiseConfigEdit => {
    const values: Record<string, string | null> = {};
    for (const row of rows) {
      const alias = row.alias.trim();
      if (alias === "") continue;
      const target = row.target.trim();
      values[alias] = target === "" ? null : target;
    }
    return { kind: "aliases", values };
  };

  const generatePreview = async () => {
    if (previewBusy || invalid) return;

    setPreviewBusy(true);
    setError(null);
    try {
      const next = await onPreview(buildEdit());
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
    <section className="border-border bg-card rounded-xl border">
      <div className="border-border flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
        <div className="min-w-0">
          <h2 className="text-sm font-medium">{t("mise.config.aliases.title")}</h2>
          <p className="text-muted-foreground text-xs">{t("mise.config.aliases.subtitle")}</p>
        </div>
        <Button variant="outline" size="sm" onClick={openEditor}>
          <Pencil />
          {t("mise.config.aliases.edit")}
        </Button>
      </div>

      <div className="p-4">
        {aliases.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t("mise.config.aliases.empty")}</p>
        ) : (
          <div className="border-border overflow-hidden rounded-lg border">
            <table className="w-full text-sm">
              <thead className="bg-muted/50 text-muted-foreground text-xs">
                <tr>
                  <th className="px-3 py-1.5 text-left font-medium">
                    {t("mise.config.aliases.alias")}
                  </th>
                  <th className="px-3 py-1.5 text-left font-medium">
                    {t("mise.config.aliases.target")}
                  </th>
                </tr>
              </thead>
              <tbody>
                {aliases.map((alias) => (
                  <tr key={alias.alias} className="border-border border-t">
                    <td className="px-3 py-1.5 font-mono text-xs">{alias.alias}</td>
                    <td className="px-3 py-1.5 font-mono text-xs">{alias.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <Dialog
        open={open}
        onOpenChange={(next) => {
          if (previewBusy) return;
          setOpen(next);
          if (!next) setPreview(null);
        }}
      >
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{t("mise.config.aliases.edit")}</DialogTitle>
            <DialogDescription>{t("mise.config.aliases.subtitle")}</DialogDescription>
          </DialogHeader>

          {error && (
            <div
              role="alert"
              className="border-destructive/40 bg-destructive/5 text-destructive flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <AlertTriangle className="size-4 shrink-0" />
              <span className="min-w-0 break-words">{t(miseErrorKey(error))}</span>
            </div>
          )}

          <div className="flex flex-col gap-2">
            {rows.map((row) => {
              const duplicate =
                row.alias.trim() !== "" &&
                aliasesInRows.filter((alias) => alias === row.alias.trim()).length > 1;
              return (
                <div key={row.id} className="flex items-start gap-2">
                  <Input
                    value={row.alias}
                    placeholder={t("mise.config.aliases.alias")}
                    aria-label={t("mise.config.aliases.alias")}
                    aria-invalid={row.alias.trim() === "" || duplicate}
                    onChange={(event) => updateRow(row.id, "alias", event.target.value)}
                  />
                  <Input
                    value={row.target}
                    placeholder={t("mise.config.aliases.target")}
                    aria-label={t("mise.config.aliases.target")}
                    onChange={(event) => updateRow(row.id, "target", event.target.value)}
                  />
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t("mise.config.aliases.remove")}
                    title={t("mise.config.aliases.remove")}
                    onClick={() => removeRow(row.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              );
            })}

            <Button variant="outline" size="sm" className="self-start" onClick={addRow}>
              <Plus />
              {t("mise.config.aliases.add")}
            </Button>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              disabled={previewBusy}
              onClick={() => {
                setOpen(false);
                setPreview(null);
              }}
            >
              {t("mise.actions.cancel")}
            </Button>
            <Button disabled={previewBusy || invalid} onClick={() => void generatePreview()}>
              {previewBusy && <Loader2 className="animate-spin" />}
              {previewBusy ? t("mise.common.loading") : t("mise.actions.preview")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {preview && (
        <ConfigDiffDialog
          open
          preview={preview}
          onSave={() => onSave(preview.path, preview.nextContent)}
          onSaved={() => setOpen(false)}
          onBack={() => setPreview(null)}
          onOpenChange={(next) => {
            if (!next) setPreview(null);
          }}
        />
      )}
    </section>
  );
}
