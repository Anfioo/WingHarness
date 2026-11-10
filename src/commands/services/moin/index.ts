import { invokeCommand } from "../../base";
import type { MoinCategory, MoinSettings, MoinTask } from "./types";

export interface MoinAddDownloadArgs {
  url: string;
  category?: string;
  filename?: string;
  headers?: Record<string, string>;
}

export async function moinListDownloads(): Promise<MoinTask[]> {
  return await invokeCommand<Record<string, never>, MoinTask[]>("moin_list_downloads", {});
}

export async function moinAddDownload(args: MoinAddDownloadArgs): Promise<MoinTask> {
  return await invokeCommand<MoinAddDownloadArgs, MoinTask>("moin_add_download", args);
}

export async function moinPauseDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_pause_download", { id });
}

export async function moinResumeDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_resume_download", { id });
}

export async function moinCancelDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_cancel_download", { id });
}

export async function moinRemoveDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_remove_download", { id });
}

export async function moinDeleteDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_delete_download", { id });
}

export async function moinForgetDownload({ id }: { id: string }): Promise<void> {
  return await invokeCommand<{ id: string }, void>("moin_forget_download", { id });
}

export async function moinListCategories(): Promise<MoinCategory[]> {
  return await invokeCommand<Record<string, never>, MoinCategory[]>("moin_list_categories", {});
}

export async function moinSuggestCategory(args: {
  url: string;
  filename?: string;
}): Promise<string | null> {
  return await invokeCommand<typeof args, string | null>("moin_suggest_category", args);
}

export async function moinCreateCategory({
  category,
}: {
  category: MoinCategory;
}): Promise<MoinCategory[]> {
  return await invokeCommand<{ category: MoinCategory }, MoinCategory[]>("moin_create_category", {
    category,
  });
}

export async function moinUpdateCategory({
  category,
}: {
  category: MoinCategory;
}): Promise<MoinCategory[]> {
  return await invokeCommand<{ category: MoinCategory }, MoinCategory[]>("moin_update_category", {
    category,
  });
}

export async function moinDeleteCategory({ id }: { id: string }): Promise<MoinCategory[]> {
  return await invokeCommand<{ id: string }, MoinCategory[]>("moin_delete_category", { id });
}

export async function moinReorderCategories({ ids }: { ids: string[] }): Promise<MoinCategory[]> {
  return await invokeCommand<{ ids: string[] }, MoinCategory[]>("moin_reorder_categories", { ids });
}

export async function moinGetSettings(): Promise<MoinSettings> {
  return await invokeCommand<Record<string, never>, MoinSettings>("moin_get_settings", {});
}

export async function moinPatchSettings({
  patch,
}: {
  patch: Partial<MoinSettings>;
}): Promise<MoinSettings> {
  return await invokeCommand<{ patch: Partial<MoinSettings> }, MoinSettings>(
    "moin_patch_settings",
    {
      patch,
    }
  );
}
