import type { ReactNode } from "react";
import type { CommitFileInfo } from "@/lib/git-core";
import { cn } from "@/lib/utils";

export type ChangeMarkTone = "info" | "success" | "danger" | "primary" | "neutral";

const TONES: Record<ChangeMarkTone, string> = {
  info: "bg-info/15 text-info",
  success: "bg-success/15 text-success",
  danger: "bg-destructive/15 text-destructive",
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
    label: string;
    mark: string;
    className: string;
    tone: "info" | "success" | "danger" | "primary";
  }
> = {
  modified: { label: "modified", mark: "M", className: "text-info", tone: "info" },
  new: { label: "added", mark: "A", className: "text-success", tone: "success" },
  deleted: { label: "deleted", mark: "D", className: "text-destructive", tone: "danger" },
  renamed: { label: "renamed", mark: "R", className: "text-primary", tone: "primary" },
};
