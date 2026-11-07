// The result tabs of one query tab: one tab per statement plus the output
// console. A stub for now; the data-view track fills it in.

import type { ReactNode } from "react";

export type ResultTabsProps = {
  /** The query tab's key. Not `key`: React would consume that name. */
  tabKey: string;
  sourceId: string;
  target: string;
};

export function ResultTabs(props: ResultTabsProps): ReactNode {
  void props;
  return null;
}
