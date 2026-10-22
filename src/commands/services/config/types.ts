export interface WorkspaceConfig {
  /**
   * Root the file browser and the preview open at, as a Windows path.
   *
   * Empty means no project has been chosen yet, which the pages render as an
   * empty state rather than an error.
   */
  root: string;
}

export interface AppConfig {
  workspace: WorkspaceConfig;
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
