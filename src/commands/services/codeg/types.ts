/**
 * Where the Codeg page sits, in logical pixels relative to the window — the
 * same units CSS uses, so a measured `getBoundingClientRect()` is passed
 * straight through.
 */
export interface CodegBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The app's appearance as the Codeg page needs it.
 *
 * `mode` is already resolved: Codeg is never told "system", because the app has
 * resolved that question itself and the page must not answer it differently.
 * `custom` is the value of Codeg's own `codeg-custom-theme` storage key — a
 * string, because the page reads it back from `localStorage` verbatim.
 */
export interface CodegTheme {
  mode: "light" | "dark";
  custom: string;
  /**
   * The preset the app is wearing, or `""` for its built-in theme. Carried so
   * Codeg records which preset is in use — its settings page marks that card as
   * applied — never for painting: the palette is already in `custom`.
   */
  preset: string;
}

/** What the Codeg server process is doing right now. */
export type CodegServerStatus =
  | { status: "stopped" }
  | { status: "starting" }
  | { status: "ready"; url: string }
  | { status: "failed"; message: string };

/** Where Codeg lives and how the app reaches it. */
export interface CodegSettings {
  /** Codeg's checkout, used as the server's working directory. */
  repoPath: string;
  /** Codeg's static export, served by the server. */
  staticDir: string;
  /** The `codeg-server` binary. */
  serverPath: string;
  /** Port the server listens on, on loopback. */
  port: number;
  /**
   * Codeg's data directory; empty means the folder a standalone Codeg uses by
   * default, so both read one database.
   */
  dataDir: string;
  /** Derived from `port`: the origin the page is loaded from. */
  url: string;
}

/**
 * Which binary and which export a start uses.
 *
 * `installed` is the archive the app downloaded and unpacked under the data
 * directory — what a packaged app runs. `dev` is a developer's checkout, whose
 * page and settings partition only exist in a development build.
 */
export type CodegMode = "dev" | "installed";

/** The `codeg-server` archive the app installed for itself. */
export interface CodegInstall {
  /** The folder holding the executable, the export and the install record. */
  dir: string;
  /** The export inside that folder; what `CODEG_STATIC_DIR` points at. */
  staticDir: string;
  /** The executable inside that folder. */
  serverPath: string;
  /** Both halves are there: a binary without its export is not an install. */
  installed: boolean;
  /** The version the install record names, when there is a record. */
  version: string | null;
  tag: string | null;
}

/** What one published `server.json` says about the newest archive. */
export interface CodegRelease {
  /** Short label of the mirror that answered, e.g. `GitHub`. */
  endpoint: string;
  version: string;
  tag: string;
  /** The archive to download. */
  url: string;
  /** Lower-case hex SHA-256 of that archive, checked after download. */
  sha256: string;
  size: number;
  /** The version already installed, when one is. */
  installedVersion: string | null;
  /** The manifest names a newer version than the installed one. */
  updateAvailable: boolean;
}

/** Everything the Codeg pages and their settings partitions draw. */
export interface CodegView {
  /** The development paths as configured, with the data directory resolved. */
  settings: CodegSettings;
  /** The archive the app installed for itself. */
  install: CodegInstall;
  /** The mode the running server serves; `null` when nothing has started. */
  running: CodegMode | null;
  server: CodegServerStatus;
  /** The bearer token the page is injected with. */
  token: string;
  /** The tail of the server's own output. */
  log: string[];
}
