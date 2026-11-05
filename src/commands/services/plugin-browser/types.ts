/**
 * Where a plugin's page sits, in logical pixels relative to the window — the
 * same units CSS uses, so a measured `getBoundingClientRect()` is passed
 * straight through.
 */
export interface PluginPageBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}
