// The toolbar above the object tree. A stub for now; the tree track fills it
// in.

import type { ReactNode } from "react";

export type TreeToolbarProps = {
  disabled: boolean;
  connected: boolean;
  onNewQuery(): void;
  onOpenQuery(): void;
  onNewTable(): void;
  onProperties(): void;
  onRefresh(): void;
  onDisconnect(): void;
  onJumpToConsole(): void;
  onEditData(): void;
  onShowDdl(): void;
  canEditData: boolean;
  canShowDdl: boolean;
};

export function TreeToolbar(props: TreeToolbarProps): ReactNode {
  void props;
  return null;
}
