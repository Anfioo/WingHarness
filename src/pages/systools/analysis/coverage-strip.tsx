import { useState } from "react";
import { AlertTriangle, CheckCircle2, Info, ShieldAlert, ShieldCheck } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  ANALYSIS_OMISSION_KEYS,
  omissionCount,
  totalOmissions,
  type AnalysisCoverage,
  type AnalysisOmissionKey,
} from "@/lib/systools/storage";
import { formatCount } from "@/lib/systools/format";
import { cn } from "@/lib/utils";

type CoverageStripProps = {
  coverage: AnalysisCoverage | undefined;
  skippedCount: number;
};

type OmissionRow = {
  key: AnalysisOmissionKey;
  count: number;
};

function extraOmissionCount(coverage: AnalysisCoverage | undefined): number {
  if (!coverage) return 0;
  const known = new Set<string>(ANALYSIS_OMISSION_KEYS);
  let total = 0;
  for (const [key, value] of Object.entries(coverage.omissions)) {
    if (known.has(key) || typeof value !== "number" || !Number.isFinite(value)) continue;
    total += value;
  }
  return total;
}

/** Summarizes entries the scan could not count and whether elevation was available. */
export function CoverageStrip({ coverage, skippedCount }: CoverageStripProps) {
  const { t, language } = useAppTranslation();
  const [open, setOpen] = useState(false);

  const total = totalOmissions(coverage, skippedCount);
  const rows: OmissionRow[] = ANALYSIS_OMISSION_KEYS.map((key) => ({
    key,
    count:
      key === "other"
        ? omissionCount(coverage, key) + extraOmissionCount(coverage)
        : omissionCount(coverage, key),
  })).filter((row) => row.count > 0);

  const elevation = coverage?.elevated;
  const elevationLabel =
    elevation === true
      ? t("systools.analysis.coverage.administrator")
      : elevation === false
        ? t("systools.analysis.coverage.standardUser")
        : t("systools.analysis.coverage.unavailable");
  const ElevationIcon = elevation === true ? ShieldCheck : ShieldAlert;

  return (
    <div
      className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b px-3 py-1 text-[11px]"
      data-slot="analysis-coverage"
    >
      {total > 0 ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded-sm text-left focus-visible:ring-[3px] focus-visible:outline-none"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
        >
          <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
          <span>
            {t("systools.analysis.coverage.summary", {
              count: total,
            })}
          </span>
          <Info className="size-3 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      ) : (
        <span className="text-muted-foreground inline-flex items-center gap-1">
          <CheckCircle2 className="size-3.5 shrink-0" aria-hidden="true" />
          {t("systools.analysis.coverage.complete")}
        </span>
      )}

      <span
        className={cn(
          "ml-auto inline-flex items-center gap-1",
          elevation === true ? "text-muted-foreground" : "text-muted-foreground/80"
        )}
        title={t("systools.analysis.coverage.elevationHint")}
      >
        <ElevationIcon className="size-3.5 shrink-0" aria-hidden="true" />
        {elevationLabel}
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("systools.analysis.coverage.title")}</DialogTitle>
            <DialogDescription>{t("systools.analysis.coverage.description")}</DialogDescription>
          </DialogHeader>

          <dl className="bg-muted/40 rounded-md border px-3 py-2 text-xs">
            {rows.map((row) => (
              <div
                key={row.key}
                className="flex items-center justify-between gap-3 border-b py-1 last:border-b-0"
              >
                <dt className="text-muted-foreground">
                  {t(`systools.analysis.coverage.${row.key}`)}
                </dt>
                <dd className="font-medium tabular-nums">{formatCount(row.count, language)}</dd>
              </div>
            ))}
            {rows.length === 0 ? (
              <div className="text-muted-foreground py-1">
                {t("systools.analysis.coverage.complete")}
              </div>
            ) : null}
          </dl>

          <div className="text-muted-foreground space-y-1 text-[11px]">
            <p className="flex items-start gap-1.5">
              <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{t("systools.analysis.coverage.countHint")}</span>
            </p>
            <p className="flex items-start gap-1.5">
              <ElevationIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                {elevation === true
                  ? t("systools.analysis.coverage.administratorHint")
                  : t("systools.analysis.coverage.standardUserHint")}
              </span>
            </p>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
