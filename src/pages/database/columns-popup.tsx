// "Go to column" of the table data editor (Ctrl+F12): the page's columns,
// narrowed as you type; Enter picks one.

import { useEffect, useState } from "react";
import { Square } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import type { GridColumn } from "./result-grid";

/** Indices of the columns whose name starts with (then contains) `query`. */
export function filterColumns(columns: readonly GridColumn[], query: string): number[] {
  const needle = query.trim().toLowerCase();
  const all = columns.map((_, index) => index);
  if (!needle) return all;
  const starts = all.filter((index) => columns[index]!.name.toLowerCase().startsWith(needle));
  const contains = all.filter(
    (index) => !starts.includes(index) && columns[index]!.name.toLowerCase().includes(needle)
  );
  return [...starts, ...contains];
}

export type ColumnsPopupProps = {
  columns: GridColumn[];
  onPick(index: number): void;
  open: boolean;
  onOpenChange(open: boolean): void;
};

export function ColumnsPopup({ columns, onPick, open, onOpenChange }: ColumnsPopupProps) {
  const { t } = useAppTranslation();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const shown = filterColumns(columns, query);
  const current = Math.min(active, Math.max(0, shown.length - 1));

  const pick = (position: number) => {
    const column = shown[position];
    if (column === undefined) return;
    onOpenChange(false);
    onPick(column);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm gap-2 p-3" showCloseButton={false}>
        <DialogTitle className="text-sm font-medium">{t("database.table.columns")}</DialogTitle>
        <DialogDescription className="sr-only">
          {t("database.table.searchColumns")}
        </DialogDescription>
        <Input
          autoFocus
          className="h-8 text-sm"
          value={query}
          placeholder={t("database.table.searchColumns")}
          aria-label={t("database.table.searchColumns")}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              pick(current);
              return;
            }
            if (event.key === "ArrowDown" || event.key === "ArrowUp") {
              event.preventDefault();
              if (shown.length === 0) return;
              const step = event.key === "ArrowDown" ? 1 : -1;
              setActive((current + step + shown.length) % shown.length);
            }
          }}
        />
        <div
          role="listbox"
          aria-label={t("database.table.columns")}
          className="max-h-72 overflow-auto"
        >
          {shown.length === 0 ? (
            <p className="text-muted-foreground px-2 py-3 text-xs">
              {t("database.table.noMatchingColumns")}
            </p>
          ) : (
            shown.map((columnIndex, position) => {
              const column = columns[columnIndex]!;
              return (
                <button
                  key={`${column.name}-${columnIndex}`}
                  type="button"
                  role="option"
                  aria-selected={position === current}
                  className={cn(
                    "hover:bg-accent flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs",
                    position === current && "bg-accent"
                  )}
                  onMouseEnter={() => setActive(position)}
                  onClick={() => pick(position)}
                >
                  <Square className="text-muted-foreground size-3 shrink-0" />
                  <span className="truncate font-mono">{column.name}</span>
                  {column.typeName && (
                    <span className="text-muted-foreground ml-auto shrink-0 text-[10px]">
                      {column.typeName}
                    </span>
                  )}
                </button>
              );
            })
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
