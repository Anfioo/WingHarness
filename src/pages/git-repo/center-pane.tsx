import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { CenterDiffView } from "@/features/git/diff";
import { EditorPanel } from "@/features/git/editor";
import { CommitGraph } from "@/features/git/graph";
import { FileHistoryPanel } from "@/features/git/history/FileHistoryPanel";
import { TerminalPanel } from "@/features/git/terminal";
import { useUi } from "@/features/git/ui-store";
import { cn } from "@/lib/utils";

interface CenterPaneProps {
  /** Repo-scoped id so the graph/diff split is remembered per repository. */
  layoutId: string;
  className?: string;
}

export function CenterPane({ layoutId, className }: CenterPaneProps) {
  const centerDiff = useUi((s) => s.centerDiff);
  const centerEditor = useUi((s) => s.centerEditor);
  const centerFileHistory = useUi((s) => s.centerFileHistory);
  const terminalOpen = useUi((s) => s.terminalOpen);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: layoutId });

  if (centerEditor) {
    return (
      <div className={cn("bg-background h-full", className)}>
        <EditorPanel file={centerEditor} />
      </div>
    );
  }

  if (centerFileHistory) {
    return (
      <div className={cn("bg-background h-full", className)}>
        <FileHistoryPanel />
      </div>
    );
  }

  if (centerDiff) {
    return (
      <div className={cn("bg-background h-full", className)}>
        <CenterDiffView />
      </div>
    );
  }

  return (
    <div className={cn("h-full", className)}>
      <Group
        orientation="vertical"
        className="h-full"
        defaultLayout={defaultLayout}
        onLayoutChanged={onLayoutChanged}
      >
        <Panel id="graph" defaultSize="60" minSize="20" className="overflow-hidden">
          <CommitGraph />
        </Panel>
        <Separator className="bg-border h-px" />
        <Panel id="diff" defaultSize="40" minSize="20" className="overflow-hidden">
          <CenterDiffView />
        </Panel>
        {terminalOpen && (
          <>
            <Separator className="bg-border h-px" />
            <Panel
              id="terminal"
              defaultSize="30"
              minSize="12"
              maxSize="60"
              className="overflow-hidden"
            >
              <TerminalPanel />
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
