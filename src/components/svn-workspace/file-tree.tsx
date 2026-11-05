import { forwardRef, useImperativeHandle, useEffect, useRef } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  MouseEvent as ReactMouseEvent,
  ReactNode,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, ChevronRight, File as FileIcon, Folder, FolderOpen, Minus } from "lucide-react";
import type { SvnStatus } from "@/lib/svn-core/types";
import { cn } from "@/lib/utils";
import { StatusBadge } from "./status-badge";

/**
 * One visible line of the changes list: a file, or the directory node that
 * groups files. A directory's `targets` are every descendant file path, which
 * is what makes its tri-state checkbox and the "select a whole directory"
 * action cascade over the subtree.
 */
export interface ChangeTreeRow {
  kind: "dir" | "file";
  path: string;
  label: string;
  depth: number;
  entry?: SvnStatus;
  targets: string[];
}

export interface FileTreeHandle {
  scrollToIndex: (index: number) => void;
}

export interface FileTreeProps {
  rows: ChangeTreeRow[];
  selectedPaths: Set<string>;
  activePath: string | null;
  collapsedPaths: Set<string>;
  /** Changing this scrolls the list back to the top (filter / search / workspace). */
  resetKey?: string;
  ariaLabel?: string;
  rowHeight?: number;
  /** Per-file hover actions (diff, blame, …) supplied by the page. */
  renderActions?: (entry: SvnStatus, rowIndex: number) => ReactNode;
  onToggleCollapse: (path: string) => void;
  onToggleSelect: (row: ChangeTreeRow, rowIndex: number, event: ReactMouseEvent) => void;
  onActivate: (row: ChangeTreeRow, rowIndex: number, event: ReactMouseEvent) => void;
  onRowContextMenu?: (row: ChangeTreeRow, rowIndex: number, event: ReactMouseEvent) => void;
  onKeyDown?: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
}

/**
 * The changes list. Only the rows near the viewport are mounted
 * (`@tanstack/react-virtual`), so a working copy with tens of thousands of
 * entries stays responsive; the rest is one spacer of the measured height.
 */
export const FileTree = forwardRef<FileTreeHandle, FileTreeProps>(function FileTree(
  {
    rows,
    selectedPaths,
    activePath,
    collapsedPaths,
    resetKey,
    ariaLabel,
    rowHeight = 26,
    renderActions,
    onToggleCollapse,
    onToggleSelect,
    onActivate,
    onRowContextMenu,
    onKeyDown,
  },
  ref
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => rows[index]?.path ?? index,
    overscan: 10,
  });

  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => virtualizer.scrollToIndex(index, { align: "auto" }),
    }),
    [virtualizer]
  );

  useEffect(() => {
    if (resetKey === undefined) return;
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  // Keep the keyboard cursor in view when it moves past the visible window.
  useEffect(() => {
    if (!activePath) return;
    const index = rows.findIndex((row) => row.path === activePath);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "auto" });
  }, [activePath, rows, virtualizer]);

  const items = virtualizer.getVirtualItems();
  const total = virtualizer.getTotalSize();

  return (
    <div
      ref={scrollRef}
      role="tree"
      aria-label={ariaLabel}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className="relative flex-1 overflow-auto outline-none"
    >
      <div style={{ height: total, position: "relative" }}>
        {items.map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          const isDir = row.kind === "dir";
          const selectedInSubtree = row.targets.reduce(
            (count, path) => count + (selectedPaths.has(path) ? 1 : 0),
            0
          );
          const checked = isDir
            ? row.targets.length > 0 && selectedInSubtree === row.targets.length
            : selectedPaths.has(row.path);
          const partial = isDir && selectedInSubtree > 0 && !checked;
          const collapsed = collapsedPaths.has(row.path);
          const active = activePath === row.path;
          const entry = row.entry;

          return (
            <div
              key={item.key}
              role="treeitem"
              aria-selected={active}
              aria-checked={partial ? "mixed" : checked}
              aria-level={row.depth + 1}
              className={cn(
                "group/row border-border/50 flex h-full items-center gap-1.5 border-b px-2 text-xs",
                active ? "bg-accent text-accent-foreground" : "hover:bg-muted/50"
              )}
              style={{ paddingLeft: 8 + row.depth * 14 }}
              onClick={(event) => {
                if (isDir) onToggleCollapse(row.path);
                else onActivate(row, item.index, event);
              }}
              onContextMenu={(event) => onRowContextMenu?.(row, item.index, event)}
            >
              {isDir ? (
                <ChevronRight
                  className={cn(
                    "text-faint size-3.5 shrink-0 transition-transform",
                    !collapsed && "rotate-90"
                  )}
                />
              ) : (
                <span className="size-3.5 shrink-0" />
              )}
              <button
                type="button"
                role="checkbox"
                aria-checked={partial ? "mixed" : checked}
                aria-label={row.path}
                onClick={(event) => {
                  event.stopPropagation();
                  onToggleSelect(row, item.index, event);
                }}
                className={cn(
                  "grid size-4 shrink-0 place-items-center rounded-[4px] border transition-colors",
                  checked || partial
                    ? "border-primary bg-primary text-primary-foreground"
                    : "border-muted-foreground/40 hover:border-muted-foreground text-transparent"
                )}
              >
                {partial ? <Minus className="size-3" /> : <Check className="size-3" />}
              </button>
              {isDir ? (
                collapsed ? (
                  <Folder className="text-faint size-3.5 shrink-0" />
                ) : (
                  <FolderOpen className="text-faint size-3.5 shrink-0" />
                )
              ) : (
                <FileIcon className="text-faint size-3.5 shrink-0" />
              )}
              <span className="min-w-0 flex-1 truncate font-mono" title={row.path}>
                {row.label}
              </span>
              {entry ? <StatusBadge code={entry.statusCode} /> : null}
              {isDir ? <span className="text-faint text-[10px]">{row.targets.length}</span> : null}
              {entry && renderActions ? (
                <span className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/row:opacity-100 focus-within:opacity-100">
                  {renderActions(entry, item.index)}
                </span>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
});
