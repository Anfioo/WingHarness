/**
 * Small pure helpers for the OpenAPI import dialog: turn an `ImportResult`
 * into the counts and endpoint names the preview step shows, and derive a
 * default workspace name from a file path or URL.
 */
import type { CollectionNode, ImportResult } from "@/lib/api-core/types";

/** What the preview step renders for one parsed spec. */
export interface ImportSummary {
  /** The imported collection's name (the spec title). */
  collectionName: string;
  /** Tag folders beneath the collection. */
  folderCount: number;
  /** Every request in the import. */
  requestCount: number;
  /** Request names in tree order. */
  endpoints: string[];
}

/** Count folders/requests and collect endpoint names from a parsed import. */
export function summarizeImport(result: ImportResult): ImportSummary {
  const endpoints: string[] = [];
  let folderCount = 0;

  const visit = (node: CollectionNode, isRoot: boolean) => {
    if (!isRoot) folderCount += 1;
    for (const request of node.requests) endpoints.push(request.name);
    for (const child of node.children) visit(child, false);
  };
  for (const collection of result.collections) visit(collection, true);

  return {
    collectionName: result.collections.at(0)?.name ?? "",
    folderCount,
    requestCount: endpoints.length,
    endpoints,
  };
}

/** Last path segment of a file path or URL, without a spec extension. */
export function sourceBaseName(raw: string, fallback: string): string {
  const trimmed = raw.trim().replace(/[/\\]+$/, "");
  const last = trimmed.split(/[/\\]/).pop() ?? "";
  const stem = last.split(/[?#]/)[0].replace(/\.(ya?ml|json)$/i, "");
  return stem || fallback;
}
