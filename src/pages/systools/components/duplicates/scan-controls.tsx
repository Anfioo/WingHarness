import { FolderPlus, HardDrive, Loader2, Lock, LockOpen, Play, RefreshCw, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes } from "@/lib/systools/format";
import type {
  DuplicateScanLocation,
  DuplicateSizeUnit,
  DuplicateVolume,
} from "@/lib/systools/duplicates";
import { cn } from "@/lib/utils";

const SIZE_UNITS: readonly DuplicateSizeUnit[] = ["kb", "mb", "gb"];

type DuplicateScanControlsProps = {
  locations: DuplicateScanLocation[];
  minimumAmount: string;
  minimumUnit: DuplicateSizeUnit;
  volumes: DuplicateVolume[];
  scanning: boolean;
  cancelling: boolean;
  /** A delete is running; nothing may start another operation. */
  busy: boolean;
  canScan: boolean;
  hasResult: boolean;
  excludedPathCount: number;
  excludedNameCount: number;
  onMinimumAmountChange: (value: string) => void;
  onMinimumUnitChange: (unit: DuplicateSizeUnit) => void;
  onAddFolder: () => void;
  onAddVolume: (mountPoint: string) => void;
  onRemoveLocation: (path: string) => void;
  onToggleLocationMode: (path: string) => void;
  onScan: () => void;
  onCancel: () => void;
};

/**
 * Scan configuration: roots and their protection mode, minimum file size, and
 * the scan action. Locations are scan roots; a protected root never yields
 * delete candidates.
 */
export function DuplicateScanControls({
  locations,
  minimumAmount,
  minimumUnit,
  volumes,
  scanning,
  cancelling,
  busy,
  canScan,
  hasResult,
  excludedPathCount,
  excludedNameCount,
  onMinimumAmountChange,
  onMinimumUnitChange,
  onAddFolder,
  onAddVolume,
  onRemoveLocation,
  onToggleLocationMode,
  onScan,
  onCancel,
}: DuplicateScanControlsProps) {
  const { t, language } = useAppTranslation();
  const locked = scanning || busy;

  return (
    <div className="shrink-0 space-y-1.5 border-b px-3 py-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5">
          <span className="text-muted-foreground text-xs">
            {t("systools.duplicates.minimumSize")}
          </span>
          <Input
            type="number"
            min={0}
            step="any"
            inputMode="decimal"
            value={minimumAmount}
            disabled={locked}
            onChange={(event) => onMinimumAmountChange(event.target.value)}
            aria-label={t("systools.duplicates.minimumSize")}
            className="h-8 w-20 tabular-nums"
          />
          <Select
            value={minimumUnit}
            onValueChange={(value) => {
              if ((SIZE_UNITS as readonly string[]).includes(value)) {
                onMinimumUnitChange(value as DuplicateSizeUnit);
              }
            }}
            disabled={locked}
          >
            <SelectTrigger
              size="sm"
              className="w-[72px]"
              aria-label={t("systools.duplicates.minimumUnit")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SIZE_UNITS.map((unit) => (
                <SelectItem key={unit} value={unit}>
                  {t(`systools.duplicates.units.${unit}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="ml-auto flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" disabled={locked}>
                <FolderPlus className="size-4" />
                <span className="hidden sm:inline">
                  {t("systools.duplicates.actions.addLocation")}
                </span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuItem onSelect={onAddFolder}>
                <FolderPlus className="size-4" />
                {t("systools.duplicates.actions.addFolder")}
              </DropdownMenuItem>
              {volumes.length > 0 && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuLabel className="text-muted-foreground text-[11px]">
                    {t("systools.duplicates.actions.addDrive")}
                  </DropdownMenuLabel>
                  {volumes.map((volume) => (
                    <DropdownMenuItem
                      key={volume.mountPoint}
                      onSelect={() => onAddVolume(volume.mountPoint)}
                    >
                      <HardDrive className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{volume.mountPoint}</span>
                      <span className="text-muted-foreground shrink-0 text-[11px] tabular-nums">
                        {formatBytes(volume.availableBytes, language)}
                      </span>
                    </DropdownMenuItem>
                  ))}
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>

          {scanning ? (
            <Button variant="outline" size="sm" onClick={onCancel} disabled={cancelling}>
              {cancelling ? <Loader2 className="size-4 animate-spin" /> : <X className="size-4" />}
              {cancelling
                ? t("systools.duplicates.actions.cancelling")
                : t("systools.duplicates.actions.cancelScan")}
            </Button>
          ) : (
            <Button size="sm" onClick={onScan} disabled={busy || !canScan}>
              {hasResult ? <RefreshCw className="size-4" /> : <Play className="size-4" />}
              {hasResult
                ? t("systools.duplicates.actions.rescan")
                : t("systools.duplicates.actions.scan")}
            </Button>
          )}
        </div>
      </div>

      {locations.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1">
          {locations.map((location) => (
            <div
              key={location.path}
              className="bg-muted/50 flex max-w-full min-w-0 items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-1.5"
            >
              <span className="max-w-56 truncate text-[11px]" title={location.path}>
                {location.path}
              </span>
              <Tooltip>
                <TooltipTrigger asChild>
                  <button
                    type="button"
                    disabled={locked}
                    onClick={() => onToggleLocationMode(location.path)}
                    aria-label={t("systools.duplicates.locations.toggleMode", {
                      path: location.path,
                    })}
                    className={cn(
                      "flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] transition-colors disabled:opacity-50",
                      location.mode === "protected"
                        ? "text-foreground bg-background"
                        : "text-muted-foreground hover:text-foreground"
                    )}
                  >
                    {location.mode === "protected" ? (
                      <Lock className="size-3" />
                    ) : (
                      <LockOpen className="size-3" />
                    )}
                    {t(`systools.duplicates.locations.modes.${location.mode}`)}
                  </button>
                </TooltipTrigger>
                <TooltipContent>
                  {t(`systools.duplicates.locations.modeHints.${location.mode}`)}
                </TooltipContent>
              </Tooltip>
              <button
                type="button"
                disabled={locked}
                onClick={() => onRemoveLocation(location.path)}
                aria-label={t("systools.duplicates.locations.remove", { path: location.path })}
                className="text-muted-foreground hover:text-foreground hover:bg-background flex size-4 shrink-0 items-center justify-center rounded disabled:opacity-50"
              >
                <X className="size-3" />
              </button>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-muted-foreground text-[11px]">
          {t("systools.duplicates.locations.empty")}
        </p>
      )}

      <p className="text-muted-foreground truncate text-[10px]">
        {excludedPathCount > 0 || excludedNameCount > 0
          ? t("systools.duplicates.locations.exclusions", {
              paths: excludedPathCount,
              names: excludedNameCount,
            })
          : t("systools.duplicates.locations.exclusionsNone")}
      </p>
    </div>
  );
}
