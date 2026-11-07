// The quick documentation popup of a schema object. A stub for now; the
// console track fills it in.

import type { ReactNode } from "react";

import type { DbObjectRef } from "./object-sql";

export type QuickDocProps = {
  open: boolean;
  target: string;
  object: DbObjectRef;
  onOpenChange(open: boolean): void;
};

export function QuickDoc(props: QuickDocProps): ReactNode {
  void props;
  return null;
}
