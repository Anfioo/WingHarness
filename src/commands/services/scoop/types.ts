/** Where the Scoop folder comes from. */
export type ScoopLocation = "data" | "user" | "custom";

/** `inherit` follows Settings → Proxy; the other two are page overrides. */
export type ScoopProxyMode = "inherit" | "none" | "custom";

/** One environment variable a prepared terminal run receives. */
export interface ScoopEnvVar {
  name: string;
  value: string;
}

export interface ScoopProxy {
  mode: "none" | "system" | "custom";
  /** The concrete address, when one is known. */
  url: string | null;
  /** `settings` when it follows the app's proxy section, `page` otherwise. */
  source: "settings" | "page";
}

export interface ScoopBucket {
  name: string;
  apps: number;
  path: string;
}

export interface ScoopApp {
  name: string;
  version: string | null;
  description: string | null;
  homepage: string | null;
  bucket: string | null;
  /** Installed under `SCOOP_GLOBAL` instead of `SCOOP`. */
  global: boolean;
  /** Pinned at this version: the flag Scoop keeps in the app's install
   * record, so `scoop update *` skips it. */
  hold: boolean;
  /** A WingHarness plugin: the app name carries the plugin prefix. */
  plugin: boolean;
}

export interface ScoopSearchHit {
  name: string;
  bucket: string;
  version: string | null;
  description: string | null;
  homepage: string | null;
  installed: boolean;
  /** A WingHarness plugin: the app name carries the plugin prefix. */
  plugin: boolean;
}

export interface ScoopStatus {
  installed: boolean;
  version: string | null;

  /** `SCOOP`: the fixed link `ScoopCurrent`. */
  root: string;
  /** The real `scoop` folder the link points at. */
  target: string;
  link: string | null;
  linkTarget: string | null;

  /** `SCOOP_GLOBAL`: the fixed link `ScoopGlobalCurrent`. */
  globalRoot: string;
  /** The real `scoopg` folder the link points at. */
  globalTarget: string;
  globalLink: string | null;
  globalLinkTarget: string | null;

  dataDir: string;
  defaultDir: string;
  userDir: string | null;
  userGlobalDir: string | null;
  envScoop: string | null;
  envScoopGlobal: string | null;
  /** A usable install somewhere else, for the adopt prompt. */
  otherInstall: string | null;
  proxy: ScoopProxy;
  buckets: ScoopBucket[];
  apps: ScoopApp[];
}

export interface ScoopPlan {
  root: string;
  target: string;
  link: string | null;
  globalRoot: string;
  globalTarget: string;
  globalLink: string | null;
  workDir: string;
  /** File name to run, relative to `workDir`. */
  command: string;
  scriptPath: string;
  /** The script's full text, shown before it runs. */
  script: string;
  env: ScoopEnvVar[];
  proxy: ScoopProxy;
  log: string[];
}

/** One folder choice: `data`, `user` or `custom`. */
export interface ScoopPathChoice {
  location: ScoopLocation;
  customPath?: string | null;
}

export interface ScoopLocationRequest {
  /** The `SCOOP` folder (`scoop`, behind `ScoopCurrent`). */
  scoop: ScoopPathChoice;
  /** The `SCOOP_GLOBAL` folder (`scoopg`, behind `ScoopGlobalCurrent`). */
  scoopGlobal: ScoopPathChoice;
}

export interface ScoopInstallRequest extends ScoopLocationRequest {
  proxyMode: ScoopProxyMode;
  proxyUrl?: string | null;
  /**
   * Pass `-RunAsAdmin` to the installer. The official installer aborts when it
   * sees an elevated token unless this flag is given, which is the case for an
   * account running with UAC off or an app started as administrator.
   */
  runAsAdmin?: boolean;
}

export interface ScoopRunRequest {
  kind:
    | "install"
    | "search"
    | "config"
    | "update"
    | "apps-update"
    | "app-update"
    | "cleanup"
    | "uninstall";
  /**
   * An app spec (`7zip`, `scoop install extras/vscode`, `scoop update 7zip`);
   * `update`, `apps-update` and `cleanup` take nothing.
   */
  spec: string;
  /** The app lives under `SCOOP_GLOBAL`, so the command carries `-g`. */
  global?: boolean;
  /** `uninstall` also removes the app's `persist` folder (`-p`). */
  purge?: boolean;
  proxyMode: ScoopProxyMode;
  proxyUrl?: string | null;
}

/** A bucket the app clones itself, with the page's proxy. */
export interface ScoopBucketRequest {
  /** `<name> <url>`, or a bare repository URL. */
  spec: string;
  proxyMode: ScoopProxyMode;
  proxyUrl?: string | null;
}

export interface ScoopBucketResult {
  name: string;
  path: string;
  /** The steps taken, handed to the page's log as they are. */
  log: string[];
}

/** One package, as its manifest describes it. */
export interface ScoopPackageInfo {
  name: string;
  /** The bucket the details were read from. */
  bucket: string | null;
  installed: boolean;
  global: boolean;
  /** The manifest's own version: what an install would fetch. */
  version: string | null;
  /** What is on disk, which a held app keeps behind `version`. */
  installedVersion: string | null;
  description: string | null;
  homepage: string | null;
  license: string | null;
  licenseUrl: string | null;
  notes: string | null;
  depends: string[];
  suggests: string[];
  /** The commands the manifest puts on `PATH`, aliases included. */
  bins: string[];
  manifestPath: string;
  /** The manifest exactly as it is on disk. */
  manifest: string;
}

/** One bucket: the repository its clone came from, and what is in it. */
export interface ScoopBucketInfo {
  name: string;
  path: string;
  /** Manifest names, sorted: the bucket's catalog. */
  packages: string[];
  remote: string | null;
  branch: string | null;
  commit: string | null;
  /** Last commit time, in seconds since the Unix epoch. */
  committedAt: number | null;
  subject: string | null;
}

/** What the detail sheet is showing. */
export type ScoopDetailTarget =
  | { kind: "package"; name: string; bucket: string | null; global: boolean }
  | { kind: "bucket"; name: string };

/** What the checkup offers for a failed row. */
export type ScoopCheckupFix =
  | { kind: "installPackage"; package: string }
  | { kind: "installBucket"; name: string; url: string }
  | { kind: "openSettings"; page: string };

/** The checks the diagnostics tab runs, in the order they are shown. */
export type ScoopCheckupId =
  | "git"
  | "mainBucket"
  | "developerMode"
  | "longPaths"
  | "ntfs"
  | "helper";

/** One row of the checkup. */
export interface ScoopCheckupItem {
  id: ScoopCheckupId;
  ok: boolean;
  /** What was measured: the git version, the filesystem, the helper's name. */
  value: string | null;
  fix: ScoopCheckupFix | null;
}

/** One download Scoop kept, named `name#version#hash.ext`. */
export interface ScoopCacheEntry {
  fileName: string;
  name: string;
  version: string;
  length: number;
  /** The app is installed from several versions, so the file stays. */
  versioned: boolean;
}

export interface ScoopCache {
  path: string;
  total: number;
  entries: ScoopCacheEntry[];
}

export interface ScoopCacheClear {
  deleted: number;
  skipped: number;
  freed: number;
  failed: string[];
}

/** One launcher on `PATH`. */
export interface ScoopShim {
  name: string;
  /** What the shim runs: the `.shim` file's `path`, or the script itself. */
  target: string;
  /** The app under `apps\<name>`, when the target is inside one. */
  app: string | null;
  args: string | null;
  global: boolean;
  /** Renamed to `<name>.exe.shimmed`: the shim is out of the way. */
  hidden: boolean;
}

/** A shim to write: the `.shim` file and a copy of Scoop's launcher. */
export interface ScoopShimRequest {
  name: string;
  target: string;
  args?: string | null;
  global: boolean;
}
