// mise command service.
//
// Thin, one-to-one wrappers over the `mise-core` Rust commands. Argument keys
// are camelCase here; Tauri maps them onto the snake_case Rust parameters. This
// module is frozen: the component lanes use it as-is.
//
// Rejected calls throw the engine's `{ code, message, detail }` object; use
// `isMiseError` / `miseErrorCode` from `./types` to branch on `code`.

import { invokeCommand } from "../../base";
import type {
  MiseActionResult,
  MiseConfigEdit,
  MiseConfigSavePreview,
  MiseConfigSaveResult,
  MiseConfigWorkspace,
  MiseDashboard,
  MiseHistoryEntry,
  MiseProjectCoverage,
  MiseRuntimeInfo,
  MiseScanDirectory,
  MiseTool,
} from "./types";

export async function miseRuntimeInfo(): Promise<MiseRuntimeInfo> {
  return await invokeCommand<Record<string, never>, MiseRuntimeInfo>("mise_runtime_info", {});
}

export async function miseDashboard(): Promise<MiseDashboard> {
  return await invokeCommand<Record<string, never>, MiseDashboard>("mise_dashboard", {});
}

export async function miseToolsList(): Promise<MiseTool[]> {
  return await invokeCommand<Record<string, never>, MiseTool[]>("mise_tools_list", {});
}

export async function miseToolDetail(tool: string): Promise<MiseTool> {
  return await invokeCommand<{ tool: string }, MiseTool>("mise_tool_detail", { tool });
}

export async function miseToolDetailCancel(tool: string): Promise<void> {
  return await invokeCommand<{ tool: string }, void>("mise_tool_detail_cancel", { tool });
}

export async function miseActionRun(
  script: string,
  workingDirectory?: string
): Promise<MiseActionResult> {
  return await invokeCommand<{ script: string; workingDirectory?: string }, MiseActionResult>(
    "mise_action_run",
    { script, workingDirectory }
  );
}

export async function miseProjectsScan(): Promise<MiseProjectCoverage> {
  return await invokeCommand<Record<string, never>, MiseProjectCoverage>("mise_projects_scan", {});
}

export async function miseScanDirsList(): Promise<MiseScanDirectory[]> {
  return await invokeCommand<Record<string, never>, MiseScanDirectory[]>("mise_scan_dirs_list", {});
}

export async function miseScanDirsAdd(path: string): Promise<MiseScanDirectory[]> {
  return await invokeCommand<{ path: string }, MiseScanDirectory[]>("mise_scan_dirs_add", { path });
}

export async function miseScanDirsRemove(path: string): Promise<MiseScanDirectory[]> {
  return await invokeCommand<{ path: string }, MiseScanDirectory[]>("mise_scan_dirs_remove", {
    path,
  });
}

export async function miseScanDirsSetEnabled(
  path: string,
  enabled: boolean
): Promise<MiseScanDirectory[]> {
  return await invokeCommand<{ path: string; enabled: boolean }, MiseScanDirectory[]>(
    "mise_scan_dirs_set_enabled",
    { path, enabled }
  );
}

export async function miseConfigWorkspace(query?: {
  projectPath?: string;
  projectConfigPath?: string;
  projectName?: string;
}): Promise<MiseConfigWorkspace> {
  return await invokeCommand<
    { projectPath?: string; projectConfigPath?: string; projectName?: string },
    MiseConfigWorkspace
  >("mise_config_workspace", query ?? {});
}

export async function miseConfigPreviewEdit(
  path: string,
  edit: MiseConfigEdit
): Promise<MiseConfigSavePreview> {
  return await invokeCommand<{ path: string; edit: MiseConfigEdit }, MiseConfigSavePreview>(
    "mise_config_preview_edit",
    { path, edit }
  );
}

export async function miseConfigSave(
  path: string,
  nextContent: string
): Promise<MiseConfigSaveResult> {
  return await invokeCommand<{ path: string; nextContent: string }, MiseConfigSaveResult>(
    "mise_config_save",
    { path, nextContent }
  );
}

export async function miseHistoryList(): Promise<MiseHistoryEntry[]> {
  return await invokeCommand<Record<string, never>, MiseHistoryEntry[]>("mise_history_list", {});
}

export async function miseHistoryRecordCanceled(command: string): Promise<MiseHistoryEntry> {
  return await invokeCommand<{ command: string }, MiseHistoryEntry>(
    "mise_history_record_canceled",
    { command }
  );
}
