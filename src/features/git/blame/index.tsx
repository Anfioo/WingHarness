import { useCallback } from "react";
import { useUi } from "@/features/git/ui-store";
import { useGraph } from "@/features/git/graph/store";
import { useRepo } from "@/features/git/repository-store";
import { BlameView as BlamePane } from "./BlameView";

export function BlameView() {
  const path = useRepo((s) => s.repo?.path ?? "");
  const file = useUi((s) => s.centerFileHistory) ?? "";
  const preset = useUi((s) => s.fileHistoryPreset);
  const rev = preset?.rev ?? null;
  const openBlame = useUi((s) => s.openBlame);
  const closeFileHistory = useUi((s) => s.closeFileHistory);
  const revealCommit = useGraph((s) => s.revealCommit);

  const onOpenCommit = useCallback(
    (oid: string) => {
      if (!path) return;
      void revealCommit(path, oid);
      closeFileHistory();
    },
    [path, revealCommit, closeFileHistory]
  );

  const onBlameAt = useCallback(
    (next: string) => {
      if (!file) return;
      openBlame(file, next);
    },
    [file, openBlame]
  );

  const onResolvedRev = useCallback(() => {}, []);

  if (!file) return null;

  return (
    <BlamePane
      file={file}
      rev={rev}
      onOpenCommit={onOpenCommit}
      onBlameAt={onBlameAt}
      onResolvedRev={onResolvedRev}
    />
  );
}

export { BlamePane };
