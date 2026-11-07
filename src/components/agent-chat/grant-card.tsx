import { memo, useState } from "react";
import type { JSX } from "react";
import { ShieldAlert } from "lucide-react";
import { toast } from "sonner";

import { useAgentChatStore } from "@/features/agent-chat/store";
import type { AgentMessageRow } from "@/features/agent-chat/types";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";

type GrantRow = Extract<AgentMessageRow, { kind: "grant" }>;

/** The directory to grant: the denied path's parent, never the file itself. */
function parentDir(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  const index = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  if (index < 0) return null;
  const parent = trimmed.slice(0, index);
  if (!parent) return trimmed.startsWith("/") ? "/" : null;
  // A drive root keeps its separator so the grant matches the CLI's check.
  return /^[a-zA-Z]:$/.test(parent) ? `${parent}\\` : parent;
}

function AgentGrantCardBase({ row }: { row: GrantRow }): JSX.Element {
  const { t } = useAppTranslation();
  const activeTabId = useAgentChatStore((state) => state.activeTabId);
  const grantAndRetry = useAgentChatStore((state) => state.grantAndRetry);
  const dismissGrant = useAgentChatStore((state) => state.dismissGrant);
  const [busy, setBusy] = useState(false);

  const pending = row.status === "pending";
  const dir = row.path ? parentDir(row.path) : null;

  const grant = async () => {
    if (!activeTabId || !dir || busy) return;
    setBusy(true);
    try {
      await grantAndRetry(activeTabId, row.seq, dir);
    } finally {
      setBusy(false);
    }
  };

  const copyPath = async () => {
    if (!row.path) return;
    try {
      await navigator.clipboard.writeText(row.path);
      toast.success(t("agentChat.tool.copied"));
    } catch (error) {
      console.warn("agent-chat: clipboard write failed", error);
    }
  };

  return (
    <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 dark:bg-amber-500/10">
      <div className="mb-1 flex items-center gap-2">
        <ShieldAlert className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-medium">{t("agentChat.grant.title")}</span>
      </div>
      <p className="text-muted-foreground mb-2 text-xs">
        {row.message || t("agentChat.grant.description")}
      </p>
      {row.tool ? <div className="mb-1 font-mono text-xs break-all">{row.tool}</div> : null}
      {row.path ? (
        <button
          type="button"
          title={row.path}
          onClick={() => {
            void copyPath();
          }}
          className="text-muted-foreground hover:text-foreground max-w-full truncate rounded bg-amber-500/10 px-1.5 py-0.5 text-left font-mono text-[11px]"
        >
          {row.path}
        </button>
      ) : null}

      {pending ? (
        <div className="mt-3 flex gap-2">
          <Button
            size="sm"
            disabled={busy || !activeTabId || !dir}
            onClick={() => {
              void grant();
            }}
          >
            {t("agentChat.grant.grantAndRetry")}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!activeTabId}
            onClick={() => {
              if (activeTabId) dismissGrant(activeTabId, row.seq);
            }}
          >
            {t("agentChat.grant.dismiss")}
          </Button>
        </div>
      ) : row.status === "granted" ? (
        <div className="text-muted-foreground mt-2 text-xs">{t("agentChat.grant.granted")}</div>
      ) : null}
    </div>
  );
}

export const AgentGrantCard = memo(AgentGrantCardBase);
