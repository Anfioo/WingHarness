/** Status of one scope/axis in the agent dashboard — mirrors `SyncStatus` in `src-tauri/src/shaic/commands.rs`. */
export type SyncStatus = "in-sync" | "drift" | "unconfirmed" | "error";

/** Severity of a result message — mirrors `MessageKind`. */
export type MessageKind = "success" | "warning" | "info" | "error";

/** Item kinds shaic can manage. */
export type ItemKind = "skill" | "rule" | "command" | "subagent";

/** Scopes shaic materializes into. */
export type Scope = "global" | "project";

/** The result of a store write, as the TUI message bar would show it. */
export interface OpResult {
  text: string;
  kind: MessageKind;
  /**
   * True when a secret scan blocked the operation; the UI should confirm an
   * override and retry with `allowSecrets: true`.
   */
  forceRequired: boolean;
}

export interface StoreStatus {
  exists: boolean;
  remote: string | null;
  projectRoot: string;
  storePath: string;
  enabledAgents: string[];
}

export interface AgentSubRowView {
  scope: Scope;
  contentStatus: SyncStatus | null;
  mcpStatus: SyncStatus | null;
}

export interface AgentRowView {
  id: string;
  name: string;
  status: SyncStatus;
  subRows: AgentSubRowView[];
}

/** One axis of one agent+scope: the content files, or the MCP servers. */
export interface AxisView {
  /** `content` or `mcp`. */
  axis: "content" | "mcp";
  status: SyncStatus;
  /** The path this axis reads and writes; null when the agent has no trusted one. */
  location: string | null;
  /** Content only: the convention isn't confirmed, so nothing is written here. */
  readOnly: boolean;
  /** Content only: how many of each supported kind exist on disk. Empty for MCP. */
  kinds: KindCountView[];
  /** Files the pending plan would write (create + update). */
  toWrite: number;
  /** Files the pending plan would delete or remove. */
  toDelete: number;
  /** Why the plan could not be computed; null when it could. */
  error: string | null;
}

export interface KindCountView {
  kind: ItemKind;
  /** How many of this kind exist on disk for the agent+scope. */
  onDisk: number;
}

export interface ScopeView {
  scope: Scope;
  /** `content` first, then `mcp`. */
  axes: AxisView[];
}

export interface AgentDetailView {
  agent: string;
  displayName: string;
  scopes: ScopeView[];
}

export interface ChangeLineView {
  action: "create" | "update" | "delete" | "remove" | "noop";
  target: string;
}

export interface PlanView {
  agent: string;
  scope: Scope;
  isMcp: boolean;
  changes: ChangeLineView[];
  skipped: string[];
  warnings: string[];
  isEmpty: boolean;
}

export interface ItemView {
  kind: ItemKind;
  name: string;
  description: string;
  scope: Scope[];
  agents: string[];
  tags: string[];
  appliesTo: string[];
}

export interface ItemListView {
  items: ItemView[];
  warnings: string[];
}
