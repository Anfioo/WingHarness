// One native session row in the sidebar.

import { Bot, MessageSquare, Sparkles, Terminal, type LucideIcon } from "lucide-react";

import type { AgentSessionMeta } from "@/commands/services/agent-chat/types";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

const ENGINE_ICONS: Record<string, LucideIcon> = {
  claude: Bot,
  codex: Terminal,
  qoder: Sparkles,
};

/** Epoch milliseconds as a locale-aware "3 hours ago". */
export function sessionRelativeTime(ms: number, language: string): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const deltaSeconds = Math.round((ms - Date.now()) / 1000);
  const abs = Math.abs(deltaSeconds);
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  if (abs < 60) return format.format(deltaSeconds, "second");
  if (abs < 3_600) return format.format(Math.round(deltaSeconds / 60), "minute");
  if (abs < 86_400) return format.format(Math.round(deltaSeconds / 3_600), "hour");
  if (abs < 86_400 * 30) return format.format(Math.round(deltaSeconds / 86_400), "day");
  if (abs < 86_400 * 365) {
    return format.format(Math.round(deltaSeconds / (86_400 * 30)), "month");
  }
  return format.format(Math.round(deltaSeconds / (86_400 * 365)), "year");
}

export interface AgentSessionItemProps {
  session: AgentSessionMeta;
  selected: boolean;
  onSelect(session: AgentSessionMeta): void;
}

export function AgentSessionItem({ session, selected, onSelect }: AgentSessionItemProps) {
  const { t, language } = useAppTranslation();
  const Icon = ENGINE_ICONS[session.engine] ?? MessageSquare;
  const title = session.title.trim() || t("agentChat.sidebar.untitled");
  const time = sessionRelativeTime(session.updatedAt ?? session.fileMtimeMs, language);

  return (
    <button
      type="button"
      onClick={() => onSelect(session)}
      title={session.workspacePath}
      aria-current={selected ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "hover:bg-accent hover:text-accent-foreground",
        selected && "bg-accent text-accent-foreground"
      )}
    >
      <Icon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{title}</span>
      <span className="text-muted-foreground shrink-0 text-xs">{time}</span>
    </button>
  );
}
