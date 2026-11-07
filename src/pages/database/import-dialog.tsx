// The dialog that imports a CSV or SQL file into a table. A stub for now; the
// data-view track fills it in.

import type { ReactNode } from "react";

export type ImportDialogProps = {
  open: boolean;
  target: string;
  schema: string;
  table: string;
  columns: string[];
  onOpenChange(open: boolean): void;
  onImported(count: number): void;
};

export function ImportDialog(props: ImportDialogProps): ReactNode {
  void props;
  return null;
}
