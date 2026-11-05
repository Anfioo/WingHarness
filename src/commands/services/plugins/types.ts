/** How the config window renders a plugin's config field. */
export type PluginFieldType = "string" | "number" | "boolean" | "select" | "textarea";

/** One choice a field offers. */
export interface PluginSelectOption {
  value: string;
  /** Shown in the dropdown or on the toggle's button; falls back to `value`. */
  label: string;
}

/** One renderable setting, declared by the plugin in its `plugin.json`. */
export interface PluginConfigField {
  key: string;
  label: string;
  type: PluginFieldType;
  /** Used until the user changes it. */
  default: unknown;
  hint: string | null;
  /**
   * Choices this field offers, as `{ value, label }`. A non-empty list makes it
   * a choice: a `select` renders a dropdown, a `boolean` a two-state toggle.
   */
  options: PluginSelectOption[];
  /**
   * The toggle's "on" option value. Set for a `boolean` with options, `null`
   * otherwise; the manifest loader rejects any other shape.
   */
  trueValue: string | null;
  /** Bounds for `number`. */
  min: number | null;
  max: number | null;
}

/** The format adapter a source uses. */
export type PluginConfigFileType = "env" | "json" | "yaml";

/** One declared field with the value its file currently holds. */
export interface PluginConfigFieldView extends PluginConfigField {
  value: unknown;
}

/** One config file a plugin declares, as the config window needs it. */
export interface PluginConfigFileView {
  fileType: PluginConfigFileType;
  /**
   * Path relative to the plugin folder, or as written when the plugin declared
   * the source `absolute`.
   */
  path: string;
  /**
   * Set for a source the plugin declared outside its own folder. The file is
   * read and written, but never created: the plugin that owns it makes it on
   * its first run.
   */
  external: boolean;
  /** A run is refused while the file is missing. */
  startmust: boolean;
  /** Whether the file is on disk right now. */
  exists: boolean;
  fields: PluginConfigFieldView[];
}

/** An installed plugin, as the settings page needs it. */
export interface PluginView {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Script the plugin runs, relative to its folder. */
  entry: string;
  /**
   * Script the app runs when stopping, when the plugin declares one. `null`
   * means stopping is the process-tree kill alone.
   */
  stopScript: string | null;
  /**
   * Address of the plugin's own page, `{key}` already filled in from the config
   * files. `null` when the plugin has no interface.
   */
  ui: string | null;
  /** Where the plugin lives on disk. */
  dir: string;
  /** Off until the user turns it on. */
  enabled: boolean;
  /** The plugin's declared config files, one block each. */
  files: PluginConfigFileView[];
  /** Set when the folder holds no readable manifest. */
  error: string | null;
}

/** One message of a streamed plugin run. */
export type PluginOutputEvent =
  | { kind: "line"; stream: "stdout" | "stderr"; text: string }
  | { kind: "done"; code: number }
  | { kind: "failed"; message: string };

/** How far a plugin install has got, as the settings page shows it. */
export interface PluginInstallProgress {
  /** Bytes written so far across every file in the archive. */
  written: number;
  /** Total unpacked size, settled before any file is written. */
  total: number;
}
