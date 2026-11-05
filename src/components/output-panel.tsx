import { useEffect, useRef, useState } from "react";
import { ChevronUp, Trash2, type LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";

/** Which pipe a line of a streamed run came from. */
export type OutputStream = "stdout" | "stderr";

export type OutputLine = {
  id: number;
  stream: OutputStream;
  text: string;
};

/** Status shared by the pages that stream a shell command. */
export type RunStatus = { kind: "idle" } | { kind: "running" } | { kind: "done"; code: number };

type OutputPanelProps = {
  title: string;
  icon: LucideIcon;
  lines: OutputLine[];
  status: RunStatus;
  running: boolean;
  onClear: () => void;
  /** Shown before anything has run. */
  placeholder: string;
  /**
   * Collapses to one line showing the newest output. The bar expands the log
   * upward over the page instead of taking height from it, so the list above
   * never jumps when the output is opened.
   */
  collapsible?: boolean;
};

/** Scrollable console output, pinned to the newest line. */
export function OutputPanel({
  title,
  icon: Icon,
  lines,
  status,
  running,
  onClear,
  placeholder,
  collapsible = false,
}: OutputPanelProps) {
  const { t } = useAppTranslation();
  const outputRef = useRef<HTMLDivElement>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const output = outputRef.current;
    if (output) {
      output.scrollTop = output.scrollHeight;
    }
  }, [lines, expanded]);

  const logLines =
    lines.length === 0 ? (
      <p className="text-muted-foreground">{placeholder}</p>
    ) : (
      lines.map((line) => (
        <div key={line.id} className={cn(line.stream === "stderr" && "text-destructive")}>
          {line.text}
        </div>
      ))
    );

  const exitBadge = status.kind === "done" && (
    <span
      className={cn(
        "rounded-full px-2 py-0.5 text-xs font-medium",
        status.code === 0 ? "bg-primary/10 text-primary" : "bg-destructive/10 text-destructive"
      )}
    >
      {t("output.exitCode", { code: status.code })}
    </span>
  );

  const clearButton = (
    <Button variant="ghost" size="sm" onClick={onClear} disabled={running || lines.length === 0}>
      <Trash2 className="size-4" />
      {t("output.clear")}
    </Button>
  );

  if (!collapsible) {
    return (
      <div className="border-border bg-card flex min-h-0 flex-1 flex-col rounded-xl border shadow-sm">
        <div className="border-border flex h-11 shrink-0 items-center justify-between border-b px-4">
          <div className="flex items-center gap-2">
            <Icon className="text-muted-foreground size-4" />
            <span className="text-sm font-medium">{title}</span>
            {exitBadge}
          </div>
          {clearButton}
        </div>

        <div
          ref={outputRef}
          className="bg-muted/40 min-h-0 flex-1 overflow-auto px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap"
        >
          {logLines}
        </div>
      </div>
    );
  }

  const latest = lines[lines.length - 1];

  return (
    <div className="relative shrink-0">
      {expanded && (
        <div
          ref={outputRef}
          className="bg-card border-border absolute inset-x-0 bottom-full z-10 mb-2 h-64 overflow-auto rounded-xl border px-4 py-3 font-mono text-xs leading-5 whitespace-pre-wrap shadow-lg"
        >
          {logLines}
        </div>
      )}

      <div className="border-border bg-card flex h-11 items-center gap-2 rounded-xl border px-4 shadow-sm">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={title}
          onClick={() => setExpanded((previous) => !previous)}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <Icon className="text-muted-foreground size-4 shrink-0" />
          <span className="shrink-0 text-sm font-medium">{title}</span>
          {exitBadge}
          <span
            className={cn(
              "text-muted-foreground min-w-0 flex-1 truncate font-mono text-xs",
              latest?.stream === "stderr" && "text-destructive"
            )}
          >
            {latest ? latest.text : placeholder}
          </span>
          <ChevronUp
            className={cn(
              "text-muted-foreground size-4 shrink-0 transition-transform",
              expanded && "rotate-180"
            )}
          />
        </button>
        {clearButton}
      </div>
    </div>
  );
}
