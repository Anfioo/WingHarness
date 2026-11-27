/** What the configured proxy currently resolves to, for read-only display. */
export interface ProxyStatus {
  mode: ProxyMode;
  /** The effective address; `null` means direct. */
  url: string | null;
  /** The bypass list exported as `NO_PROXY`. */
  noProxy: string;
}

export interface AppConfig {
  proxy: ProxyConfig;
  filePreview: FilePreviewConfig;
  /** How the app launches and embeds the Codeg app. */
  codeg: CodegConfig;
  /** Networked mode shows the sidebar's account menu; standalone hides it. */
  networked: boolean;
}

/**
 * Where Codeg lives, and the sandbox it is given.
 *
 * Everything but `port` is a path on this machine; `dataDir` is empty by
 * default, which means `<data dir>/codeg` — a directory of its own, so the
 * embedded copy never touches the Codeg installation the user runs themselves.
 */
export interface CodegConfig {
  /** Codeg's checkout, used as the server's working directory. */
  repoPath: string;
  /** Codeg's static export, served by the server. */
  staticDir: string;
  /** The `codeg-server` binary. */
  serverPath: string;
  /** Port the server listens on, on loopback. */
  port: number;
  /** Codeg's data directory; empty means `<data dir>/codeg`. */
  dataDir: string;
}

/**
 * The preview page's display options and read threshold.
 *
 * `maxBytes` is enforced by the backend when it reads the file, so raising it
 * changes what the page is allowed to open rather than only what it draws.
 */
export interface FilePreviewConfig {
  /** Largest file the preview will read. */
  maxBytes: number;
  /** Syntax-highlight text previews and the file editor. */
  highlight: boolean;
}

export type ProxyMode = "none" | "system" | "custom";

/**
 * The outbound proxy the app and the tools it starts use.
 *
 * `mode` decides where the proxy comes from; `url` is only read in custom mode.
 */
export interface ProxyConfig {
  /** `none` goes direct, `system` uses the OS proxy, `custom` uses `url`. */
  mode: ProxyMode;
  /** Proxy URL, e.g. `http://127.0.0.1:7890`. A bare `host:port` is read as HTTP. */
  url: string;
  /** Comma-separated hosts that bypass the proxy; loopback is always bypassed. */
  noProxy: string;
}

export interface ConfigView {
  config: AppConfig;
  /** Where `config.json` lives. */
  path: string;
  /** Directory everything is stored in right now. */
  dataDir: string;
  /** Directory a restart would switch to; null when at the default. */
  dataDirConfigured: string | null;
  /** Directory used when none is configured. */
  dataDirDefault: string;
  /** The pointer file that names the configured directory. */
  dataDirPointer: string;
}
