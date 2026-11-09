// Props frozen for the three frontend lanes: each component file is owned by
// one lane and this module is the only contract between the page and them.

import type { PortCounts } from "@/hooks/use-ports-page";
import type { PortEntry, PortsSettings, PortStatus } from "@/commands";

export type PortsStatsProps = { counts: PortCounts };
export type PortsToolbarProps = {
  query: string;
  onQueryChange: (query: string) => void;
  statuses: Set<PortStatus>;
  onToggleStatus: (status: PortStatus) => void;
  refreshing: boolean;
  updatedAt: number;
  paused: boolean;
  onRefresh: () => void;
};

export type PortsListProps = {
  pinned: PortEntry[];
  others: PortEntry[];
  query: string;
  pinnedOnly: boolean;
  loading: boolean;
  onOpenDetail: (port: number) => void;
  onKill: (pid: number) => void;
  onTogglePin: (port: number) => void;
};

/** One row, rendered by the list; owned by the same lane as the list. */
export type PortRowProps = {
  entry: PortEntry;
  pinned: boolean;
  onOpenDetail: (port: number) => void;
  onKill: (pid: number) => void;
  onTogglePin: (port: number) => void;
};

export type PortDetailSheetProps = {
  port: number | null;
  onOpenChange: (open: boolean) => void;
  onKill: (pid: number) => void;
};

export type PortSettingsDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: PortsSettings | null;
  onSave: (settings: PortsSettings) => Promise<void>;
};
