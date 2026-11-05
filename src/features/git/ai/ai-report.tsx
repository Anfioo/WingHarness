import { Fragment, useMemo } from "react";
import {
  parseAiReport,
  parseAiTextSegments,
  type AiReportBlock,
  type AiSeverity,
  type AiVerdictTone,
} from "@/lib/git-core/ai";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { AiText } from "./ai-text";

export interface AiReportLocate {
  canLocate: (text: string) => boolean;
  onLocate: (text: string) => void;
}

const SEVERITY_TONE: Record<AiSeverity, "destructive" | "default" | "secondary"> = {
  bug: "destructive",
  risk: "default",
  nit: "secondary",
};

const VERDICT_TEXT: Record<AiVerdictTone, string> = {
  success: "text-success",
  danger: "text-destructive",
  attention: "text-primary",
};

const VERDICT_DOT: Record<AiVerdictTone, string> = {
  success: "bg-success",
  danger: "bg-destructive",
  attention: "bg-primary",
};

function Inline({
  text,
  locate,
  locateLabel,
}: {
  text: string;
  locate?: AiReportLocate;
  locateLabel: string;
}) {
  return (
    <>
      {parseAiTextSegments(text).map((segment, index) => {
        if (segment.kind === "bold") {
          return (
            <strong key={index} className="text-foreground font-semibold">
              {segment.text}
            </strong>
          );
        }
        if (segment.kind === "code") {
          if (locate?.canLocate(segment.text)) {
            return (
              <button
                key={index}
                type="button"
                title={locateLabel}
                onClick={() => locate.onLocate(segment.text)}
                className={cn(
                  "bg-muted text-foreground rounded px-1 py-px text-left font-mono text-[0.9em]",
                  "decoration-primary/50 underline decoration-dotted underline-offset-2 transition-colors",
                  "hover:bg-primary/15 hover:text-primary focus-visible:ring-primary/60 focus-visible:ring-2 focus-visible:outline-none"
                )}
              >
                {segment.text}
              </button>
            );
          }
          return (
            <code key={index} className="bg-muted rounded px-1 py-px font-mono text-[0.9em]">
              {segment.text}
            </code>
          );
        }
        return <Fragment key={index}>{segment.text}</Fragment>;
      })}
    </>
  );
}

function Block({
  block,
  locate,
  locateLabel,
}: {
  block: AiReportBlock;
  locate?: AiReportLocate;
  locateLabel: string;
}) {
  if (block.kind === "paragraph") {
    return (
      <p className="text-foreground/90 [overflow-wrap:anywhere] whitespace-pre-wrap">
        <Inline text={block.text} locate={locate} locateLabel={locateLabel} />
      </p>
    );
  }
  return (
    <li className="flex items-start gap-2">
      {block.severity ? (
        <Badge
          variant={SEVERITY_TONE[block.severity]}
          className="mt-px h-4 shrink-0 px-1.5 text-[10px] tracking-wide uppercase"
        >
          {block.severity}
        </Badge>
      ) : (
        <span aria-hidden className="bg-foreground/35 mt-[0.55em] size-1.5 shrink-0 rounded-full" />
      )}
      <span className="text-foreground/90 min-w-0 flex-1 [overflow-wrap:anywhere]">
        <Inline text={block.text} locate={locate} locateLabel={locateLabel} />
      </span>
    </li>
  );
}

type BlockGroup =
  | { kind: "list"; blocks: AiReportBlock[] }
  | { kind: "single"; block: AiReportBlock };

function groupBlocks(blocks: AiReportBlock[]): BlockGroup[] {
  const groups: BlockGroup[] = [];
  let current: AiReportBlock[] = [];
  const flush = () => {
    if (current.length > 0) groups.push({ kind: "list", blocks: current });
    current = [];
  };
  for (const block of blocks) {
    if (block.kind === "bullet") {
      current.push(block);
    } else {
      flush();
      groups.push({ kind: "single", block });
    }
  }
  flush();
  return groups;
}

export function AiReport({
  text,
  className,
  locate,
}: {
  text: string;
  className?: string;
  locate?: AiReportLocate;
}) {
  const { t } = useAppTranslation();
  const report = useMemo(() => parseAiReport(text), [text]);
  if (!report.structured) return <AiText text={text} className={className} />;
  const locateLabel = t("gitRepo.ai.locateLine");
  return (
    <div className={cn("min-w-0 space-y-4 font-sans", className)}>
      {report.sections.map((section, index) => {
        const isVerdict =
          section.label !== null && /^verdict$/i.test(section.label) && report.verdict !== null;
        return (
          <section key={index} data-ai-section={section.label ?? index}>
            {section.label && !isVerdict && (
              <h4 className="text-muted-foreground/70 mb-1.5 text-[10px] font-semibold tracking-wide uppercase">
                {section.label}
              </h4>
            )}
            {isVerdict && report.verdict ? (
              <p
                className={cn(
                  "flex items-start gap-2 font-medium [overflow-wrap:anywhere]",
                  VERDICT_TEXT[report.verdict.tone]
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-[0.45em] size-2 shrink-0 rounded-full",
                    VERDICT_DOT[report.verdict.tone]
                  )}
                />
                <span className="min-w-0 flex-1">
                  <Inline text={report.verdict.text} locate={locate} locateLabel={locateLabel} />
                </span>
              </p>
            ) : (
              groupBlocks(section.blocks).map((group, groupIndex) =>
                group.kind === "list" ? (
                  <ul key={groupIndex} className="space-y-1.5">
                    {group.blocks.map((block, blockIndex) => (
                      <Block
                        key={blockIndex}
                        block={block}
                        locate={locate}
                        locateLabel={locateLabel}
                      />
                    ))}
                  </ul>
                ) : (
                  <Block
                    key={groupIndex}
                    block={group.block}
                    locate={locate}
                    locateLabel={locateLabel}
                  />
                )
              )
            )}
          </section>
        );
      })}
    </div>
  );
}
