// The query history of one data source, as a dialog the console can paste
// from. A stub for now; the console track fills it in.

import type { ReactNode } from "react";

export type HistoryDialogProps = {
  open: boolean;
  sourceId: string;
  onOpenChange(open: boolean): void;
  onPaste(text: string): void;
};

export function HistoryDialog(props: HistoryDialogProps): ReactNode {
  void props;
  return null;
}
