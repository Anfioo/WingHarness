import { Channel } from "@tauri-apps/api/core";
import { invokeCommand } from "../../base";
import type { UpdateCheckInfo, UpdateInstallResult, UpdateProgress } from "./types";

/**
 * Ask the backend to try each configured endpoint in order. `null` means no
 * newer version is available; the command also announces the endpoint it is
 * checking on `updater:checking`.
 */
export function checkForUpdate(): Promise<UpdateCheckInfo | null> {
  return invokeCommand("check_for_update", {});
}

export function downloadAndInstallUpdate(
  onProgress: (progress: UpdateProgress) => void
): Promise<UpdateInstallResult> {
  const channel = new Channel<UpdateProgress>();
  channel.onmessage = onProgress;
  return invokeCommand("download_and_install_update", { onProgress: channel });
}

export function cancelUpdateDownload(): Promise<boolean> {
  return invokeCommand("cancel_update_download", {});
}

export function isUpdateDownloadActive(): Promise<boolean> {
  return invokeCommand("is_update_download_active", {});
}

export type { UpdateCheckInfo, UpdateInstallResult, UpdateProgress } from "./types";
