import type { CollectionNode, RequestDef } from "@/lib/api-core/types";

/**
 * One row of the collection tree: a folder/collection (which may nest) or a
 * request (always a leaf). Built from the store's `CollectionNode` forest so the
 * generic `FileTree` control stays unaware of the domain model.
 */
export type TreeEntry =
  | { kind: "node"; id: string; name: string; node: CollectionNode; children: TreeEntry[] }
  | { kind: "request"; id: string; name: string; request: RequestDef };

/** Child entries of an entry; requests have none. */
export function entryChildren(entry: TreeEntry): TreeEntry[] {
  return entry.kind === "node" ? entry.children : [];
}

/**
 * Turn a collection forest into renderable tree entries, applying an optional
 * name filter. A node is kept when its own name matches or any descendant
 * matches; requests are matched by name. An empty query returns the whole tree.
 */
export function buildTreeEntries(collections: CollectionNode[], query: string): TreeEntry[] {
  const needle = query.trim().toLowerCase();
  const entries: TreeEntry[] = [];
  for (const node of collections) {
    const children = buildTreeEntries(node.children, query);
    const requests: TreeEntry[] = node.requests
      .filter((request) => needle === "" || request.name.toLowerCase().includes(needle))
      .map((request) => ({ kind: "request", id: request.id, name: request.name, request }));
    const selfMatches = needle === "" || node.name.toLowerCase().includes(needle);
    if (selfMatches || children.length > 0 || requests.length > 0) {
      entries.push({
        kind: "node",
        id: node.id,
        name: node.name,
        node,
        // Folders before requests, each already filtered.
        children: [...children, ...requests],
      });
    }
  }
  return entries;
}

/** Ids of every node entry in a forest, used to show all matches while filtering. */
export function collectNodeIds(entries: TreeEntry[]): string[] {
  const ids: string[] = [];
  for (const entry of entries) {
    if (entry.kind !== "node") continue;
    ids.push(entry.id, ...collectNodeIds(entry.children));
  }
  return ids;
}
