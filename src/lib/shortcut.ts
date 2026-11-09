import {
  isRegistered,
  register,
  unregister,
  unregisterAll,
} from "@tauri-apps/plugin-global-shortcut";

/**
 * OS-global shortcuts, for combinations the app should receive while another
 * window has focus.
 *
 * A trigger that is not a combination — a bare Space, a double Ctrl — cannot be
 * registered here; those are matched in-app instead. The string format and the
 * matching helpers live in `shortcut-spec.ts`.
 */
export async function registerShortcut(
  shortcut: string,
  callback: () => void,
  oldShortcut?: string
): Promise<void> {
  if (oldShortcut) {
    await unregisterShortcut(oldShortcut);
  }
  await unregisterShortcut(shortcut);
  try {
    await register(shortcut, (event) => {
      if (event.state === "Pressed") {
        callback();
      }
    });
    console.log("Shortcut registered successfully:", shortcut);
  } catch (e) {
    console.error("Failed to register shortcut:", e);
  }
}

export async function unregisterShortcut(shortcut?: string): Promise<void> {
  if (!shortcut) {
    return;
  }
  try {
    if (!(await isRegistered(shortcut))) {
      return;
    }
    await unregister(shortcut);
  } catch (e) {
    console.error("Failed to unregister shortcut:", e);
  }
}

export async function unregisterAllShortcut(): Promise<void> {
  await unregisterAll();
}
