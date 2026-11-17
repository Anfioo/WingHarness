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

/** Everything the Codeg page and its settings section draw. */
export interface CodegView {
  settings: CodegSettings;
  server: CodegServerStatus;
  /** The bearer token the page is injected with. */
  token: string;
  /** The tail of the server's own output. */
  log: string[];
}
