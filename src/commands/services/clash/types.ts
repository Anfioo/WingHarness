// Wire shapes for the `prism-core` commands. The Rust side serializes with
// `rename_all = "camelCase"`, so these mirror the structs field for field.

export type ClashProfile = {
  id: string;
  name: string;
  size: number;
  active: boolean;
};

export type RuleFileInfo = {
  /** Base name, without a `.disabled` suffix: `ad-filter.prism.yaml`. */
  filename: string;
  ruleCount: number;
  /** Detected dialect: `clash` | `surge` | `unknown` | `empty`. */
  source: string;
  enabled: boolean;
};

export type RuleGroupEntry = {
  name: string;
  files: string[];
};

export type RuleGroups = {
  groups: RuleGroupEntry[];
};

export type CoreProbe = {
  found: boolean;
  path: string;
  version: string | null;
};

export type CoreStatus = {
  running: boolean;
  pid: number | null;
  binary: CoreProbe;
  /** The controller address the compiled output names. */
  api: string | null;
  /** Whether that address answers right now; `running` only says the child lives. */
  apiReachable: boolean;
  /** Why the controller does not answer; null while it does. */
  apiError: string | null;
};

export type PrismStatusView = {
  watching: boolean;
  watchingCount: number;
  lastCompileTime: string | null;
  lastCompileSuccess: boolean;
  patchCount: number;
  scriptCount: number;
  pluginCount: number;
};

export type ClashSummary = {
  root: string;
  prismDir: string;
  profilesDir: string;
  runDir: string;
  activeProfile: string | null;
  profiles: ClashProfile[];
  rules: RuleFileInfo[];
  groups: RuleGroups;
  core: CoreStatus;
  status: PrismStatusView;
  outputReady: boolean;
};

export type CompileStats = {
  totalPatches: number;
  succeeded: number;
  skipped: number;
  totalAdded: number;
  totalRemoved: number;
  totalModified: number;
  totalDurationUs: number;
  avgDurationUs: number;
};

export type TraceEntry = {
  patchId: string;
  sourceFile: string | null;
  opName: string;
  durationUs: number;
  conditionMatched: boolean;
  added: number;
  removed: number;
  modified: number;
  totalBefore: number;
  totalAfter: number;
  diffAdded: string[];
  diffRemoved: string[];
};

export type CompileView = {
  output: string;
  stats: CompileStats;
  trace: TraceEntry[];
};

export type ApplyView = CompileView & {
  message: string;
  hotReload: boolean;
};

export type ValidateView = {
  valid: boolean;
  output: string;
};

export type ClashSubscription = {
  name: string;
  url: string;
  /** Profile the download lands in, e.g. `airport.yaml`. */
  profile: string;
  /** Unix seconds of the last successful download. */
  lastUpdated: number | null;
  size: number;
  upload: number;
  download: number;
  total: number;
  /** Unix seconds the provider says the plan runs out. */
  expire: number | null;
  /** Why the last download failed; null after a success. */
  error: string | null;
};

export type ClashConnection = {
  id: string;
  host: string;
  network: string;
  kind: string;
  source: string;
  destination: string;
  upload: number;
  download: number;
  start: string;
  chains: string[];
  rule: string;
  rulePayload: string;
  process: string;
};

export type ClashConnectionsView = {
  uploadTotal: number;
  downloadTotal: number;
  connections: ClashConnection[];
};

export type ClashProxyNode = {
  name: string;
  /** `Shadowsocks`, `Vmess`, `Selector`, … — a member may itself be a group. */
  kind: string;
  alive: boolean;
  /** Last delay in milliseconds; null before the node has been probed. */
  delay: number | null;
};

export type ClashProxyGroup = {
  name: string;
  /** `Selector`, `URLTest`, `Fallback`, `LoadBalance`, … */
  kind: string;
  /** Member traffic currently leaves through; empty for automatic groups. */
  now: string;
  members: ClashProxyNode[];
};

export type ClashProxiesView = {
  groups: ClashProxyGroup[];
};

/** One rule in the running core's routing table, in evaluation order. */
export type ClashRoutingRule = {
  /** `DomainSuffix`, `GeoIP`, `Match`, … */
  kind: string;
  /** The value the rule matches; empty for `MATCH`. */
  payload: string;
  /** The group or node the request is handed to. */
  proxy: string;
};

export type ClashRulesView = {
  rules: ClashRoutingRule[];
};

/** What the core says it is doing right now, read from its controller. */
export type ClashRuntime = {
  /** `rule` | `global` | `direct`, in the core's spelling. */
  mode: string;
  /** The port Windows' system proxy should name: mixed, or plain HTTP. */
  httpPort: number | null;
  socksPort: number | null;
  mixedPort: number | null;
};

export type ClashSysProxyStatus = {
  supported: boolean;
  enabled: boolean;
  /** The address Windows is pointed at, e.g. `127.0.0.1:7890`. */
  server: string | null;
};

/** One line the core printed, as logrus wrote it to the log file. */
export type ClashLogLine = {
  /** The core's own timestamp; empty for a line that is not a record. */
  time: string;
  /** `debug` | `info` | `warning` | `error` | `fatal` | `other`. */
  level: string;
  message: string;
};

export type ClashLogsView = {
  /** Oldest first. */
  lines: ClashLogLine[];
};

/** One site the test tab fetches through the running core. */
export type ClashTestSite = {
  id: string;
  name: string;
  url: string;
};

/** What one check measured. A site that cannot be reached rejects instead. */
export type ClashTestResult = {
  /** Milliseconds from sending the request to reading the response headers. */
  delay: number;
  /** HTTP status the site answered with. */
  status: number;
};

/** The core process's own cost, read from the operating system. */
export type ClashCoreMetrics = {
  /** Time since the core process started. */
  uptimeMs: number | null;
  /** Working set in bytes. */
  memory: number | null;
};

/** The address traffic currently exits from, as a geo lookup service sees it. */
export type ClashIpInfo = {
  ip: string;
  country: string;
  countryCode: string;
  region: string;
  city: string;
  organization: string;
  asn: number | null;
  asnOrganization: string;
  longitude: number | null;
  latitude: number | null;
  timezone: string;
};
