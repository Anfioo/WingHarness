export type MoinTaskKind = "http" | "media";

export type MoinTaskStatus =
  | "queued"
  | "connecting"
  | "downloading"
  | "paused"
  | "moving"
  | "completed"
  | "failed"
  | "stalled"
  | "canceled";

export interface MoinTask {
  id: string;
  kind: MoinTaskKind;
  url: string;
  filename: string;
  dest: string;
  status: MoinTaskStatus;
  total: number | null;
  received: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  archived: boolean;
  active_ms: number;
  backend: string | null;
  category: string | null;
  final_dir: string | null;
  headers: Record<string, string>;
}

export interface MoinTaskProgress {
  id: string;
  received: number;
  total: number | null;
  speed: number;
  status: MoinTaskStatus;
}

export type MoinAddMethodKind = "manual-link" | "browser-capture";

export type MoinTrigger =
  | { type: "extension"; exts: string[] }
  | { type: "size"; min: number | null; max: number | null }
  | { type: "url-pattern"; patterns: string[] }
  | { type: "name-pattern"; patterns: string[] };

export interface MoinCategory {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  hidden_from_all: boolean;
  save_dir: string | null;
  incomplete_dir: string | null;
  sources: MoinAddMethodKind[];
  triggers: MoinTrigger[];
  order: number;
  [legacyField: string]: unknown;
}

export interface MoinSettings {
  max_concurrent: number;
  connections: number;
  min_split_size: number;
  hide_part_files: boolean;
  stall_timeout_secs: number;
  connect_timeout_secs: number;
  download_dir: string | null;
  proxy_url: string | null;
  aria2_path: string | null;
  rpc_enabled: boolean;
  rpc_port: number;
  rpc_token: string;
  notify_on_complete: boolean;
  add_paused: boolean;
  progress_flush_ms: number;
  http_backend: string;
}
