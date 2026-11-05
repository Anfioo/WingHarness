import type { ReactNode } from "react";
import type { CommitFileInfo } from "@/lib/git-core";
import { cn } from "@/lib/utils";

export type ChangeMarkTone = "info" | "success" | "destructive" | "primary" | "neutral";

const TONES: Record<ChangeMarkTone, string> = {
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  destructive: "bg-destructive/15 text-destructive",
  primary: "bg-primary/15 text-primary",
  neutral: "bg-muted text-muted-foreground",
};

export function ChangeMark({
  tone,
  children,
  className,
  title,
}: {
  tone: ChangeMarkTone;
  children: ReactNode;
  className?: string;
  title?: string;
}) {
  return (
    <span
      title={title}
      data-change-mark
      className={cn(
        "inline-flex size-4 shrink-0 items-center justify-center rounded-[4px] font-mono text-[10px] leading-none font-semibold",
        TONES[tone],
        className
      )}
    >
      {children}
    </span>
  );
}

export const statusMeta: Record<
  CommitFileInfo["status"],
  {
    labelKey: string;
    mark: string;
    className: string;
    tone: "info" | "success" | "destructive" | "primary";
  }
> = {
  modified: {
    labelKey: "gitRepo.inspector.status.modified",
    mark: "M",
    className: "text-info",
    tone: "info",
  },
  new: {
    labelKey: "gitRepo.inspector.status.added",
    mark: "A",
    className: "text-success",
    tone: "success",
  },
  deleted: {
    labelKey: "gitRepo.inspector.status.deleted",
    mark: "D",
    className: "text-destructive",
    tone: "destructive",
  },
  renamed: {
    labelKey: "gitRepo.inspector.status.renamed",
    mark: "R",
    className: "text-primary",
    tone: "primary",
  },
};
