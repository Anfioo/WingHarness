import { useMemo, useState } from "react";
import type { JSX } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import type { OutlineHeading } from "./extract";

interface OutlineNode {
  heading: OutlineHeading;
  children: OutlineNode[];
}

export interface OutlinePanelProps {
  headings: OutlineHeading[];
  activeId: string | null;
  onJump(line: number, id: string): void;
}

/** The document outline: a collapsible tree of headings, one row per heading. */
export function OutlinePanel({ headings, activeId, onJump }: OutlinePanelProps): JSX.Element {
  const { t } = useAppTranslation();
  const tree = useMemo(() => buildTree(headings), [headings]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  if (headings.length === 0) {
    return <p className="text-muted-foreground p-4 text-sm">{t("mdEditor.outline.empty")}</p>;
  }

  function toggle(id: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function renderNode(node: OutlineNode, depth: number): JSX.Element {
    const { heading, children } = node;
    const hasChildren = children.length > 0;
    const isCollapsed = collapsed.has(heading.id);

    return (
      <li key={heading.id}>
        <div className="flex items-center" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              aria-label={heading.text}
              aria-expanded={!isCollapsed}
              onClick={() => toggle(heading.id)}
              className="text-muted-foreground hover:text-foreground grid size-5 shrink-0 place-items-center rounded"
            >
              {isCollapsed ? (
                <ChevronRight className="size-3.5" />
              ) : (
                <ChevronDown className="size-3.5" />
              )}
            </button>
          ) : (
            <span className="size-5 shrink-0" />
          )}
          <button
            type="button"
            title={heading.text}
            onClick={() => onJump(heading.line, heading.id)}
            className={cn(
              "min-w-0 flex-1 truncate rounded px-1.5 py-1 text-left text-sm",
              activeId === heading.id
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            {heading.text}
          </button>
        </div>
        {hasChildren && !isCollapsed ? (
          <ul>{children.map((child) => renderNode(child, depth + 1))}</ul>
        ) : null}
      </li>
    );
  }

  return (
    <nav aria-label={t("mdEditor.outline.title")} className="h-full overflow-auto py-2 pr-2">
      <ul>{tree.map((node) => renderNode(node, 0))}</ul>
    </nav>
  );
}

/** Nest headings by level: a heading belongs to the nearest shallower one before it. */
function buildTree(headings: OutlineHeading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const stack: OutlineNode[] = [];

  for (const heading of headings) {
    const node: OutlineNode = { heading, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].heading.level >= heading.level) {
      stack.pop();
    }
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }

  return roots;
}
