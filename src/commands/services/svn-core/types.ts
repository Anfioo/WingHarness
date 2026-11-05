// Payload shapes for the SVN workspace commands.
//
// Rust parameter names are snake_case (`workspace_path`, `old_rev`, `dry_run`);
// Tauri maps the camelCase keys sent from here onto them, so these types are the
// camelCase half of that contract.

import type { OpenTarget, StashUnversionedEntry } from "@/lib/svn-core/types";

export interface CheckoutPayload {
  url: string;
  path: string;
  revision?: number | null;
}

export interface UpdatePayload {
  path: string;
  revision?: number | null;
}

export interface SwitchPayload {
  path: string;
  url: string;
}

export interface MergePayload {
  path: string;
  source: string;
  revStart: number;
  revEnd: number;
}

export interface PathPayload {
  path: string;
}

export interface StatusPayload {
  path: string;
  force: boolean;
}

export interface CommitPayload {
  path: string;
  message: string;
  files?: string[] | null;
}

export interface FilesPayload {
  path: string;
  files: string[];
}

export interface ResolvePayload extends FilesPayload {
  strategy: string;
}

export interface ApplyPatchPayload {
  workspacePath: string;
  patch: string;
  reverse: boolean;
}

/** What a log query narrows by. Every field is optional but `path`. */
export interface LogQuery {
  limit?: number;
  startRev?: number;
  endRev?: number;
  keyword?: string;
  author?: string;
  dateFrom?: string;
  dateTo?: string;
}

export interface LogPayload extends LogQuery {
  path: string;
}

export interface DiffPayload {
  workspacePath: string;
  file: string;
  oldRev?: number | null;
  newRev?: number | null;
}

export interface BlamePayload {
  workspacePath: string;
  file: string;
}

export interface RestoreUnversionedPayload {
  path: string;
  files: StashUnversionedEntry[];
  dryRun: boolean;
}

export interface OpenTargetPayload {
  path: string;
  target: OpenTarget;
}

export interface RevealPayload {
  path: string;
  file: string;
}

export interface RememberPayload {
  path: string;
  revision?: number | null;
}

export interface ExportStashPayload {
  path: string;
  contents: string;
}

/** A raw key/value store read or remove: the key is a flat lowercase slug. */
export interface StoreKeyPayload {
  key: string;
}

/** A raw key/value store write. */
export interface StoreValuePayload {
  key: string;
  value: string;
}
