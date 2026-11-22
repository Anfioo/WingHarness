import type { ComponentType } from "react";
import type { MiseHealthLevel, MiseHistoryEntry, MiseNotice, MiseRuntimeInfo } from "@/commands";

export type OverviewTabProps = { runtime: MiseRuntimeInfo; onReloadRuntime: () => void };
export type ToolsTabProps = Record<string, never>;
export type ProjectsTabProps = Record<string, never>;
export type ConfigTabProps = Record<string, never>;

export type MetricCardProps = {
  label: string;
  value: string;
  caption?: string;
  level: MiseHealthLevel;
  icon?: ComponentType<{ className?: string }>;
};
export type StatusBadgeProps = { level: MiseHealthLevel; label?: string };
export type NoticeListProps = { notices: MiseNotice[] };
export type ActionPreviewDialogProps = {
  open: boolean;
  title: string;
  summary: string;
  command: string;
  level: MiseHealthLevel;
  affectedFiles?: string[];
  impactScope?: string[];
  riskNotes?: string[];
  confirmLabel: string;
  busy?: boolean;
  onConfirm: () => void;
  onOpenChange: (open: boolean) => void;
};
export type HistoryDialogProps = {
  open: boolean;
  entries: MiseHistoryEntry[];
  onOpenChange: (open: boolean) => void;
};
