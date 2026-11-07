// The record / value / aggregates side panel of a data grid. A stub for now;
// the data-view track fills it in.

import type { ReactNode } from "react";

import type { GridColumn, GridRange } from "./result-grid";
import type { Cell } from "./result-view";

export type DataPanel = "record" | "value" | "aggregates" | null;

export type DataPanelProps = {
  columns: GridColumn[];
  rows: Cell[][];
  selection: GridRange | null;
  panel: DataPanel;
  onPanelChange(panel: DataPanel): void;
};

export function DataPanel(props: DataPanelProps): ReactNode {
  void props;
  return null;
}
