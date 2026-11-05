import { Download, FolderOpen, Loader2, RefreshCw, ScanSearch, Square } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { ANALYSIS_SCAN_MODES, type AnalysisScanMode } from "@/lib/systools/storage";

type AnalysisToolbarProps = {
  path: string;
  scanMode: AnalysisScanMode;
  refresh: boolean;
  scanning: boolean;
  cancelling: boolean;
  /** Blocks actions while a delete or export is in flight. */
  busy: boolean;
  hasResult: boolean;
  onPathChange: (path: string) => void;
  onBrowse: () => void;
  onRefreshChange: (refresh: boolean) => void;
  onScanModeChange: (mode: AnalysisScanMode) => void;
  onScan: () => void;
  onCancel: () => void;
  onExport: () => void;
};

function isScanMode(value: string): value is AnalysisScanMode {
  return (ANALYSIS_SCAN_MODES as readonly string[]).includes(value);
}

/** Folder picker, scan mode, refresh toggle, and the scan/export actions. */
export function AnalysisToolbar({
  path,
  scanMode,
  refresh,
  scanning,
  cancelling,
  busy,
  hasResult,
  onPathChange,
  onBrowse,
  onRefreshChange,
  onScanModeChange,
  onScan,
  onCancel,
  onExport,
}: AnalysisToolbarProps) {
  const { t } = useAppTranslation();
  const locked = scanning || busy;

  return (
    <div className="shrink-0 space-y-2 border-b px-3 py-2" data-slot="analysis-toolbar">
      <div className="flex min-w-0 items-center gap-2">
        <FolderOpen className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <Input
          value={path}
          onChange={(event) => onPathChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && path.trim() && !locked) onScan();
          }}
          placeholder={t("systools.analysis.toolbar.pathPlaceholder")}
          aria-label={t("systools.analysis.toolbar.pathLabel")}
          className="h-8 min-w-0 flex-1 text-xs"
          disabled={scanning}
          spellCheck={false}
        />
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onBrowse}
          disabled={locked}
          aria-label={t("systools.analysis.toolbar.browse")}
          title={t("systools.analysis.toolbar.browse")}
        >
          <FolderOpen className="size-4" />
        </Button>

        {scanning ? (
          <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
            {cancelling ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Square className="size-3.5" />
            )}
            {cancelling
              ? t("systools.analysis.toolbar.cancelling")
              : t("systools.analysis.toolbar.cancel")}
          </Button>
        ) : (
          <Button size="sm" onClick={onScan} disabled={locked || !path.trim()}>
            <ScanSearch className="size-4" />
            {hasResult
              ? t("systools.analysis.toolbar.rescan")
              : t("systools.analysis.toolbar.scan")}
          </Button>
        )}

        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onExport}
          disabled={locked || !hasResult}
          aria-label={t("systools.analysis.toolbar.export")}
          title={t("systools.analysis.toolbar.export")}
        >
          <Download className="size-4" />
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
        <label className="flex shrink-0 items-center gap-1.5">
          <Switch
            checked={refresh}
            onCheckedChange={onRefreshChange}
            disabled={locked}
            aria-label={t("systools.analysis.toolbar.refreshLabel")}
          />
          <span className="text-muted-foreground inline-flex items-center gap-1">
            <RefreshCw className="size-3" aria-hidden="true" />
            {t("systools.analysis.toolbar.refresh")}
          </span>
        </label>

        <Select
          value={scanMode}
          onValueChange={(value) => {
            if (isScanMode(value)) onScanModeChange(value);
          }}
          disabled={locked}
        >
          <SelectTrigger
            size="sm"
            className="h-7 w-32 shrink-0 text-xs"
            aria-label={t("systools.analysis.toolbar.scanModeLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="standard">{t("systools.analysis.scanMode.standard")}</SelectItem>
            <SelectItem value="fast">{t("systools.analysis.scanMode.fast")}</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-muted-foreground hidden min-w-0 flex-1 truncate text-[11px] sm:block">
          {scanMode === "standard"
            ? t("systools.analysis.scanMode.standardHint")
            : t("systools.analysis.scanMode.fastHint")}
        </span>
      </div>
    </div>
  );
}
