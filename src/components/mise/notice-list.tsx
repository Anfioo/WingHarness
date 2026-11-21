// The notices the engine attached to the dashboard or a tool: a localized
// message, the raw diagnostic detail and an optional command to run by hand.
// The level only tints the left edge and the icon.

import { AlertTriangle, CheckCircle2, Copy, Info, XCircle } from "lucide-react";
import { toast } from "sonner";

import type { MiseHealthLevel } from "@/commands";
import type { NoticeListProps } from "@/components/mise/props";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { noticeKey } from "@/lib/mise/format";
import { cn } from "@/lib/utils";

const LEVEL_ICON = {
  healthy: CheckCircle2,
  info: Info,
  warning: AlertTriangle,
  critical: XCircle,
} satisfies Record<MiseHealthLevel, typeof Info>;

const LEVEL_BORDER: Record<MiseHealthLevel, string> = {
  healthy: "border-l-emerald-500/60",
  info: "border-l-sky-500/60",
  warning: "border-l-amber-500/60",
  critical: "border-l-destructive/60",
};

const LEVEL_TEXT: Record<MiseHealthLevel, string> = {
  healthy: "text-emerald-600",
  info: "text-sky-600",
  warning: "text-amber-600",
  critical: "text-destructive",
};

export function NoticeList({ notices }: NoticeListProps) {
  const { t } = useAppTranslation();

  if (notices.length === 0) return null;

  const copyCommand = async (command: string) => {
    try {
      await navigator.clipboard.writeText(command);
      toast.success(t("mise.shell.guideCopied"));
    } catch {
      // Clipboard access can be refused; the command stays selectable by hand.
    }
  };

  return (
    <div className="flex flex-col gap-2">
      {notices.map((notice, index) => {
        const Icon = LEVEL_ICON[notice.level];
        return (
          <div
            key={`${notice.code}-${index}`}
            className={cn(
              "border-border bg-card rounded-lg border border-l-2 px-3 py-2.5",
              LEVEL_BORDER[notice.level]
            )}
          >
            <div className="flex items-start gap-2">
              <Icon className={cn("mt-0.5 size-4 shrink-0", LEVEL_TEXT[notice.level])} />
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <p className="text-sm break-words">{t(noticeKey(notice.code))}</p>
                {notice.detail && (
                  <p className="text-muted-foreground font-mono text-xs break-all select-text">
                    {notice.detail}
                  </p>
                )}
                {notice.command && (
                  <div className="flex items-start gap-1.5">
                    <code className="bg-muted min-w-0 flex-1 overflow-x-auto rounded-md px-2 py-1 font-mono text-xs select-text">
                      {notice.command}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("mise.actions.copy")}
                      title={t("mise.actions.copy")}
                      onClick={() => void copyCommand(notice.command ?? "")}
                    >
                      <Copy />
                    </Button>
                  </div>
                )}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
