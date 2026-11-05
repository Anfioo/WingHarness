/**
 * Renders a stored session as Markdown for the export menu.
 *
 * Three depths, matching the three menu entries: what was said, that plus the
 * tool calls, and everything the file holds including the thinking and each
 * row's timestamp. Tools and thinking are folded into `<details>` so the file
 * still reads as a conversation when opened in a Markdown viewer.
 */

import type { TFunction } from "i18next";
import type { ClaudeHistoryRecord } from "@/commands";
import { extractToolResultText } from "@/lib/use-claude/parser";
import { formatHistoryTime } from "../claude-chat/format";

export type ExportMode = "conversation" | "tools" | "full";

export function sessionMarkdown({
  title,
  project,
  sessionId,
  records,
  mode,
  t,
}: {
  title: string;
  project: string;
  sessionId: string;
  records: ClaudeHistoryRecord[];
  mode: ExportMode;
  t: TFunction;
}): string {
  const lines: string[] = [
    `# ${title}`,
    "",
    `- ${t("claudeHistory.exportProject")}: \`${project}\``,
    `- ${t("claudeHistory.exportSession")}: \`${sessionId}\``,
    `- ${t("claudeHistory.exportedAt")}: ${formatHistoryTime(Date.now())}`,
    "",
    "---",
    "",
  ];

  for (const record of records) {
    if (record.kind === "user" || record.kind === "assistant") {
      if (!record.text.trim()) continue;
      const who = record.kind === "user" ? "exportUser" : "exportAssistant";
      lines.push(`## ${t(`claudeHistory.${who}`)}`, "");
      if (mode === "full") {
        const stamp = timestamp(record);
        if (stamp) lines.push(`*${stamp}*`, "");
      }
      lines.push(record.text, "");
      continue;
    }

    // Thinking belongs to the fullest view only: the middle depth is about the
    // conversation and what it ran, not how the model arrived at a reply.
    if (record.kind === "thinking") {
      if (mode !== "full" || !record.text.trim()) continue;
      lines.push(
        "<details>",
        `<summary>${t("claudeHistory.exportThinking")}</summary>`,
        "",
        quote(record.text),
        "",
        "</details>",
        ""
      );
      continue;
    }

    if (record.kind === "tool" && mode !== "conversation") {
      lines.push(...toolBlock(record, t));
    }
  }

  return lines.join("\n");
}

function toolBlock(record: ClaudeHistoryRecord, t: TFunction): string[] {
  const name = record.toolName ?? "unknown";
  const input = record.input ?? {};
  const result = record.resultContent == null ? "" : extractToolResultText(record.resultContent);

  const lines = [
    "<details>",
    `<summary>${t("claudeHistory.exportTool")}: ${name}</summary>`,
    "",
    `**${t("claudeHistory.exportInput")}**`,
    "",
    fence(JSON.stringify(input, null, 2) ?? String(input), "json"),
    "",
    `**${t("claudeHistory.exportResult")}**`,
    "",
  ];

  if (result.trim()) {
    lines.push(fence(result, "text"));
  } else {
    lines.push(`*${t("claudeHistory.exportNoResult")}*`);
  }

  lines.push("", "</details>", "");
  return lines;
}

/** A run of backticks longer than any in the text, so the fence cannot close early. */
function fence(text: string, language: string): string {
  const longest = (text.match(/`+/g) ?? []).reduce((max, run) => Math.max(max, run.length), 0);
  const marker = "`".repeat(Math.max(3, longest + 1));
  return `${marker}${language}\n${text}\n${marker}`;
}

function quote(text: string): string {
  return text
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function timestamp(record: ClaudeHistoryRecord): string {
  if (!record.timestamp) return "";
  const ms = Date.parse(record.timestamp);
  return Number.isNaN(ms) ? "" : formatHistoryTime(ms);
}

/** A title made safe for a file name, falling back to the session id. */
export function exportFileName(title: string, sessionId: string): string {
  const base = title
    .replace(/[\\/:*?"<>|\r\n]+/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return `${base || sessionId}.md`;
}
