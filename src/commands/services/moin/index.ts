// Adapted from moin (MIT), https://github.com/exxvius/moin at 79e7587.
// See `src-tauri/moin-core/UPSTREAM.md` for the porting record.

/**
 * The 29 moin commands, one wrapper each.
 *
 * Names, parameters and return types are frozen: every moin page and hook is
 * written against this module, and the command strings must stay in step with
 * `src-tauri/moin-core/src/commands.rs`, `src-tauri/src/invoke.rs`,
 * `src-tauri/build.rs` and `capabilities/default.json`.
 */

import { invokeCommand } from "../../base";
import type {
  MoinBackendInfo,
  MoinCategory,
  MoinRpcStatus,
  MoinSettings,
  MoinTask,
  MoinToolStatus,
} from "./types";

export interface MoinAppInfo {
  name: string;
  version: string;
}

export interface MoinAddDownloadArgs {
  url: string;
  category?: string | null;
  headers?: Record<string, string>;
  filename?: string | null;
}

const EMPTY = {} as Record<string, never>;

export async function moinAppInfo(): Promise<MoinAppInfo> {
  return await invokeCommand<Record<string, never>, MoinAppInfo>("moin_app_info", EMPTY);
}

export async function moinListDownloads(): Promise<MoinTask[]> {
  return await invokeCommand<Record<string, never>, MoinTask[]>("moin_list_downloads", EMPTY);
}

export async function moinAddDownload(args: MoinAddDownloadArgs): Promise<MoinTask> {
  return await invokeCommand<MoinAddDownloadArgs, MoinTask>("moin_add_download", args);
}

export async function moinPauseDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_pause_download", { id });
}

export async function moinResumeDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_resume_download", { id });
}

export async function moinCancelDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_cancel_download", { id });
}

export async function moinRemoveDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_remove_download", { id });
}

export async function moinDeleteDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_delete_download", { id });
}

export async function moinRemoveDownloads(ids: string[]): Promise<void> {
  return await invokeCommand<{ ids: string[] }, void>("moin_remove_downloads", { ids });
}

export async function moinDeleteDownloads(ids: string[]): Promise<void> {
  return await invokeCommand<{ ids: string[] }, void>("moin_delete_downloads", { ids });
}

export async function moinRetryDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_retry_download", { id });
}

export async function moinForgetDownload(id: string): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_forget_download", { id });
}

export async function moinGetSettings(): Promise<MoinSettings> {
  return await invokeCommand<Record<string, never>, MoinSettings>("moin_get_settings", EMPTY);
}

export async function moinSetSettings(settings: MoinSettings): Promise<void> {
  return await invokeCommand<{ settings: MoinSettings }, void>("moin_set_settings", { settings });
}

export async function moinPatchSettings(patch: Partial<MoinSettings>): Promise<MoinSettings> {
  return await invokeCommand<{ patch: Partial<MoinSettings> }, MoinSettings>(
    "moin_patch_settings",
    { patch }
  );
}

export async function moinListBackends(): Promise<MoinBackendInfo[]> {
  return await invokeCommand<Record<string, never>, MoinBackendInfo[]>("moin_list_backends", EMPTY);
}

export async function moinRegenerateRpcToken(): Promise<string> {
  return await invokeCommand<Record<string, never>, string>("moin_regenerate_rpc_token", EMPTY);
}

export async function moinRpcStatus(): Promise<MoinRpcStatus> {
  return await invokeCommand<Record<string, never>, MoinRpcStatus>("moin_rpc_status", EMPTY);
}

export async function moinToolStatus(): Promise<MoinToolStatus> {
  return await invokeCommand<Record<string, never>, MoinToolStatus>("moin_tool_status", EMPTY);
}

export async function moinSetToolPath(path: string | null): Promise<MoinToolStatus> {
  return await invokeCommand<{ path: string | null }, MoinToolStatus>("moin_set_tool_path", {
    path,
  });
}

export async function moinListCategories(): Promise<MoinCategory[]> {
  return await invokeCommand<Record<string, never>, MoinCategory[]>("moin_list_categories", EMPTY);
}

export async function moinSuggestCategory(
  url: string,
  filename?: string | null
): Promise<string | null> {
  return await invokeCommand<{ url: string; filename: string | null }, string | null>(
    "moin_suggest_category",
    { url, filename: filename ?? null }
  );
}

export async function moinCreateCategory(category: MoinCategory): Promise<MoinCategory[]> {
  return await invokeCommand<{ category: MoinCategory }, MoinCategory[]>("moin_create_category", {
    category,
  });
}

export async function moinUpdateCategory(category: MoinCategory): Promise<MoinCategory[]> {
  return await invokeCommand<{ category: MoinCategory }, MoinCategory[]>("moin_update_category", {
    category,
  });
}

export async function moinDeleteCategory(id: string): Promise<MoinCategory[]> {
  return await invokeCommand<{ id: string }, MoinCategory[]>("moin_delete_category", { id });
}

export async function moinReorderCategories(ids: string[]): Promise<MoinCategory[]> {
  return await invokeCommand<{ ids: string[] }, MoinCategory[]>("moin_reorder_categories", { ids });
}

export async function moinMoveToCategory(ids: string[], category: string | null): Promise<void> {
  return await invokeCommand<{ ids: string[]; category: string | null }, void>(
    "moin_move_to_category",
    { ids, category }
  );
}

export async function moinDefaultDownloadDir(): Promise<string> {
  return await invokeCommand<Record<string, never>, string>("moin_default_download_dir", EMPTY);
}

export async function moinCategoryFolder(category: string | null): Promise<string> {
  return await invokeCommand<{ category: string | null }, string>("moin_category_folder", {
    category,
  });
}
