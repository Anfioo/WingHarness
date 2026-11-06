export type GridColumn = { name: string; typeName: string };
export type GridRange = { r0: number; c0: number; r1: number; c1: number };
export type ResultGridProps = {
  columns: GridColumn[];
  rows: (string | null)[][];
  onChange?: (row: number, column: number, value: string | null) => void;
  rowState?: (row: number) => "unchanged" | "updated" | "inserted" | "deleted";
  sort?: { column: string; descending: boolean }[];
  onSort?: (column: string) => void;
  filter?: (column: string, value: string | null) => boolean;
  onFilterChange?: (column: string, patterns: Set<string> | null) => void;
  onRowDeleted?: (row: number) => void;
};

export function ResultGrid(_props: ResultGridProps) {
  // The props are the frozen interface; the body is a stub.
  void _props;
  return <div className="text-muted-foreground p-3 text-sm">Result grid</div>;
}
