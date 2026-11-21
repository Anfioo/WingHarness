// mise command scripts and the files they touch.
//
// Every action in the tools tab is built here before the preview dialog opens,
// so the command the user confirms is exactly the command that runs. Nothing in
// this module talks to Tauri; it is pure string assembly.

import type { MiseToolSourceKind } from "@/commands";

/** Where mise keeps the global configuration when the active tool has no source. */
const GLOBAL_CONFIG_FALLBACK = "~/.config/mise/config.toml";
/** A `mise use` without `--global` writes the project's own config file. */
const PROJECT_CONFIG_PATH = "mise.toml";
/** mise's install directory on Windows (`%LOCALAPPDATA%\mise\installs`). */
const MISE_INSTALL_DIR = "%LOCALAPPDATA%\\mise\\installs";

/** `mise install <tool>@<version>`. */
export function installScript(tool: string, version: string): string {
  return `mise install ${tool}@${version}`;
}

/** `mise use [--global] <tool>@<version>`; only a global source gets the flag. */
export function useScript(tool: string, version: string, sourceKind: MiseToolSourceKind): string {
  const global = sourceKind === "global" ? "--global " : "";
  return `mise use ${global}${tool}@${version}`;
}

/** Install the version, then make it the configured one. */
export function installAndUseScript(
  tool: string,
  version: string,
  sourceKind: MiseToolSourceKind
): string {
  // `useScript` builds a mise command; its name is the mise verb, not a hook.
  // eslint-disable-next-line react-hooks/rules-of-hooks
  return `${installScript(tool, version)}\n${useScript(tool, version, sourceKind)}`;
}

/** Upgrading is installing the new version and switching to it. */
export function upgradeScript(
  tool: string,
  version: string,
  sourceKind: MiseToolSourceKind
): string {
  return installAndUseScript(tool, version, sourceKind);
}

/** Remove one installed version; the configuration is left untouched. */
export function uninstallVersionScript(tool: string, version: string): string {
  return `mise uninstall ${tool}@${version}`;
}

/** Remove the tool from the global config, then delete every installed version. */
export function uninstallToolScript(tool: string): string {
  return `mise use --global --remove ${tool}\nmise uninstall --all ${tool}`;
}

/**
 * Files a script writes to, for the action preview. A script that never
 * mutates anything (inspect or show-current) affects no file.
 */
export function affectedFilesForScript(
  script: string,
  globalConfigPath: string = GLOBAL_CONFIG_FALLBACK
): string[] {
  const files = new Set<string>();

  if (script.includes("--global")) files.add(globalConfigPath);
  else if (/\bmise\s+use\b/.test(script)) files.add(PROJECT_CONFIG_PATH);

  if (/\bmise\s+(?:install|uninstall)\b/.test(script)) files.add(MISE_INSTALL_DIR);

  return [...files];
}

/**
 * Split `<tool>@<version>` into its two non-empty parts. Anything else —
 * whitespace, a missing part, more than one `@` — is rejected.
 */
export function parseToolVersion(value: string): { tool: string; version: string } | null {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;

  const separator = trimmed.indexOf("@");
  if (separator <= 0 || separator === trimmed.length - 1) return null;
  if (trimmed.indexOf("@", separator + 1) !== -1) return null;

  return {
    tool: trimmed.slice(0, separator),
    version: trimmed.slice(separator + 1),
  };
}
