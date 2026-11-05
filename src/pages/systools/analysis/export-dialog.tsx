import { useState } from "react";
import { Download, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  ANALYSIS_EXPORT_DEPTHS,
  ANALYSIS_EXPORT_ENTRY_LIMITS,
  ANALYSIS_EXPORT_FORMATS,
  type AnalysisExportDepth,
  type AnalysisExportEntryLimit,
  type AnalysisExportFormat,
} from "@/lib/systools/storage";

export type AnalysisExportOptions = {
  maxDepth: AnalysisExportDepth;
  maxEntries: AnalysisExportEntryLimit;
  includeFullPaths: boolean;
  format: AnalysisExportFormat;
};

type ExportDialogProps = {
  open: boolean;
  exporting: boolean;
  onOpenChange: (open: boolean) => void;
  onExport: (options: AnalysisExportOptions) => void;
};

function parseDepth(value: string): AnalysisExportDepth {
  const parsed = Number.parseInt(value, 10);
  const match = ANALYSIS_EXPORT_DEPTHS.find((depth) => depth === parsed);
  return match ?? 3;
}

function parseEntryLimit(value: string): AnalysisExportEntryLimit {
  const parsed = Number.parseInt(value, 10);
  const match = ANALYSIS_EXPORT_ENTRY_LIMITS.find((limit) => limit === parsed);
  return match ?? 500;
}

function parseFormat(value: string): AnalysisExportFormat {
  return ANALYSIS_EXPORT_FORMATS.find((format) => format === value) ?? "json";
}

/** Export preferences; the page owns the save dialog and native request. */
export function ExportDialog({ open, exporting, onOpenChange, onExport }: ExportDialogProps) {
  const { t } = useAppTranslation();
  const [depth, setDepth] = useState<AnalysisExportDepth>(3);
  const [entryLimit, setEntryLimit] = useState<AnalysisExportEntryLimit>(500);
  const [includeFullPaths, setIncludeFullPaths] = useState(false);
  const [format, setFormat] = useState<AnalysisExportFormat>("json");

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!exporting) onOpenChange(next);
      }}
    >
      <DialogContent className="sm:max-w-md" showCloseButton={!exporting}>
        <DialogHeader>
          <DialogTitle>{t("systools.analysis.export.title")}</DialogTitle>
          <DialogDescription>{t("systools.analysis.export.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("systools.analysis.export.depthLabel")}
              </span>
              <Select
                value={String(depth)}
                onValueChange={(value) => setDepth(parseDepth(value))}
                disabled={exporting}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label={t("systools.analysis.export.depthLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANALYSIS_EXPORT_DEPTHS.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {t("systools.analysis.depth", { count: value })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>

            <label className="space-y-1 text-xs">
              <span className="text-muted-foreground">
                {t("systools.analysis.export.entryLimitLabel")}
              </span>
              <Select
                value={String(entryLimit)}
                onValueChange={(value) => setEntryLimit(parseEntryLimit(value))}
                disabled={exporting}
              >
                <SelectTrigger
                  size="sm"
                  className="w-full"
                  aria-label={t("systools.analysis.export.entryLimitLabel")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ANALYSIS_EXPORT_ENTRY_LIMITS.map((value) => (
                    <SelectItem key={value} value={String(value)}>
                      {value === 0
                        ? t("systools.analysis.export.entryLimitAll")
                        : t("systools.analysis.export.entryLimit", { count: value })}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </div>

          <label className="space-y-1 text-xs">
            <span className="text-muted-foreground">
              {t("systools.analysis.export.formatLabel")}
            </span>
            <Select
              value={format}
              onValueChange={(value) => setFormat(parseFormat(value))}
              disabled={exporting}
            >
              <SelectTrigger
                size="sm"
                className="w-full"
                aria-label={t("systools.analysis.export.formatLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="json">{t("systools.analysis.export.formatJson")}</SelectItem>
                <SelectItem value="markdown">
                  {t("systools.analysis.export.formatMarkdown")}
                </SelectItem>
              </SelectContent>
            </Select>
          </label>

          <div className="bg-muted/40 flex items-start gap-3 rounded-md border px-3 py-2">
            <div className="min-w-0 flex-1 space-y-0.5">
              <p className="text-xs font-medium">
                {t("systools.analysis.export.includeFullPaths")}
              </p>
              <p className="text-muted-foreground text-[10px] leading-relaxed">
                {t("systools.analysis.export.includeFullPathsHint")}
              </p>
            </div>
            <Switch
              checked={includeFullPaths}
              onCheckedChange={setIncludeFullPaths}
              disabled={exporting}
              aria-label={t("systools.analysis.export.includeFullPaths")}
            />
          </div>

          <p className="text-muted-foreground text-[10px] leading-relaxed">
            {t("systools.analysis.export.note")}
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={exporting}>
            {t("systools.common.cancel")}
          </Button>
          <Button
            onClick={() =>
              onExport({ maxDepth: depth, maxEntries: entryLimit, includeFullPaths, format })
            }
            disabled={exporting}
          >
            {exporting ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Download className="size-4" />
            )}
            {exporting
              ? t("systools.analysis.export.exporting")
              : t("systools.analysis.export.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
