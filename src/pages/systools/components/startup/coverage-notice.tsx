import { AlertTriangle, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { StartupCatalog, StartupSourceCoverage } from "@/lib/systools/startup";
import { coverageReasonKey, startupSourceLabelKey } from "./startup-labels";

type CoverageNoticeProps = {
  catalog: StartupCatalog;
  onDismiss: () => void;
};

function isProblem(entry: StartupSourceCoverage): boolean {
  return entry.status === "unavailable" || entry.status === "failed";
}

/** Banners the startup sources that the scan could not read. */
export function CoverageNotice({ catalog, onDismiss }: CoverageNoticeProps) {
  const { t } = useAppTranslation();
  const problems = catalog.coverage.filter(isProblem);

  if (catalog.complete && problems.length === 0) return null;

  return (
    <div
      role="status"
      className="border-border bg-muted/40 mx-3 mt-2 flex items-start gap-2 rounded-md border px-3 py-2 text-xs"
    >
      <AlertTriangle className="text-muted-foreground mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{t("systools.startup.coverage.title")}</p>
        {problems.length > 0 ? (
          <ul className="text-muted-foreground mt-1 space-y-1">
            {problems.map((entry) => {
              const labelKey = startupSourceLabelKey(entry.sourceId);
              return (
                <li key={entry.sourceId} className="flex flex-wrap items-center gap-1.5">
                  <span className="text-foreground font-medium">
                    {labelKey ? t(labelKey) : entry.sourceId}
                  </span>
                  <Badge
                    variant={entry.status === "failed" ? "destructive" : "outline"}
                    className="text-[10px] leading-4"
                  >
                    {t(`systools.startup.coverage.${entry.status}`)}
                  </Badge>
                  <span>{t(coverageReasonKey(entry.reason))}</span>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="text-muted-foreground mt-1">{t("systools.startup.coverage.partial")}</p>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t("systools.startup.detail.close")}
        title={t("systools.startup.detail.close")}
        onClick={onDismiss}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
