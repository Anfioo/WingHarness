import { check } from "@tauri-apps/plugin-updater";
import type { Update } from "@tauri-apps/plugin-updater";

export type UpdateCheckResult =
  | { status: "available"; update: Update }
  | { status: "up-to-date" }
  | { status: "disabled" }
  | { status: "error"; error: unknown };

export async function checkForUpdates(): Promise<UpdateCheckResult> {
  if (import.meta.env.DEV) {
    return { status: "disabled" };
  }

  try {
    const update = await check();
    if (update) {
      return { status: "available", update };
    }

    return { status: "up-to-date" };
  } catch (error) {
    console.error("Failed to check for updates:", error);
    return { status: "error", error };
  }
}

/**
 * The updater failure surfaces as a bare "check failed" toast unless the
 * underlying cause (unreachable endpoint, bad JSON, a proxy error...) is
 * carried alongside it.
 */
export function updateErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
