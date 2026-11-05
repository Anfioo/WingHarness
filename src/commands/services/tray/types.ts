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
