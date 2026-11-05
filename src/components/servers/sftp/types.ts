// Shared types and constants for the XFTP dual-pane view.

import type { ConflictPolicy } from "@/commands/services/servers/types";

/** Custom MIME so the transfer payload cannot be confused with text drags. */
export const SFTP_DRAG_MIME = "application/x-mabang-sftp";

export type Side = "local" | "remote";

export type SortKey = "name" | "size" | "modifiedAt";

export type SortDirection = "asc" | "desc";

export type SortState = { key: SortKey; direction: SortDirection };

/** A conflict decision the engine understands; `ask` stays in the dialog. */
export type ConflictChoice = Exclude<ConflictPolicy, "ask">;

/** Everything a drag carries. Only the source side and absolute paths. */
export type DragPayload = { side: Side; paths: string[] };

export type ConflictItem = { name: string; source: string };
