export interface AppConfig {
  aiConfig: AiConfig;
  proxy: ProxyConfig;
}

/**
 * The outbound proxy the app and the tools it starts use.
 *
 * An empty `url` means "leave the environment alone", so a proxy exported by the
 * shell that launched the app keeps working.
 */
export interface ProxyConfig {
  /** Proxy URL, e.g. `http://127.0.0.1:7890`. A bare `host:port` is read as HTTP. */
  url: string;
  /** Comma-separated hosts that bypass the proxy; loopback is always bypassed. */
  noProxy: string;
}

/** One switch in the settings page's agent list. */
export interface AgentOption {
  /** Agent id, e.g. `claude-code`. */
  id: string;
  /** Display name, e.g. `Claude Code`. */
  name: string;
}

export interface AiConfig {
  /**
   * Agent ids allowed to be synced.
   *
   * `null` (the key is absent) means every agent — the default. An explicit list
   * is taken literally, so an empty array means "no agents".
   */
  enabledAgents: string[] | null;
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
  /** Agents the AI config sync page can manage, in registry order. */
  aiAgents: AgentOption[];
}
