// The record / value / aggregates side panel of a data grid: IDEA's three
// views of the current selection. The panel is display only — the grid owns
// the selection and the caller owns the panel's visibility.

import { X } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import type { GridColumn, GridRange } from "./result-grid";
import { aggregates, formatNumber, type Cell } from "./result-view";

export type DataPanel = "record" | "value" | "aggregates" | null;

export type DataPanelProps = {
  columns: GridColumn[];
  rows: Cell[][];
  selection: GridRange | null;
  panel: DataPanel;
  onPanelChange(panel: DataPanel): void;
};

const WIDTH = 260;

/** A cell as the panel shows it: NULL in italics, the rest as its full text. */
function CellText({ value, className }: { value: Cell; className?: string }) {
  const { t } = useAppTranslation();
  if (value === null)
    return <span className="text-muted-foreground italic">{t("database.grid.null")}</span>;
  return <span className={className}>{value}</span>;
}

export function DataPanel(props: DataPanelProps) {
  const { columns, rows, selection, panel, onPanelChange } = props;
  const { t } = useAppTranslation();

  if (!panel) return null;

  const range = selection
    ? {
        top: Math.min(selection.r0, selection.r1),
        bottom: Math.max(selection.r0, selection.r1),
        left: Math.min(selection.c0, selection.c1),
        right: Math.max(selection.c0, selection.c1),
      }
    : null;
  // The cell the panel is about: the leading corner of the selection.
  const lead = selection ? { row: selection.r1, col: selection.c1 } : null;

  const title =
    panel === "record"
      ? t("database.panel.record")
      : panel === "value"
        ? t("database.panel.value")
        : t("database.panel.aggregates");

  const copyValue = async (value: Cell) => {
    try {
      await navigator.clipboard.writeText(value ?? "");
      toast.success(t("database.result.copied"));
    } catch {
      toast.error(t("database.grid.copyFailed"));
    }
  };

  const body = () => {
    if (!range || !lead) {
      return <p className="text-muted-foreground p-3 text-xs">{t("database.panel.empty")}</p>;
    }

    if (panel === "record") {
      return (
        <ul className="divide-border divide-y text-xs">
          {columns.map((column, col) => (
            <li key={`${column.name}\u0000${col}`} className="flex gap-2 px-3 py-1.5">
              <span className="text-muted-foreground w-24 shrink-0 truncate" title={column.name}>
                {column.name}
              </span>
              <span className="min-w-0 flex-1 font-mono break-all whitespace-pre-wrap">
                <CellText value={rows[lead.row]?.[col] ?? null} />
              </span>
            </li>
          ))}
        </ul>
      );
    }

    if (panel === "value") {
      const value = rows[lead.row]?.[lead.col] ?? null;
      return (
        <div className="flex flex-col gap-2 p-3">
          <div
            className="text-muted-foreground truncate text-[11px]"
            title={columns[lead.col]?.name}
          >
            {columns[lead.col]?.name}
          </div>
          <pre className="font-mono text-xs break-all whitespace-pre-wrap">
            <CellText value={value} />
          </pre>
          <Button
            variant="outline"
            size="xs"
            className="self-start"
            disabled={value === null}
            onClick={() => void copyValue(value)}
          >
            {t("database.grid.copy")}
          </Button>
        </div>
      );
    }

    return (
      <div className="divide-border divide-y">
        {columns.map((column, col) => {
          if (col < range.left || col > range.right) return null;
          const cells: Cell[] = [];
          for (let row = range.top; row <= range.bottom; row++)
            cells.push(rows[row]?.[col] ?? null);
          const result = aggregates(cells);
          return (
            <section key={`${column.name}\u0000${col}`} className="p-3">
              <p className="mb-1.5 truncate text-xs font-medium" title={column.name}>
                {column.name}
              </p>
              <dl className="grid grid-cols-2 gap-x-2 gap-y-0.5 text-[11px]">
                <dt className="text-muted-foreground">{t("database.panel.count")}</dt>
                <dd className="text-right tabular-nums">{result.count - result.nulls}</dd>
                {result.sum !== null && (
                  <>
                    <dt className="text-muted-foreground">{t("database.panel.sum")}</dt>
                    <dd className="text-right tabular-nums">{formatNumber(result.sum)}</dd>
                    <dt className="text-muted-foreground">{t("database.panel.avg")}</dt>
                    <dd className="text-right tabular-nums">
                      {result.avg === null ? "" : formatNumber(result.avg)}
                    </dd>
                    <dt className="text-muted-foreground">{t("database.panel.min")}</dt>
                    <dd className="text-right tabular-nums">{result.min}</dd>
                    <dt className="text-muted-foreground">{t("database.panel.max")}</dt>
                    <dd className="text-right tabular-nums">{result.max}</dd>
                  </>
                )}
              </dl>
            </section>
          );
        })}
      </div>
    );
  };

  return (
    <aside
      className={cn(
        "bg-background flex shrink-0 flex-col overflow-hidden border-l",
        "h-full min-h-0"
      )}
      style={{ width: WIDTH }}
      aria-label={title}
    >
      <div className="flex shrink-0 items-center justify-between gap-2 border-b px-3 py-1.5">
        <span className="truncate text-xs font-medium">{title}</span>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t("database.grid.cancel")}
          title={t("database.grid.cancel")}
          onClick={() => onPanelChange(null)}
        >
          <X />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{body()}</div>
    </aside>
  );
}
