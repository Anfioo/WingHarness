/** The update the backend settled on, plus the mirror that served it. */
export interface UpdateCheckInfo {
  version: string;
  currentVersion: string;
  date: string | null;
  body: string | null;
  endpoint: string;
}

export interface UpdateProgress {
  event: "Started" | "Progress" | "Finished";
  data?: {
    contentLength?: number;
    chunkLength?: number;
    downloaded?: number;
    /** Bytes per second, derived on the frontend from consecutive events. */
    speed?: number;
  };
}

export type UpdateInstallResult = "installed" | "cancelled" | "up-to-date";
