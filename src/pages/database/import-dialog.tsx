// Ported from the openidea project (Apache-2.0) — see ./UPSTREAM.md.
//
// Import data from a delimited file: pick a CSV / TSV file, preview the first
// rows after mapping the columns, and insert everything in one transaction.

import { useEffect, useMemo, useState, type ReactNode } from "react";
import { open as pickFile } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, FolderOpen, Loader2, Upload } from "lucide-react";
import { apiReadTextFile, dbApplyEdits, type DbRowEdit } from "@/commands";
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
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { guessSeparator, importEdits, parseDelimited } from "./table-editor-model";

export type ImportDialogProps = {
  open: boolean;
  target: string;
  schema: string;
  table: string;
  columns: string[];
  onOpenChange(open: boolean): void;
  onImported(count: number): void;
};

/** The separators the dialog offers; the labels are i18n keys. */
const SEPARATORS: ReadonlyArray<{ value: string; label: string }> = [
  { value: ",", label: "database.import.comma" },
  { value: "\t", label: "database.import.tab" },
  { value: ";", label: "database.import.semicolon" },
  { value: "|", label: "database.import.pipe" },
];

const PREVIEW_ROWS = 8;

/** The text of a rejected command, whatever shape it arrived in. */
function failureText(error: unknown): string {
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function ImportDialog({
  open,
  target,
  schema,
  table,
  columns,
  onOpenChange,
  onImported,
}: ImportDialogProps): ReactNode {
  const { t } = useAppTranslation();

  const [file, setFile] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [separator, setSeparator] = useState(",");
  const [header, setHeader] = useState(true);
  const [emptyAsNull, setEmptyAsNull] = useState(true);
  const [reading, setReading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Every opening starts from a clean form; a failed import keeps its content.
  useEffect(() => {
    if (!open) return;
    setFile(null);
    setText("");
    setSeparator(",");
    setHeader(true);
    setEmptyAsNull(true);
    setReading(false);
    setBusy(false);
    setError(null);
  }, [open]);

  const rows = useMemo(() => (text ? parseDelimited(text, separator) : []), [text, separator]);

  /** The table columns the file feeds, in file order. */
  const mapped = useMemo(() => {
    if (header) {
      return (rows[0] ?? []).flatMap((name) => {
        const match = columns.find((column) => column.toLowerCase() === name.trim().toLowerCase());
        return match ? [match] : [];
      });
    }
    const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
    return columns.slice(0, width);
  }, [rows, columns, header]);

  const edits = useMemo<DbRowEdit[]>(
    () => (rows.length ? importEdits(rows, columns, header, emptyAsNull) : []),
    [rows, columns, header, emptyAsNull]
  );

  const preview = rows.slice(0, PREVIEW_ROWS);
  const firstWidth = rows[0]?.length ?? 0;

  const choose = async () => {
    setError(null);
    let picked: string | string[] | null;
    try {
      picked = await pickFile({
        multiple: false,
        directory: false,
        title: t("database.import.title"),
        filters: [
          {
            name: `${t("database.export.csv")} / ${t("database.export.tsv")}`,
            extensions: ["csv", "tsv", "txt"],
          },
        ],
      });
    } catch (failure) {
      setError(t("database.table.importFailed", { error: failureText(failure) }));
      return;
    }
    if (typeof picked !== "string") return;

    setReading(true);
    try {
      const document = await apiReadTextFile(picked);
      setFile(picked);
      setText(document.text);
      setSeparator(guessSeparator(document.text));
    } catch (failure) {
      setFile(null);
      setText("");
      setError(t("database.table.importFailed", { error: failureText(failure) }));
    } finally {
      setReading(false);
    }
  };

  const run = async () => {
    if (!edits.length) return;
    setBusy(true);
    setError(null);
    try {
      const count = await dbApplyEdits(target, schema, table, edits);
      onImported(count);
    } catch (failure) {
      // The backend rolls the whole batch back, so the form still describes it.
      setError(t("database.table.importFailed", { error: failureText(failure) }));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("database.import.title")}</DialogTitle>
          <DialogDescription>{`${schema}.${table}`}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="database-import-file" className="text-xs">
              {t("database.import.file")}
            </Label>
            <div className="flex items-center gap-2">
              <Input
                id="database-import-file"
                readOnly
                value={file ?? ""}
                spellCheck={false}
                className="font-mono text-xs"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reading || busy}
                onClick={() => void choose()}
              >
                {reading ? <Loader2 className="animate-spin" /> : <FolderOpen />}
                {t("database.import.browse")}
              </Button>
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-3">
            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">{t("database.import.separator")}</Label>
              <Select value={separator} onValueChange={setSeparator}>
                <SelectTrigger
                  size="sm"
                  className="h-8 w-32 text-xs"
                  aria-label={t("database.import.separator")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEPARATORS.map((entry) => (
                    <SelectItem key={entry.label} value={entry.value}>
                      {t(entry.label)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <label className="flex items-center gap-1.5 text-xs select-none">
              <input
                type="checkbox"
                className="accent-primary"
                checked={header}
                onChange={(event) => setHeader(event.target.checked)}
              />
              <span>{t("database.import.header")}</span>
            </label>
            <label className="flex items-center gap-1.5 text-xs select-none">
              <input
                type="checkbox"
                className="accent-primary"
                checked={emptyAsNull}
                onChange={(event) => setEmptyAsNull(event.target.checked)}
              />
              <span>{t("database.import.emptyAsNull")}</span>
            </label>
          </div>

          <div className="text-muted-foreground text-xs">
            <span className="text-foreground font-medium">{t("database.table.columns")}: </span>
            {mapped.length ? mapped.join(", ") : t("database.table.noMatchingColumns")}
          </div>

          {error && (
            <div className="border-destructive/40 bg-destructive/5 text-destructive flex items-start gap-2 rounded-md border px-3 py-2 text-xs">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="font-medium">{t("database.import.preview")}</span>
            <span className="text-muted-foreground">
              {t("database.import.rows", { count: rows.length })}
            </span>
          </div>

          {preview.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-md border">
              <table
                className="w-full border-collapse text-xs"
                aria-label={t("database.import.preview")}
              >
                <tbody>
                  {preview.map((row, index) => {
                    const isHeader = header && index === 0;
                    const ragged = isHeader ? false : row.length !== firstWidth;
                    return (
                      <tr
                        key={index}
                        className={cn(
                          isHeader && "bg-muted/60 font-medium",
                          ragged && "bg-destructive/5 text-destructive"
                        )}
                      >
                        {row.map((value, column) => (
                          <td
                            key={column}
                            className="max-w-56 truncate border-r border-b px-2 py-1 font-mono last:border-r-0"
                          >
                            {value === "" ? (
                              <span className="text-muted-foreground italic">
                                {t("database.grid.null")}
                              </span>
                            ) : (
                              value
                            )}
                          </td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() => onOpenChange(false)}
          >
            {t("database.form.cancel")}
          </Button>
          <Button
            type="button"
            disabled={busy || reading || !edits.length || !mapped.length}
            onClick={() => void run()}
            title={!mapped.length ? t("database.table.noMatchingColumns") : undefined}
          >
            {busy ? <Loader2 className="animate-spin" /> : <Upload />}
            {busy ? t("database.import.importing") : t("database.import.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
