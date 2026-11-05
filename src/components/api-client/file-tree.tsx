import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** Per-row metadata handed to `renderItem`. */
export interface FileTreeItemMeta {
  /** Nesting level; `0` for a root item, one more per ancestor. */
  depth: number;
  /** Whether this item is currently expanded (always false without children). */
  expanded: boolean;
  /** Whether this item has children to expand into. */
  hasChildren: boolean;
  /** Toggle this item's expanded state. */
  toggle: () => void;
}

export interface FileTreeProps<T> {
  /** Root items, in render order. */
  items: T[];
  /** Stable identity for an item; also the key used for expansion and selection. */
  getKey: (item: T) => string;
  /** Nested items, in render order. Defaults to none (a flat list). */
  getChildren?: (item: T) => T[];
  /** Keys that are currently expanded. */
  expanded: ReadonlySet<string>;
  /** Called when an item's chevron/row requests a toggle. */
  onToggle: (key: string) => void;
  /** Key of the highlighted item, if any. */
  selectedKey?: string | null;
  /** Draws one row; the caller owns indentation (via `meta.depth`) and chevrons. */
  renderItem: (item: T, meta: FileTreeItemMeta) => ReactNode;
  className?: string;
  "aria-label"?: string;
}

/**
 * A small presentational tree: nested `items` rendered through a caller-supplied
 * row renderer, with the caller owning expansion state, selection and row
 * content. It knows nothing about collections or requests, so the same control
 * can back any hierarchical list.
 */
export function FileTree<T>({
  items,
  getKey,
  getChildren,
  expanded,
  onToggle,
  selectedKey,
  renderItem,
  className,
  "aria-label": ariaLabel,
}: FileTreeProps<T>): ReactNode {
  return (
    <ul role="tree" aria-label={ariaLabel} className={cn("flex flex-col", className)}>
      {items.map((item) => (
        <FileTreeItem
          key={getKey(item)}
          item={item}
          depth={0}
          getKey={getKey}
          getChildren={getChildren}
          expanded={expanded}
          onToggle={onToggle}
          selectedKey={selectedKey}
          renderItem={renderItem}
        />
      ))}
    </ul>
  );
}

interface FileTreeItemProps<T> extends Omit<
  FileTreeProps<T>,
  "items" | "className" | "aria-label"
> {
  item: T;
  depth: number;
}

function FileTreeItem<T>({
  item,
  depth,
  getKey,
  getChildren,
  expanded,
  onToggle,
  selectedKey,
  renderItem,
}: FileTreeItemProps<T>): ReactNode {
  const key = getKey(item);
  const children = getChildren ? getChildren(item) : [];
  const hasChildren = children.length > 0;
  const isExpanded = hasChildren && expanded.has(key);

  return (
    <li
      role="treeitem"
      aria-expanded={hasChildren ? isExpanded : undefined}
      aria-selected={selectedKey === key}
      className="flex flex-col"
    >
      {renderItem(item, {
        depth,
        expanded: isExpanded,
        hasChildren,
        toggle: () => onToggle(key),
      })}
      {isExpanded ? (
        <ul role="group" className="flex flex-col">
          {children.map((child) => (
            <FileTreeItem
              key={getKey(child)}
              item={child}
              depth={depth + 1}
              getKey={getKey}
              getChildren={getChildren}
              expanded={expanded}
              onToggle={onToggle}
              selectedKey={selectedKey}
              renderItem={renderItem}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

export default FileTree;
