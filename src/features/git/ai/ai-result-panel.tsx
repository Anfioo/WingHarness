import { useEffect, useState, type ReactNode } from "react";
import { Loader2, Maximize2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { AiReport } from "./ai-report";
import { AiResultDialog } from "./ai-result-dialog";
import { Hint } from "./hint";
import { useWaitMessage } from "./wait-messages";

export function AiResultPanel({
  title,
  icon,
  busy,
  waitMessages,
  text,
  onStop,
  onDismiss,
  className,
  bodyClassName,
}: {
  title: string;
  icon: ReactNode;
  busy: boolean;
  waitMessages: readonly string[];
  text: string | null;
  onStop: () => void;
  onDismiss?: () => void;
  className?: string;
  bodyClassName?: string;
}) {
  const { t } = useAppTranslation();
  const [expanded, setExpanded] = useState(false);
  const wait = useWaitMessage(busy, waitMessages);
  useEffect(() => {
    if (!text) setExpanded(false);
  }, [text]);
  if (!busy && !text) return null;
  return (
    <div
      data-ai-result-panel={busy ? "busy" : "done"}
      className={cn(
        "border-primary/30 bg-primary/5 rounded-md border text-xs leading-relaxed",
        className
      )}
    >
      <div className="flex items-center justify-between pt-1.5 pr-1.5 pl-3">
        <span className="text-primary flex items-center gap-1.5 font-medium">
          {icon} {title}
        </span>
        {busy ? (
          <Hint label={t("gitRepo.ai.panel.stop", { title })}>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={t("gitRepo.ai.panel.stop", { title })}
              onClick={onStop}
            >
              <X className="size-3" />
            </Button>
          </Hint>
        ) : (
          <span className="flex items-center">
            <Hint label={t("gitRepo.ai.panel.expand", { title })}>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("gitRepo.ai.panel.expand", { title })}
                onClick={() => setExpanded(true)}
              >
                <Maximize2 className="size-3" />
              </Button>
            </Hint>
            {onDismiss && (
              <Hint label={t("gitRepo.ai.panel.dismiss", { title })}>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={t("gitRepo.ai.panel.dismiss", { title })}
                  onClick={onDismiss}
                >
                  <X className="size-3" />
                </Button>
              </Hint>
            )}
          </span>
        )}
      </div>
      {busy ? (
        <div className="text-muted-foreground flex items-center gap-2.5 px-3 pt-1.5 pb-2.5">
          <Loader2 className="text-primary size-4 shrink-0 animate-spin" />
          <span key={wait.key} className="animate-fade-in">
            {wait.text}
          </span>
        </div>
      ) : (
        <div className={cn("overflow-y-auto px-3 pt-1 pb-2.5", bodyClassName)}>
          <AiReport text={text ?? ""} />
        </div>
      )}
      <AiResultDialog
        open={expanded && !!text}
        onOpenChange={(open) => !open && setExpanded(false)}
        title={title}
        icon={icon}
        text={text ?? ""}
      />
    </div>
  );
}
