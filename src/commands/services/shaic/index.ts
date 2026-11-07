import { invokeCommand } from "../../base";
import { getActiveProject } from "../../project-context";
import type {
  AgentDetailView,
  AgentRowView,
  ItemKind,
  ItemListView,
  OpResult,
  PlanView,
  Scope,
  StoreStatus,
} from "./types";

/**
 * The project the store is read against. The backend falls back to inferring it
 * from the process' working directory when this is `null`, which is what a
 * window with no project open wants.
 */
function projectRoot(root?: string): string | null {
  return (root ?? getActiveProject()) || null;
}

// ---------------------------------------------------------------------------
// Store status / setup wizard
// ---------------------------------------------------------------------------

/** Whether a store is set up, plus the paths the TUI would use. */
export function shaicStatus(root?: string): Promise<StoreStatus> {
  return invokeCommand("shaic_status", { root: projectRoot(root) });
}

/** Validate the remote, init/clone the store, and record the remote. */
export function shaicInit(remote: string, force = false): Promise<OpResult> {
  return invokeCommand("shaic_init", { remote, force });
}

// ---------------------------------------------------------------------------
// Push / pull
// ---------------------------------------------------------------------------

/** Commit and push the store. `allowSecrets` retries a secret-scan block. */
export function shaicPush(allowSecrets = false): Promise<OpResult> {
  return invokeCommand("shaic_push", { allowSecrets });
}

export function shaicPull(allowSecrets = false): Promise<OpResult> {
  return invokeCommand("shaic_pull", { allowSecrets });
}

// ---------------------------------------------------------------------------
// Dashboard / agent detail
// ---------------------------------------------------------------------------

/** One row per agent with its worst status across supported scopes/axes. */
export function shaicDashboard(root?: string): Promise<AgentRowView[]> {
  return invokeCommand("shaic_dashboard", { root: projectRoot(root) });
}

/** Break one agent down by scope, with content/MCP status per scope. */
export function shaicAgentDetail(agent: string, root?: string): Promise<AgentDetailView> {
  return invokeCommand("shaic_agent_detail", { agent, root: projectRoot(root) });
}

// ---------------------------------------------------------------------------
// Diff preview / apply / import
// ---------------------------------------------------------------------------

/** Compute what sync would change for one agent+scope, without writing. */
export function shaicPlan(
  agent: string,
  scope: Scope,
  isMcp: boolean,
  root?: string
): Promise<PlanView> {
  return invokeCommand("shaic_plan", { agent, scope, isMcp, root: projectRoot(root) });
}

/** Apply the (re-planned) changes for one agent+scope. */
export function shaicApply(
  agent: string,
  scope: Scope,
  isMcp: boolean,
  root?: string
): Promise<OpResult> {
  return invokeCommand("shaic_apply", { agent, scope, isMcp, root: projectRoot(root) });
}

/** Pull one agent+scope's on-disk files into the store. */
export function shaicImportScope(agent: string, scope: Scope, root?: string): Promise<OpResult> {
  return invokeCommand("shaic_import_scope", { agent, scope, root: projectRoot(root) });
}

// ---------------------------------------------------------------------------
// Item browser
// ---------------------------------------------------------------------------

/** List items, optionally narrowed to one kind. */
export function shaicListItems(kind?: ItemKind): Promise<ItemListView> {
  return invokeCommand("shaic_list_items", { kind: kind ?? null });
}

/** The starter text for a new item, as `$EDITOR` would open it. */
export function shaicItemTemplate(kind: ItemKind, name: string): Promise<string> {
  return invokeCommand("shaic_item_template", { kind, name });
}

/** The current text of an existing item (frontmatter + body). */
export function shaicItemSource(kind: ItemKind, name: string): Promise<string> {
  return invokeCommand("shaic_item_source", { kind, name });
}

/** Parse editor output and save it; `expectedName` refuses a rename. */
export function shaicSaveItem(
  kind: ItemKind,
  source: string,
  expectedName?: string
): Promise<OpResult> {
  return invokeCommand("shaic_save_item", { kind, source, expectedName: expectedName ?? null });
}

/** Remove an item, then materialize every agent immediately. */
export function shaicRemoveItem(kind: ItemKind, name: string, root?: string): Promise<OpResult> {
  return invokeCommand("shaic_remove_item", { kind, name, root: projectRoot(root) });
}
