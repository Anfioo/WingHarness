/**
 * Tool-call cards — the CLI-style rendering of a `tool_use` block plus its
 * `tool_result`. One shell, a handful of specialized bodies for the tools that
 * deserve one, and a generic body (pretty-printed input + output) for the rest,
 * which is also what MCP tools get.
 */

import { useState, type ReactNode } from "react";
import { Check, Copy, Loader2, type LucideIcon } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/pages/mcp-hub/ui-bits";
import type { TranscriptItem } from "@/lib/use-claude/types";
import { parseMcpToolName } from "@/lib/use-claude/parser";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { isSubagentTool, lineCount, prettyJson, stringField, toolIcon, toolTitle } from "./format";

type ToolItem = Extract<TranscriptItem, { kind: "tool" }>;

/** Copy-to-clipboard affordance used on input/output headers. */
function CopyButton({ text }: { text: string }) {
  const { t } = useAppTranslation();
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      toast.success(t("claudeChat.copied"));
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t("claudeChat.copyFailed"));
    }
  };

  return (
    <button
      type="button"
      // Inside a <summary>, so keep the click from toggling the panel too.
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void handleCopy();
      }}
      title={t("claudeChat.copy")}
      className="text-muted-foreground hover:text-foreground shrink-0"
    >
      {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
    </button>
  );
}

const MONO_HEADER =
  "border-border text-muted-foreground flex items-center gap-2 border-b px-2 py-1 font-mono text-xs tracking-wider uppercase";

const MONO_BODY =
  "max-h-72 overflow-auto px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap";

/**
 * Collapsible tool output. Errors are shown expanded and tinted: a failure is
 * the one thing the user must not have to click to see.
 */
function OutputBlock({ text, isError }: { text: string; isError: boolean }) {
  const { t } = useAppTranslation();
  if (!text) return null;
  const lines = lineCount(text);
  const label = `${t("claudeChat.output")} · ${lines}`;

  if (isError) {
    return (
      <div className="border-destructive/40 bg-destructive/5 mt-2 overflow-hidden rounded border">
        <div className={cn(MONO_HEADER, "border-destructive/30 text-destructive")}>
          <span>{label}</span>
          <span className="ml-auto">
            <CopyButton text={text} />
          </span>
        </div>
        <pre className={cn(MONO_BODY, "text-destructive")}>{text}</pre>
      </div>
    );
  }

  return (
    <details className="border-border bg-background mt-2 overflow-hidden rounded border">
      <summary className={cn(MONO_HEADER, "hover:text-foreground cursor-pointer")}>
        <span>{label}</span>
        <span className="ml-auto">
          <CopyButton text={text} />
        </span>
      </summary>
      <pre className={MONO_BODY}>{text}</pre>
    </details>
  );
}

/** Collapsed JSON block for a tool's arguments. */
function InputBlock({ input }: { input: Record<string, unknown> }) {
  const { t } = useAppTranslation();
  const json = prettyJson(input);
  return (
    <details className="border-border bg-background mt-2 overflow-hidden rounded border">
      <summary className={cn(MONO_HEADER, "hover:text-foreground cursor-pointer")}>
        <span>{t("claudeChat.input")}</span>
        <span className="ml-auto">
          <CopyButton text={json} />
        </span>
      </summary>
      <pre className={MONO_BODY}>{json}</pre>
    </details>
  );
}

/** A single command / path / code line shown in mono, wrapping as needed. */
function CommandLine({ text }: { text: string }) {
  if (!text) return null;
  return (
    <pre className="bg-muted/60 text-foreground mt-2 overflow-auto rounded px-2 py-1.5 font-mono text-xs leading-relaxed whitespace-pre-wrap">
      {text}
    </pre>
  );
}

function PathLine({ path }: { path: string }) {
  if (!path) return null;
  return (
    <div className="text-muted-foreground mt-2 truncate font-mono text-xs" title={path}>
      {path}
    </div>
  );
}

/** Old/new side of an edit — red/green plain blocks, no diff dependency. */
function DiffBlock({ sign, text }: { sign: "-" | "+"; text: string }) {
  if (!text) return null;
  const removal = sign === "-";
  return (
    <div
      className={cn(
        "mt-2 overflow-hidden rounded border",
        removal
          ? "border-destructive/30 bg-destructive/5"
          : "border-emerald-500/30 bg-emerald-500/5"
      )}
    >
      <div
        className={cn(
          MONO_HEADER,
          removal
            ? "border-destructive/30 text-destructive"
            : "border-emerald-500/30 text-emerald-600 dark:text-emerald-400"
        )}
      >
        <span>{sign}</span>
        <span className="ml-auto">
          <CopyButton text={text} />
        </span>
      </div>
      <pre className={MONO_BODY}>{text}</pre>
    </div>
  );
}

/** Card chrome: icon, title, optional badge, status, then the tool's body. */
function ToolCardShell({
  icon: Icon,
  title,
  badge,
  isRunning,
  isError,
  isStopped,
  children,
}: {
  icon: LucideIcon;
  title: string;
  badge?: ReactNode;
  isRunning: boolean;
  isError: boolean;
  isStopped: boolean;
  children: ReactNode;
}) {
  const { t } = useAppTranslation();
  return (
    <div
      className={cn(
        "rounded-lg border px-3 py-2.5 text-xs",
        isError ? "border-destructive/40 bg-destructive/5" : "border-border bg-muted/40"
      )}
    >
      <div className="flex items-center gap-2">
        <span
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded",
            isError ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary"
          )}
        >
          <Icon className="size-3.5" strokeWidth={2.25} />
        </span>
        <span className="truncate font-mono text-xs font-semibold" title={title}>
          {title}
        </span>
        {badge}
        <span className="ml-auto flex shrink-0 items-center gap-2">
          {isRunning ? (
            <>
              <Loader2 className="text-primary size-3.5 animate-spin" />
              <span className="text-muted-foreground font-mono text-xs tracking-wider uppercase">
                {t("claudeChat.toolRunning")}
              </span>
            </>
          ) : isStopped ? (
            <Badge tone="gray">{t("claudeChat.toolStopped")}</Badge>
          ) : isError ? (
            <Badge tone="red">{t("claudeChat.toolError")}</Badge>
          ) : (
            <Check className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          )}
        </span>
      </div>
      {children}
    </div>
  );
}

/** One tool call. `nested` holds sub-agent output rendered beneath the card. */
export function ToolCard({ item, nested }: { item: ToolItem; nested?: ReactNode }) {
  const { t } = useAppTranslation();
  const isRunning = item.result === null;
  const isError = item.result?.isError === true;
  const isStopped = item.result?.stopped === true;
  const output = item.result?.content ?? "";
  const input = item.input;
  const mcp = parseMcpToolName(item.toolName);

  const title = mcp ? `${mcp.server} · ${mcp.tool}` : toolTitle(item.toolName, input);
  const badge = mcp ? <Badge tone="blue">{t("claudeChat.mcp")}</Badge> : undefined;

  let body: ReactNode;
  if (mcp) {
    body = (
      <>
        <InputBlock input={input} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  } else if (item.toolName === "Bash" || item.toolName === "BashOutput") {
    body = (
      <>
        <CommandLine text={stringField(input, "command")} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  } else if (item.toolName === "Edit" || item.toolName === "MultiEdit") {
    body = (
      <>
        <PathLine path={stringField(input, "file_path")} />
        <DiffBlock sign="-" text={stringField(input, "old_string")} />
        <DiffBlock sign="+" text={stringField(input, "new_string")} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  } else if (item.toolName === "Write" || item.toolName === "NotebookEdit") {
    body = (
      <>
        <PathLine path={stringField(input, "file_path") || stringField(input, "notebook_path")} />
        <OutputBlock text={stringField(input, "content")} isError={isError} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  } else if (item.toolName === "Read") {
    body = (
      <>
        <PathLine path={stringField(input, "file_path")} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  } else if (
    item.toolName === "Grep" ||
    item.toolName === "Glob" ||
    isSubagentTool(item.toolName)
  ) {
    body = <OutputBlock text={output} isError={isError} />;
  } else {
    body = (
      <>
        <InputBlock input={input} />
        <OutputBlock text={output} isError={isError} />
      </>
    );
  }

  return (
    <ToolCardShell
      icon={toolIcon(item.toolName)}
      title={title}
      badge={badge}
      isRunning={isRunning}
      isError={isError}
      isStopped={isStopped}
    >
      {body}
      {nested}
    </ToolCardShell>
  );
}
