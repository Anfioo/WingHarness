// Types that exist only at the IPC boundary, where the engine's own domain
// types (see `@/lib/git-core/types`) do not describe the payload.

export type OpOutcomeStatus = "ok" | "conflicts" | "up_to_date" | "fast_forward";

// Result of a history-rewriting or merging operation.
export interface OpOutcome {
  status: OpOutcomeStatus;
  message: string;
}

// A freshly generated SSH key pair. The private key never leaves the engine.
export interface GeneratedKey {
  path: string;
  publicKey: string;
}

// A hosting account stored by the engine. Tokens are held in secure storage,
// not in this shape.
export interface HostingAccount {
  host: string;
  username: string;
  provider: string;
  verified: boolean;
  email?: string | null;
  verifiedAt?: number | null;
  expiresAt?: string | null;
  isDefault?: boolean;
}

export interface EditorInfo {
  id: string;
  label: string;
  path: string;
  launch: "binary" | "app";
}

export interface FontFamily {
  family: string;
  monospaced: boolean;
}

export type AccountCheckStatus = "ok" | "unauthorized" | "unreachable" | "unsupported" | "no_token";

export interface AccountCheckResult {
  status: AccountCheckStatus;
  expiresAt: string | null;
  accounts: HostingAccount[];
}

// What this build of libgit2 can do; drives which remote features the UI
// offers.
export interface EngineInfo {
  version: string;
  libgit2: string;
  https: boolean;
  ssh: boolean;
}

export interface HttpRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

export interface HttpResponse {
  status: number;
  body: string;
}

export interface CliAgentInfo {
  id: string;
  label: string;
  path: string;
  version: string;
}

export interface CliRunRequest {
  program: string;
  args: string[];
  stdin?: string;
  timeoutSecs?: number;
}

export interface CliRunResult {
  status: number;
  stdout: string;
  stderr: string;
  output: string | null;
}
