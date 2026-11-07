// The dialog that asks for the values of a script's parameters before it runs.
// A stub for now; the console track fills it in.

import type { ReactNode } from "react";

export type ParamsDialogProps = {
  open: boolean;
  names: string[];
  onOpenChange(open: boolean): void;
  onSubmit(values: Record<string, string>): void;
};

export function ParamsDialog(props: ParamsDialogProps): ReactNode {
  void props;
  return null;
}
