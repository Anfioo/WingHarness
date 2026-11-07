// The editable grid a table data tab and a query result share. A stub for now;
// the data-view track fills it in.

import type { ReactNode } from "react";

import type { DataPanel } from "./data-panel";
import type { GridColumn } from "./result-grid";
import type { Cell } from "./result-view";

/** One entry of the context menu a grid shows for its selected rows. */
export type GridMenuItem = {
  id: string;
  label: string;
  disabled?: boolean;
  destructive?: boolean;
  run(): void;
};

export type DataViewProps = {
  columns: GridColumn[];
  rows: Cell[][];
  rowCount: number;
  rowState?: (row: number) => "unchanged" | "updated" | "inserted" | "deleted";
  isModified?: (row: number, col: number) => boolean;
  editable?: boolean;
  onChange?: (row: number, col: number, value: Cell) => void;
  sort?: { column: string; descending: boolean }[];
  onSort?: (column: string, add: boolean) => void;
  firstRowNumber?: number;
  rowMenu?: (rows: number[]) => GridMenuItem[];
  panel: DataPanel;
  onPanelChange(panel: DataPanel): void;
  searchOpen: boolean;
  onSearchOpenChange(open: boolean): void;
  onFind?: () => void;
  ariaLabel?: string;
};

export function DataView(props: DataViewProps): ReactNode {
  void props;
  return null;
}
