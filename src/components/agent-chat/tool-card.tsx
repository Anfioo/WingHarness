import { createContext, memo, useContext, useState } from "react";
import type { JSX, ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  Copy,
  FilePenLine,
  FileText,
  Globe,
  Loader2,
  Terminal,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { openPath } from "@/commands";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import type { AgentMessageRow } from "@/features/agent-chat/types";

type ToolRow = Extract<AgentMessageRow, { kind: "tool" }>;

export type ToolExpansionState = {
  isOpen(seq: number): boolean | undefined;
  setOpen(seq: number, open: boolean): void;
};

const ToolExpansionContext = createContext<ToolExpansionState | null>(null);

/** Keeps expansion across virtualised unmounts, owned by the transcript. */
export function AgentToolExpansionProvider({
  state,
  children,
}: {
  state: ToolExpansionState;
  children: ReactNode;
}): JSX.Element {
  return <ToolExpansionContext.Provider value={state}>{children}</ToolExpansionContext.Provider>;
}

/** Payloads past this size are cut; scrolling a wall of JSON is unusable. */
const MAX_PAYLOAD_CHARS = 8_000;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function clamp(text: string): string {
  return text.length > MAX_PAYLOAD_CHARS ? `${text.slice(0, MAX_PAYLOAD_CHARS)}\n…` : text;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? path;
}

function ToolIcon({ name, className }: { name: string; className?: string }): JSX.Element {
  const key = name.toLowerCase();
  if (/(bash|shell|command|exec)/.test(key)) return <Terminal className={className} />;
  if (/(edit|write)/.test(key)) return <FilePenLine className={className} />;
  if (/(read|glob|grep|list)/.test(key)) return <FileText className={className} />;
  if (/(web|fetch|search)/.test(key)) return <Globe className={className} />;
  return <Wrench className={className} />;
}

/** Bash-family results arrive as stdout/stderr, or one aggregated blob. */
function shellOutput(result: unknown): string | null {
  if (typeof result === "string") return result;
  const record = asRecord(result);
  if (!record) return null;
  const parts = [
    readString(record.stdout),
    readString(record.stderr),
    readString(record.output),
    readString(record.aggregatedOutput),
  ].filter((part): part is string => Boolean(part && part.trim()));
  return parts.length > 0 ? parts.join("\n") : null;
}

async function copyText(text: string, done: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(done);
  } catch (error) {
    console.warn("agent-chat: clipboard write failed", error);
  }
}

function Pre({ text }: { text: string }): JSX.Element {
  return (
    <pre className="bg-muted/30 max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs break-words whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function DiffText({ oldText, newText }: { oldText: string; newText: string }): JSX.Element {
  return (
    <div className="bg-muted/30 max-h-64 overflow-auto rounded-md border p-2 font-mono text-xs">
      {oldText.split("\n").map((line, index) => (
        <div
          key={`old-${index}`}
          className="break-all whitespace-pre-wrap text-red-600 dark:text-red-400"
        >
          {"- "}
          {line}
        </div>
      ))}
      {newText.split("\n").map((line, index) => (
        <div
          key={`new-${index}`}
          className="break-all whitespace-pre-wrap text-emerald-600 dark:text-emerald-400"
        >
          {"+ "}
          {line}
        </div>
      ))}
    </div>
  );
}

function StatusDot({ status, label }: { status: ToolRow["status"]; label: string }): JSX.Element {
  if (status === "running") {
    return (
      <Loader2
        role="status"
        aria-label={label}
        className="text-muted-foreground size-3.5 shrink-0 animate-spin"
      />
    );
  }

  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className={cn(
        "size-2 shrink-0 rounded-full",
        status === "done" && "bg-emerald-500",
        status === "error" && "bg-destructive",
        status === "stopped" && "bg-muted-foreground/50"
      )}
    />
  );
}

function CopyButton({ text }: { text: string }): JSX.Element {
  const { t } = useAppTranslation();
  return (
    <button
      type="button"
      title={t("agentChat.tool.copy")}
      aria-label={t("agentChat.tool.copy")}
      className="text-muted-foreground hover:text-foreground rounded p-1"
      onClick={() => {
        void copyText(text, t("agentChat.tool.copied"));
      }}
    >
      <Copy className="size-3.5" />
    </button>
  );
}

function PayloadSection({
  title,
  copyText: copyable,
  empty,
  children,
}: {
  title: string;
  copyText: string | null;
  empty: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <section>
      <header className="mb-1 flex items-center justify-between gap-2">
        <span className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          {title}
        </span>
        {copyable ? <CopyButton text={copyable} /> : null}
      </header>
      {children ?? <p className="text-muted-foreground text-xs">{empty}</p>}
    </section>
  );
}

function AgentToolCardBase({ row }: { row: ToolRow }): JSX.Element {
  const { t } = useAppTranslation();
  const expansion = useContext(ToolExpansionContext);
  const [override, setOverride] = useState<boolean | null>(null);
  const explicit = expansion?.isOpen(row.seq);
  const open = explicit ?? override ?? row.status === "running";

  const args = asRecord(row.args);
  const command = readString(args?.command);
  const isShell = /(bash|shell|command|exec)/i.test(row.toolName);
  const isFileEdit = /^(edit|write|multiedit|notebookedit)$/i.test(row.toolName.trim());
  const filePath =
    readString(args?.file_path) ?? readString(args?.filePath) ?? readString(args?.path) ?? row.path;
  const oldText = readString(args?.old_string) ?? readString(args?.oldText);
  const newText =
    readString(args?.new_string) ??
    readString(args?.newText) ??
    readString(args?.content) ??
    readString(args?.new_source);

  let argsBody: ReactNode = null;
  let argsCopy: string | null = null;
  if (isShell && command) {
    argsBody = <Pre text={clamp(command)} />;
    argsCopy = command;
  } else if (isFileEdit && (oldText !== null || newText !== null)) {
    argsBody = <DiffText oldText={oldText ?? ""} newText={newText ?? ""} />;
    argsCopy = row.args == null ? null : stringify(row.args);
  } else if (row.args != null) {
    argsBody = <Pre text={clamp(stringify(row.args))} />;
    argsCopy = stringify(row.args);
  }

  let resultBody: ReactNode = null;
  let resultCopy: string | null = null;
  if (row.result != null) {
    const output = isShell ? shellOutput(row.result) : null;
    if (output !== null) {
      resultBody = <Pre text={clamp(output)} />;
      resultCopy = output;
    } else {
      resultBody = <Pre text={clamp(stringify(row.result))} />;
      resultCopy = stringify(row.result);
    }
  }

  const toggle = () => {
    const next = !open;
    setOverride(next);
    expansion?.setOpen(row.seq, next);
  };

  return (
    <div className="bg-card rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={toggle}
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          {open ? (
            <ChevronDown className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <ChevronRight className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <ToolIcon name={row.toolName} className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate font-mono text-xs font-medium">{row.toolName}</span>
        </button>
        {filePath ? (
          <button
            type="button"
            title={filePath}
            className="text-muted-foreground hover:text-foreground bg-muted max-w-[40%] truncate rounded px-1.5 py-0.5 font-mono text-[11px]"
            onClick={() => {
              void openPath(filePath).catch((error: unknown) => {
                console.warn("agent-chat: failed to open path", filePath, error);
              });
            }}
          >
            {basename(filePath)}
          </button>
        ) : null}
        <StatusDot status={row.status} label={t(`agentChat.tool.status.${row.status}`)} />
      </div>
      {open ? (
        <div className="space-y-3 border-t px-3 py-2">
          <PayloadSection
            title={t("agentChat.tool.arguments")}
            copyText={argsCopy}
            empty={t("agentChat.tool.noArgs")}
          >
            {argsBody}
          </PayloadSection>
          <PayloadSection
            title={t("agentChat.tool.result")}
            copyText={resultCopy}
            empty={t("agentChat.tool.noResult")}
          >
            {resultBody}
          </PayloadSection>
        </div>
      ) : null}
    </div>
  );
}

export const AgentToolCard = memo(AgentToolCardBase);
