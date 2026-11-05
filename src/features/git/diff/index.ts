import { createElement, type ComponentType } from "react";
import { useUi, type CenterDiffTarget } from "@/features/git/ui-store";
import { AllChangesView } from "./all-changes-view";
import { DiffPanel } from "./diff-panel";
import * as changeNav from "./change-nav";
import * as diffSearch from "./diff-search";

const AllChanges = AllChangesView as ComponentType<{ target: CenterDiffTarget & { oid: string } }>;
const Panel = DiffPanel as ComponentType<{ target: CenterDiffTarget }>;

function resolveTarget(
  centerDiff: CenterDiffTarget | null,
  selectedFile: { path: string; staged: boolean } | null
) {
  if (centerDiff) return centerDiff;
  if (selectedFile)
    return { path: selectedFile.path, staged: selectedFile.staged } satisfies CenterDiffTarget;
  return null;
}

export function CenterDiffView() {
  const centerDiff = useUi((s) => s.centerDiff);
  const selectedFile = useUi((s) => s.selectedFile);
  const diffLayout = useUi((s) => s.diffLayout);

  const target = resolveTarget(centerDiff, selectedFile);
  if (!target) return null;

  if (diffLayout === "all" && target.oid && !target.stash) {
    return createElement(AllChanges, { target: { ...target, oid: target.oid } });
  }
  return createElement(Panel, { target });
}

export { AllChangesView } from "./all-changes-view";
export { DiffPanel } from "./diff-panel";
export { diffSearch, changeNav };
