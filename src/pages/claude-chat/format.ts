/**
 * Presentation helpers for the Claude chat transcript: tool titles, icons,
 * durations and a couple of small formatters.
 */

import {
  Bot,
  FilePlus,
  FileText,
  FolderSearch,
  Globe,
  ListTodo,
  Notebook,
  Search,
  SquarePen,
  Terminal,
  Wrench,
  type LucideIcon,
} from "lucide-react";

/** `340ms` / `2.4s` / `12s` / `2m14s` */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 10) return `${Number(seconds.toFixed(1))}s`;
  const total = Math.round(seconds);
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return rest ? `${minutes}m${rest}s` : `${minutes}m`;
}

/** `$0.0081` / `$0.012` / `$1.25` */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${Number(usd.toFixed(4))}`;
  if (usd < 1) return `$${Number(usd.toFixed(3))}`;
  return `$${usd.toFixed(2)}`;
}

/** Local `YYYY-MM-DD HH:MM` for a history row's last-active time. */
export function formatHistoryTime(ms: number): string {
  if (!ms) return "";
  const date = new Date(ms);
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    ` ${pad(date.getHours())}:${pad(date.getMinutes())}`
  );
}

export function lineCount(text: string): number {
  return text ? text.split("\n").length : 0;
}

export function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Collapse whitespace and clip — for one-line titles. */
export function truncate(text: string, max = 90): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Argument keys that name each tool's subject, in priority order. */
const ARG_KEYS: Record<string, string[]> = {
  Bash: ["command"],
  Read: ["file_path", "path"],
  Write: ["file_path", "path"],
  Edit: ["file_path", "path"],
  MultiEdit: ["file_path", "path"],
  NotebookEdit: ["notebook_path"],
  Grep: ["pattern"],
  Glob: ["pattern"],
  WebFetch: ["url"],
  WebSearch: ["query"],
  Task: ["description"],
  Agent: ["description"],
  Skill: ["skill"],
};

/** Sub-agent tools: `Task` in older CLIs, `Agent` in current ones. */
export function isSubagentTool(toolName: string): boolean {
  return toolName === "Task" || toolName === "Agent";
}

/** The one argument worth showing in a card title, e.g. a Bash command. */
export function toolArgument(toolName: string, input: Record<string, unknown>): string {
  for (const key of ARG_KEYS[toolName] ?? []) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  // Unknown tool (MCP and friends): the first string argument is the best guess.
  for (const value of Object.values(input)) {
    if (typeof value === "string" && value.trim()) return value;
  }
  return "";
}

/** `Bash(cargo build)` — the CLI's own card-title style. */
export function toolTitle(toolName: string, input: Record<string, unknown>): string {
  const arg = toolArgument(toolName, input);
  return arg ? `${toolName}(${truncate(arg)})` : toolName;
}

const TOOL_ICONS: Record<string, LucideIcon> = {
  Bash: Terminal,
  BashOutput: Terminal,
  Read: FileText,
  Write: FilePlus,
  Edit: SquarePen,
  MultiEdit: SquarePen,
  NotebookEdit: Notebook,
  Grep: Search,
  Glob: FolderSearch,
  WebFetch: Globe,
  WebSearch: Globe,
  Task: Bot,
  Agent: Bot,
  TodoWrite: ListTodo,
};

export function toolIcon(toolName: string): LucideIcon {
  return TOOL_ICONS[toolName] ?? Wrench;
}

/** Read a string field off a tool input without leaking `unknown` into JSX. */
export function stringField(input: Record<string, unknown>, key: string): string {
  const value = input[key];
  return typeof value === "string" ? value : "";
}
