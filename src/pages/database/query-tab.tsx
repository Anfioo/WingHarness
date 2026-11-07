// One query file of a data source window: the SQL editor above, the result
// tabs below. A stub for now; the workspace track fills it in.

import type { ReactNode } from "react";

export type QueryTabProps = {
  sourceId: string;
  tabKey: string;
  file: string;
};

export function QueryTab(props: QueryTabProps): ReactNode {
  void props;
  return null;
}
