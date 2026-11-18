export interface UpdateTrayMenuParams {
  showText: string;
  quitText: string;
}

export type UpdateTrayMenuResult = void;

/** Where the Clash flyout was placed, so the page can order its two cards. */
export interface TrayMenuLayout {
  side: "left" | "right";
  vertical: "up" | "down";
}

/** One app the tray menu can launch, from its Start Menu shortcut. */
export interface TrayApp {
  /** The shortcut's file stem; what the pin and hide lists store. */
  id: string;
  displayName: string;
  /** The `.lnk` itself; opening it launches the app. */
  path: string;
}

/** The apps on offer, the user's curation of them, and where they came from. */
export interface TrayAppsView {
  apps: TrayApp[];
  pinned: string[];
  hidden: string[];
  /** The order the rows were dragged into; empty until the user reorders. */
  order: string[];
  /** Empty when Scoop has no Start Menu folder yet. */
  folder: string;
}
