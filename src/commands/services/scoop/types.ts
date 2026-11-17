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
  /** `scoop hold`: pinned at this version, so `scoop update *` skips it. */
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
    | "hold"
    | "unhold"
    | "uninstall";
  /**
   * An app spec (`7zip`, `scoop install extras/vscode`, `scoop update 7zip`);
   * `update` and `apps-update` take nothing.
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
