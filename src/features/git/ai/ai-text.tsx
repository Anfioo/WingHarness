import { Fragment } from "react";
import { parseAiTextSegments } from "@/lib/git-core/ai";
import { cn } from "@/lib/utils";

export function AiText({ text, className }: { text: string; className?: string }) {
  return (
    <div
      className={cn("min-w-0 font-sans [overflow-wrap:anywhere] whitespace-pre-wrap", className)}
    >
      {parseAiTextSegments(text).map((segment, index) => {
        if (segment.kind === "bold") {
          return (
            <strong key={index} className="text-foreground font-semibold">
              {segment.text}
            </strong>
          );
        }
        if (segment.kind === "code") {
          return (
            <code key={index} className="bg-muted rounded px-1 py-px font-mono text-[0.9em]">
              {segment.text}
            </code>
          );
        }
        return <Fragment key={index}>{segment.text}</Fragment>;
      })}
    </div>
  );
}
