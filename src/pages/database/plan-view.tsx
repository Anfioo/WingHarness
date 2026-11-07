// The execution plan of one statement, as a tree with a property panel. A stub
// for now; the data-view track fills it in.

import type { ReactNode } from "react";

import type { PlanNode } from "@/commands";

export type PlanViewProps = {
  nodes: PlanNode[];
  busy?: boolean;
  onExplainAgain(): void;
};

export function PlanView(props: PlanViewProps): ReactNode {
  void props;
  return null;
}
