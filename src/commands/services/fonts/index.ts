import { invokeCommand } from "../../base";
import type { FontFamily } from "./types";

/**
 * Every font family installed on this machine, sorted by name.
 *
 * Used by the interface-font and code-font pickers; the editor's own PTY font
 * list is a separate command (`localShellListFonts`).
 */
export function fontsList(): Promise<FontFamily[]> {
  return invokeCommand<Record<string, never>, FontFamily[]>("fonts_list", {});
}

export type { FontFamily };
