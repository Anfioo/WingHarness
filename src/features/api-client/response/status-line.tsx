import type { ReactNode } from "react";
import { AlertTriangle, Clock, Database, Link2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { formatBytes, formatDuration } from "@/lib/api-core/format";
import type { HttpResponse } from "@/lib/api-core/types";
import { cn } from "@/lib/utils";

/** Colour tone for an HTTP status: green for 2xx, amber for 3xx, red for 4xx+. */
function statusTone(status: number): string {
  if (status >= 400) return "text-destructive";
  if (status >= 300) return "text-amber-600 dark:text-amber-500";
  if (status >= 200) return "text-emerald-600 dark:text-emerald-500";
  return "text-muted-foreground";
}

/**
 * The response status line: the colour-coded HTTP status, the elapsed duration
 * and the received body size, plus a truncation badge when the engine cut the
 * body off at the size cap.
 */
export function StatusLine({ response }: { response: HttpResponse }): ReactNode {
  const { t } = useTranslation("translation", { keyPrefix: "apiClient.response" });
  const statusText = response.statusText.trim();
  const code = statusText === "" ? String(response.status) : `${response.status} ${statusText}`;

  return (
    <div className="border-border flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b px-3">
      <span
        className={cn("font-mono text-xs font-semibold", statusTone(response.status))}
        aria-label={t("status.label")}
      >
        {code}
      </span>
      <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
        <Clock className="size-3.5 shrink-0" aria-hidden />
        {formatDuration(response.durationMs)}
      </span>
      <span className="text-muted-foreground flex items-center gap-1 text-[11px]">
        <Database className="size-3.5 shrink-0" aria-hidden />
        {formatBytes(response.sizeBytes)}
      </span>
      {response.finalUrl === "" ? null : (
        <span
          className="text-muted-foreground flex min-w-0 flex-1 items-center gap-1 text-[11px]"
          title={response.finalUrl}
          aria-label={t("status.finalUrl")}
        >
          <Link2 className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate font-mono">{response.finalUrl}</span>
        </span>
      )}
      {response.truncated ? (
        <Badge
          variant="outline"
          className="ml-auto border-amber-500/40 text-[10px] text-amber-600 dark:text-amber-500"
          title={t("status.truncatedHint")}
        >
          <AlertTriangle />
          {t("status.truncated")}
        </Badge>
      ) : null}
    </div>
  );
}

export default StatusLine;
