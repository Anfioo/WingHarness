/**
 * The node view: one card per message, hung off a timeline rail.
 *
 * Tool calls and thinking are not cards of their own — a node says how many
 * there were and nothing else. An assistant node the CLI had finished with (the
 * one the user's next message answers) carries the fork action, and any session
 * already branched off that node is listed under it, which is how one node is
 * seen to have become two.
 */

import { Bot, GitFork, User } from "lucide-react";
import type { ClaudeSessionBranch } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatHistoryTime } from "../claude-chat/format";
import type { ConversationNode } from "./nodes";

export function NodeFlow({
  nodes,
  branches,
  onFork,
  onOpenBranch,
}: {
  nodes: ConversationNode[];
  branches: ClaudeSessionBranch[];
  onFork: (node: ConversationNode) => void;
  onOpenBranch: (branch: ClaudeSessionBranch) => void;
}) {
  const { t } = useAppTranslation();

  return (
    <ol className="relative flex flex-col gap-3 pl-7">
      {/* The rail the nodes hang off, drawn behind them. */}
      <span aria-hidden className="bg-border absolute top-3 bottom-3 left-[10px] w-px" />
      {nodes.map((node) => {
        const forks = branches.filter((branch) => branch.forkUuid === node.uuid);
        return (
          <li key={node.id} className="relative">
            <span
              aria-hidden
              className={cn(
                "border-background absolute top-4 -left-[1.5rem] size-3.5 rounded-full border-2",
                node.role === "user" ? "bg-primary" : "bg-muted-foreground/50"
              )}
            />
            <div
              className={cn(
                "border-border bg-card rounded-xl border p-3 shadow-sm",
                node.role === "user" && "border-primary/30 bg-primary/5"
              )}
            >
              <div className="mb-2 flex flex-wrap items-center gap-2">
                {node.role === "user" ? (
                  <User className="text-primary size-4" />
                ) : (
                  <Bot className="text-muted-foreground size-4" />
                )}
                <span className="text-xs font-medium">
                  {t(
                    node.role === "user" ? "claudeHistory.nodeUser" : "claudeHistory.nodeAssistant"
                  )}
                </span>
                {node.timestamp && (
                  <span className="text-muted-foreground font-mono text-[11px]">
                    {formatHistoryTime(Date.parse(node.timestamp))}
                  </span>
                )}
                {node.tools > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                    {t("claudeHistory.nodeTools", { count: node.tools })}
                  </Badge>
                )}
                {node.thoughts > 0 && (
                  <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
                    {t("claudeHistory.nodeThoughts", { count: node.thoughts })}
                  </Badge>
                )}
                {node.awaitingInput && (
                  <span className="text-muted-foreground text-[11px]">
                    {t("claudeHistory.awaitingInput")}
                  </span>
                )}
                {node.awaitingInput && (
                  <Button
                    variant="outline"
                    size="sm"
                    className="ml-auto h-7"
                    onClick={() => onFork(node)}
                  >
                    <GitFork className="size-3.5" />
                    {t("claudeHistory.fork")}
                  </Button>
                )}
              </div>

              <p className="text-sm leading-6 whitespace-pre-wrap">{node.text}</p>

              {forks.length > 0 && (
                <div className="border-border mt-3 flex flex-wrap items-center gap-2 border-t pt-2">
                  <span className="text-muted-foreground text-[11px]">
                    {t("claudeHistory.forksHere")}
                  </span>
                  {forks.map((branch) => (
                    <button
                      key={branch.sessionId}
                      type="button"
                      title={formatHistoryTime(branch.createdMs)}
                      onClick={() => onOpenBranch(branch)}
                      className="border-border hover:bg-accent inline-flex max-w-64 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] transition-colors"
                    >
                      <GitFork className="size-3 shrink-0" />
                      <span className="truncate">{branch.title}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
