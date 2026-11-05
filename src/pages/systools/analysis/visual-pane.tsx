import { ChartPie, LayoutGrid } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  ANALYSIS_CHART_MAX_DEPTH,
  type AnalysisDirectoryListing,
  type AnalysisDirectoryNode,
  type AnalysisRemainderSelection,
  type AnalysisViewId,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes } from "@/lib/systools/format";
import { Sunburst } from "./sunburst";
import { Treemap } from "./treemap";

const DEPTH_VALUES = Array.from({ length: ANALYSIS_CHART_MAX_DEPTH }, (_, index) => index + 1);

type VisualPaneProps = {
  listing: AnalysisDirectoryListing;
  hierarchy: ReadonlyMap<string, AnalysisDirectoryNode>;
  viewMode: AnalysisViewId;
  treemapDepth: number;
  sunburstDepth: number;
  canGoUp: boolean;
  selectedPath: string | null;
  disabled: boolean;
  onViewModeChange: (view: AnalysisViewId) => void;
  onTreemapDepthChange: (depth: number) => void;
  onSunburstDepthChange: (depth: number) => void;
  onSelect: (entry: DirectoryEntryInfo) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
  onShowRemainder: (selection: AnalysisRemainderSelection) => void;
  onOpen: (entry: DirectoryEntryInfo) => void;
  onReveal: (entry: DirectoryEntryInfo) => void;
  onDelete: (entry: DirectoryEntryInfo) => void;
};

/** Chart surface with the treemap/sunburst switch and depth control. */
export function VisualPane({
  listing,
  hierarchy,
  viewMode,
  treemapDepth,
  sunburstDepth,
  canGoUp,
  selectedPath,
  disabled,
  onViewModeChange,
  onTreemapDepthChange,
  onSunburstDepthChange,
  onSelect,
  onNavigate,
  onGoUp,
  onShowRemainder,
  onOpen,
  onReveal,
  onDelete,
}: VisualPaneProps) {
  const { t, language } = useAppTranslation();
  const depth = viewMode === "treemap" ? treemapDepth : sunburstDepth;

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="analysis-visual-pane">
      <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-1.5 border-b px-2 py-1">
        <div className="bg-muted/50 flex shrink-0 items-center gap-0.5 rounded-md p-0.5">
          <Button
            variant={viewMode === "treemap" ? "secondary" : "ghost"}
            size="xs"
            className="gap-1"
            aria-pressed={viewMode === "treemap"}
            onClick={() => onViewModeChange("treemap")}
          >
            <LayoutGrid className="size-3" />
            {t("systools.analysis.treemap")}
          </Button>
          <Button
            variant={viewMode === "sunburst" ? "secondary" : "ghost"}
            size="xs"
            className="gap-1"
            aria-pressed={viewMode === "sunburst"}
            onClick={() => onViewModeChange("sunburst")}
          >
            <ChartPie className="size-3" />
            {t("systools.analysis.sunburst")}
          </Button>
        </div>

        <Select
          value={String(depth)}
          onValueChange={(value) => {
            const next = Number.parseInt(value, 10);
            if (!Number.isFinite(next)) return;
            if (viewMode === "treemap") onTreemapDepthChange(next);
            else onSunburstDepthChange(next);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className="h-7 w-28 shrink-0 text-[11px]"
            aria-label={t("systools.analysis.depthLabel")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {DEPTH_VALUES.map((value) => (
              <SelectItem key={value} value={String(value)}>
                {t("systools.analysis.depth", { count: value })}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <span className="text-muted-foreground ml-auto min-w-0 truncate text-[11px] tabular-nums">
          {t("systools.analysis.totalSummary", {
            size: formatBytes(listing.bytes, language),
            count: listing.totalEntryCount,
          })}
        </span>
      </div>

      <div className="relative min-h-0 flex-1 p-1">
        {listing.entries.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
            {t("systools.analysis.emptyFolder")}
          </div>
        ) : viewMode === "treemap" ? (
          <Treemap
            listing={listing}
            hierarchy={hierarchy}
            depth={treemapDepth}
            selectedPath={selectedPath}
            disabled={disabled}
            onSelect={onSelect}
            onNavigate={onNavigate}
            onShowRemainder={onShowRemainder}
            onOpen={onOpen}
            onReveal={onReveal}
            onDelete={onDelete}
          />
        ) : (
          <Sunburst
            listing={listing}
            hierarchy={hierarchy}
            depth={sunburstDepth}
            canGoUp={canGoUp}
            selectedPath={selectedPath}
            disabled={disabled}
            onSelect={onSelect}
            onNavigate={onNavigate}
            onGoUp={onGoUp}
            onShowRemainder={onShowRemainder}
            onOpen={onOpen}
            onReveal={onReveal}
            onDelete={onDelete}
          />
        )}
      </div>
    </div>
  );
}
