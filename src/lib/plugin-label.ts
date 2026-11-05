/**
 * Encoding a plugin id for use inside a window or webview label.
 *
 * Tauri labels allow only alphanumerics and `-`, `/`, `:`, `_` — but a plugin id
 * may also contain `.`, which a versioned folder like `dsh-0.2.1-win-x64` does.
 * A raw id in a label is rejected by the window system, so `.` is mapped to `:`,
 * the one label character an id can never contain (the backend's `validate_id`
 * forbids it). The mapping is collision-free and reversible.
 *
 * Keep this in step with `encode_label_id` / `decode_label_id` in
 * `src-tauri/src/plugins/mod.rs`.
 */

/** Encodes a plugin id so it is safe inside a label. */
export function encodeLabelId(id: string): string {
  return id.replace(/\./g, ":");
}

/** Recovers a plugin id from its encoded form. */
export function decodeLabelId(encoded: string): string {
  return encoded.replace(/:/g, ".");
}
