import { useMemo, useRef, useState, type MouseEvent } from "react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  samePath,
  type AnalysisDirectoryListing,
  type AnalysisDirectoryNode,
  type AnalysisRemainderSelection,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes, formatShare } from "@/lib/systools/format";
import { FileEntryContextMenu } from "../components/file-entry-context-menu";
import {
  SUNBURST_INNER_RADIUS,
  SUNBURST_VIEWBOX,
  layoutSunburst,
  type AnalysisSunburstSector,
} from "./layout";

type SunburstProps = {
  listing: AnalysisDirectoryListing;
  hierarchy: ReadonlyMap<string, AnalysisDirectoryNode>;
  depth: number;
  canGoUp: boolean;
  selectedPath: string | null;
  disabled: boolean;
  onSelect: (entry: DirectoryEntryInfo) => void;
  onNavigate: (path: string) => void;
  onGoUp: () => void;
  onShowRemainder: (selection: AnalysisRemainderSelection) => void;
  onOpen: (entry: DirectoryEntryInfo) => void;
  onReveal: (entry: DirectoryEntryInfo) => void;
  onDelete: (entry: DirectoryEntryInfo) => void;
};

type HoverState = {
  sector: AnalysisSunburstSector;
  x: number;
  y: number;
};

type ContextTarget = {
  entry: DirectoryEntryInfo;
  level: number;
};

function shortName(name: string, limit = 16): string {
  return name.length <= limit ? name : `${name.slice(0, Math.max(1, limit - 1))}…`;
}

/** Hand-written radial view; one ring per level, center click goes up. */
export function Sunburst({
  listing,
  hierarchy,
  depth,
  canGoUp,
  selectedPath,
  disabled,
  onSelect,
  onNavigate,
  onGoUp,
  onShowRemainder,
  onOpen,
  onReveal,
  onDelete,
}: SunburstProps) {
  const { t, language } = useAppTranslation();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<HoverState | null>(null);
  const [context, setContext] = useState<ContextTarget | null>(null);
  const pendingContext = useRef<ContextTarget | null>(null);

  const sectors = useMemo(
    () => layoutSunburst({ listing, hierarchy, depth }),
    [listing, hierarchy, depth]
  );

  const showTooltip = (sector: AnalysisSunburstSector, event: MouseEvent<SVGPathElement>) => {
    const bounds = containerRef.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({
      sector,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };

  const activateSector = (sector: AnalysisSunburstSector) => {
    if (disabled) return;
    if (sector.remainder) {
      onShowRemainder(sector.remainder);
      return;
    }
    if (!sector.entry) return;
    if (sector.entry.isDirectory) onNavigate(sector.entry.path);
    else onSelect(sector.entry);
  };

  const markSectorContext = (sector: AnalysisSunburstSector) => {
    pendingContext.current =
      sector.entry && !disabled ? { entry: sector.entry, level: sector.level } : null;
  };

  const openContextMenu = (event: MouseEvent<HTMLElement>) => {
    const target = pendingContext.current;
    pendingContext.current = null;
    if (!target || disabled) {
      event.preventDefault();
      return;
    }
    setContext(target);
  };

  return (
    <FileEntryContextMenu
      openDisabled={disabled || !context}
      revealDisabled={disabled || !context}
      deleteDisabled={
        disabled || !context || Boolean(context.entry.deletionProtection) || context.level > 1
      }
      onOpen={() => {
        if (context) onOpen(context.entry);
      }}
      onReveal={() => {
        if (context) onReveal(context.entry);
      }}
      onDelete={() => {
        if (context) onDelete(context.entry);
      }}
      onContextMenu={openContextMenu}
    >
      <div
        ref={containerRef}
        className="relative flex h-full w-full items-center justify-center overflow-hidden"
        data-slot="analysis-sunburst"
      >
        <svg
          viewBox={`${-SUNBURST_VIEWBOX / 2} ${-SUNBURST_VIEWBOX / 2} ${SUNBURST_VIEWBOX} ${SUNBURST_VIEWBOX}`}
          className="max-h-full max-w-full"
          role="img"
          aria-label={t("systools.analysis.sunburstLabel", { path: listing.path })}
        >
          {sectors.map((sector) => {
            const selected = Boolean(
              sector.entry && selectedPath && samePath(sector.entry.path, selectedPath)
            );
            const isHovered = hover?.sector.key === sector.key;
            const interactive = Boolean(sector.entry || sector.remainder) && !disabled;
            return (
              <g key={sector.key}>
                <path
                  d={sector.pathData}
                  fill={sector.color}
                  fillOpacity={selected ? 0.62 : isHovered ? 0.48 : 0.3}
                  stroke="var(--background)"
                  strokeWidth={0.8}
                  strokeDasharray={sector.remainder ? "4 3" : undefined}
                  className={interactive ? "cursor-pointer" : undefined}
                  onClick={() => activateSector(sector)}
                  onContextMenu={() => markSectorContext(sector)}
                  onMouseEnter={(event) => showTooltip(sector, event)}
                  onMouseLeave={() => setHover(null)}
                />
                {sector.label ? (
                  <text
                    x={sector.labelX}
                    y={sector.labelY}
                    transform={`rotate(${sector.labelRotation} ${sector.labelX} ${sector.labelY})`}
                    fontSize={9}
                    textAnchor="middle"
                    dominantBaseline="middle"
                    fill="var(--foreground)"
                    fillOpacity={0.92}
                    stroke="var(--background)"
                    strokeWidth={2.2}
                    paintOrder="stroke"
                    style={{ pointerEvents: "none" }}
                  >
                    {sector.label}
                  </text>
                ) : null}
              </g>
            );
          })}

          <g
            onClick={canGoUp && !disabled ? onGoUp : undefined}
            className={canGoUp && !disabled ? "cursor-pointer" : undefined}
            role={canGoUp ? "button" : undefined}
            aria-label={canGoUp ? t("systools.analysis.back") : undefined}
          >
            <title>{canGoUp ? t("systools.analysis.back") : listing.path}</title>
            <circle
              r={SUNBURST_INNER_RADIUS - 2}
              fill="var(--card)"
              stroke="var(--border)"
              strokeWidth={1}
            />
            <text
              x={0}
              y={-18}
              textAnchor="middle"
              fontSize={11}
              fontWeight={600}
              fill="var(--foreground)"
              style={{ pointerEvents: "none" }}
            >
              {shortName(listing.name, 18)}
            </text>
            <text
              x={0}
              y={2}
              textAnchor="middle"
              fontSize={10}
              fill="var(--foreground)"
              fillOpacity={0.85}
              style={{ pointerEvents: "none" }}
            >
              {formatBytes(listing.bytes, language)}
            </text>
            <text
              x={0}
              y={20}
              textAnchor="middle"
              fontSize={9}
              fill="var(--muted-foreground)"
              style={{ pointerEvents: "none" }}
            >
              {t("systools.analysis.entryCount", {
                count: listing.totalEntryCount,
              })}
            </text>
          </g>
        </svg>

        {hover ? (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute z-10 w-max max-w-60 rounded-md border px-2.5 py-1.5 text-[11px] shadow-md"
            style={{ left: hover.x + 12, top: hover.y + 12 }}
          >
            {hover.sector.remainder ? (
              <div className="space-y-0.5">
                <p className="font-medium">{t("systools.analysis.other")}</p>
                <p className="text-muted-foreground">
                  {t("systools.analysis.remainderBytes", {
                    bytes: formatBytes(hover.sector.bytes, language),
                  })}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p className="max-w-52 truncate font-medium">{hover.sector.name}</p>
                <p
                  className="text-muted-foreground break-all"
                  title={hover.sector.path ?? undefined}
                >
                  {hover.sector.path}
                </p>
                <p className="tabular-nums">
                  {formatBytes(hover.sector.bytes, language)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatShare(hover.sector.bytes, listing.bytes, language)}
                  </span>
                </p>
              </div>
            )}
          </div>
        ) : null}
      </div>
    </FileEntryContextMenu>
  );
}
