import { FolderPlus, FolderTree, Loader2, ScanSearch, Square, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { LargeFileScanMode, MinimumSizeUnit, VolumeInfo } from "@/lib/systools/large-files";

type LargeFilesToolbarProps = {
  roots: string[];
  volumes: VolumeInfo[];
  minimumValue: string;
  minimumUnit: MinimumSizeUnit;
  scanMode: LargeFileScanMode;
  hasResult: boolean;
  scanning: boolean;
  cancelling: boolean;
  /** Blocks edits while a filter or delete is in flight. */
  busy: boolean;
  onMinimumValueChange: (value: string) => void;
  onMinimumUnitChange: (unit: MinimumSizeUnit) => void;
  onScanModeChange: (mode: LargeFileScanMode) => void;
  onAddFolder: () => void;
  onAddDrive: (mountPoint: string) => void;
  onRemoveRoot: (path: string) => void;
  onScan: () => void;
  onCancel: () => void;
};

const SCAN_MODES: readonly LargeFileScanMode[] = ["quick", "complete"];
const MINIMUM_UNITS: readonly MinimumSizeUnit[] = ["mb", "gb"];

function isScanMode(value: string): value is LargeFileScanMode {
  return (SCAN_MODES as readonly string[]).includes(value);
}

function isMinimumUnit(value: string): value is MinimumSizeUnit {
  return (MINIMUM_UNITS as readonly string[]).includes(value);
}

/** Roots, threshold, scan mode, and the scan/cancel actions. */
export function LargeFilesToolbar({
  roots,
  volumes,
  minimumValue,
  minimumUnit,
  scanMode,
  hasResult,
  scanning,
  cancelling,
  busy,
  onMinimumValueChange,
  onMinimumUnitChange,
  onScanModeChange,
  onAddFolder,
  onAddDrive,
  onRemoveRoot,
  onScan,
  onCancel,
}: LargeFilesToolbarProps) {
  const { t } = useAppTranslation();
  const locked = busy || scanning;

  return (
    <div className="shrink-0 space-y-2 border-b px-3 py-2">
      <div className="flex min-w-0 items-center gap-2">
        <FolderTree className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
          {roots.length === 0 ? (
            <span className="text-muted-foreground text-xs">
              {t("systools.largeFiles.roots.empty")}
            </span>
          ) : (
            roots.map((root) => (
              <Badge
                key={root}
                variant="secondary"
                className="max-w-44 gap-1 pr-0.5 pl-2 font-normal"
              >
                <span className="truncate" title={root}>
                  {root}
                </span>
                <button
                  type="button"
                  className="hover:bg-background/70 rounded-sm p-0.5"
                  aria-label={t("systools.largeFiles.roots.remove", { path: root })}
                  onClick={() => onRemoveRoot(root)}
                  disabled={locked}
                >
                  <X className="size-3" />
                </button>
              </Badge>
            ))
          )}
        </div>

        <Select value="" onValueChange={onAddDrive} disabled={locked}>
          <SelectTrigger
            size="sm"
            className="w-28 shrink-0"
            aria-label={t("systools.largeFiles.roots.addDrive")}
          >
            <SelectValue placeholder={t("systools.largeFiles.roots.addDrive")} />
          </SelectTrigger>
          <SelectContent>
            {volumes.length === 0 ? (
              <div className="text-muted-foreground px-2 py-1.5 text-xs">
                {t("systools.largeFiles.roots.noDrives")}
              </div>
            ) : (
              volumes.map((volume) => (
                <SelectItem key={volume.mountPoint} value={volume.mountPoint}>
                  {volume.name ? `${volume.name} · ${volume.mountPoint}` : volume.mountPoint}
                </SelectItem>
              ))
            )}
          </SelectContent>
        </Select>

        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={onAddFolder}
          disabled={locked}
          aria-label={t("systools.largeFiles.roots.browse")}
          title={t("systools.largeFiles.roots.browse")}
        >
          <FolderPlus className="size-4" />
          <span className="hidden sm:inline">{t("systools.largeFiles.roots.browse")}</span>
        </Button>
      </div>

      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <label className="flex shrink-0 items-center gap-1.5 text-xs">
          <span className="text-muted-foreground">{t("systools.largeFiles.minimumSize")}</span>
          <Input
            type="number"
            min={1}
            step={1}
            inputMode="numeric"
            value={minimumValue}
            onChange={(event) => onMinimumValueChange(event.target.value)}
            disabled={busy}
            className="h-8 w-16 tabular-nums"
            aria-label={t("systools.largeFiles.minimumSize")}
          />
          <Select
            value={minimumUnit}
            onValueChange={(value) => {
              if (isMinimumUnit(value)) onMinimumUnitChange(value);
            }}
            disabled={busy}
          >
            <SelectTrigger
              size="sm"
              className="w-16"
              aria-label={t("systools.largeFiles.minimumUnit")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="mb">{t("systools.largeFiles.units.mb")}</SelectItem>
              <SelectItem value="gb">{t("systools.largeFiles.units.gb")}</SelectItem>
            </SelectContent>
          </Select>
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
            className="w-32 shrink-0"
            aria-label={t("systools.largeFiles.scanMode.label")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="quick">{t("systools.largeFiles.scanMode.quick")}</SelectItem>
            <SelectItem value="complete">{t("systools.largeFiles.scanMode.complete")}</SelectItem>
          </SelectContent>
        </Select>

        <span className="text-muted-foreground hidden min-w-0 flex-1 truncate text-[11px] md:block">
          {scanMode === "quick"
            ? t("systools.largeFiles.scanMode.quickHint")
            : t("systools.largeFiles.scanMode.completeHint")}
        </span>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {scanning ? (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Square className="size-3.5" />
              )}
              {cancelling
                ? t("systools.largeFiles.actions.cancelling")
                : t("systools.largeFiles.actions.cancelScan")}
            </Button>
          ) : (
            <Button size="sm" onClick={onScan} disabled={busy || roots.length === 0}>
              <ScanSearch className="size-4" />
              {hasResult
                ? t("systools.largeFiles.actions.rescan")
                : t("systools.largeFiles.actions.scan")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
