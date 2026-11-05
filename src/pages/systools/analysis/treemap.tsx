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
import { cn } from "@/lib/utils";
import { FileEntryContextMenu } from "../components/file-entry-context-menu";
import { layoutTreemap, type AnalysisChartTile } from "./layout";
import { useElementSize } from "./use-element-size";

type TreemapProps = {
  listing: AnalysisDirectoryListing;
  hierarchy: ReadonlyMap<string, AnalysisDirectoryNode>;
  depth: number;
  selectedPath: string | null;
  disabled: boolean;
  onSelect: (entry: DirectoryEntryInfo) => void;
  onNavigate: (path: string) => void;
  onShowRemainder: (selection: AnalysisRemainderSelection) => void;
  onOpen: (entry: DirectoryEntryInfo) => void;
  onReveal: (entry: DirectoryEntryInfo) => void;
  onDelete: (entry: DirectoryEntryInfo) => void;
};

type HoverState = {
  tile: AnalysisChartTile;
  x: number;
  y: number;
};

type ContextTarget = {
  entry: DirectoryEntryInfo;
  level: number;
};

function truncateLabel(name: string, maxCharacters: number): string {
  if (maxCharacters < 2) return "";
  if (name.length <= maxCharacters) return name;
  return `${name.slice(0, Math.max(1, maxCharacters - 1))}…`;
}

/** Hand-written squarified treemap with drill-down and a hover tooltip. */
export function Treemap({
  listing,
  hierarchy,
  depth,
  selectedPath,
  disabled,
  onSelect,
  onNavigate,
  onShowRemainder,
  onOpen,
  onReveal,
  onDelete,
}: TreemapProps) {
  const { t, language } = useAppTranslation();
  const { ref, size } = useElementSize<HTMLDivElement>();
  const [hover, setHover] = useState<HoverState | null>(null);
  const [context, setContext] = useState<ContextTarget | null>(null);
  const pendingContext = useRef<ContextTarget | null>(null);

  const tiles = useMemo(
    () =>
      layoutTreemap({
        listing,
        hierarchy,
        width: size.width,
        height: size.height,
        depth,
      }),
    [listing, hierarchy, size.width, size.height, depth]
  );

  const showTooltip = (tile: AnalysisChartTile, event: MouseEvent<SVGGElement>) => {
    const bounds = ref.current?.getBoundingClientRect();
    if (!bounds) return;
    setHover({
      tile,
      x: event.clientX - bounds.left,
      y: event.clientY - bounds.top,
    });
  };

  const activateTile = (tile: AnalysisChartTile) => {
    if (disabled) return;
    if (tile.remainder) {
      onShowRemainder(tile.remainder);
      return;
    }
    if (!tile.entry) return;
    if (tile.entry.isDirectory) onNavigate(tile.entry.path);
    else onSelect(tile.entry);
  };

  const markTileContext = (tile: AnalysisChartTile) => {
    pendingContext.current =
      tile.entry && !disabled ? { entry: tile.entry, level: tile.level } : null;
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
        ref={ref}
        className="relative h-full w-full overflow-hidden"
        data-slot="analysis-treemap"
      >
        {size.width > 8 && size.height > 8 ? (
          <svg
            width={size.width}
            height={size.height}
            viewBox={`0 0 ${size.width} ${size.height}`}
            role="img"
            aria-label={t("systools.analysis.treemapLabel", { path: listing.path })}
          >
            {tiles.map((tile) => {
              const selected = Boolean(
                tile.entry && selectedPath && samePath(tile.entry.path, selectedPath)
              );
              const isHovered = hover?.tile.key === tile.key;
              const width = Math.max(0, tile.rect.width - 2);
              const height = Math.max(0, tile.rect.height - 2);
              const interactive = Boolean(tile.entry || tile.remainder) && !disabled;
              const headerText =
                tile.headerHeight > 0 && width > 26
                  ? truncateLabel(tile.name, Math.floor((width - 8) / 6.2))
                  : null;
              const leafText =
                tile.headerHeight === 0 && width > 52 && height > 20 && tile.name
                  ? truncateLabel(tile.name, Math.floor((width - 8) / 6.0))
                  : null;
              const remainderLabel =
                tile.remainder && width > 44 ? t("systools.analysis.other") : null;

              return (
                <g
                  key={tile.key}
                  transform={`translate(${tile.rect.x} ${tile.rect.y})`}
                  onClick={() => activateTile(tile)}
                  onContextMenu={() => markTileContext(tile)}
                  onMouseEnter={(event) => showTooltip(tile, event)}
                  onMouseLeave={() => setHover(null)}
                  className={interactive ? "cursor-pointer" : undefined}
                >
                  <rect
                    x={1}
                    y={1}
                    width={width}
                    height={height}
                    rx={3}
                    fill={tile.color}
                    fillOpacity={selected ? 0.62 : isHovered ? 0.46 : 0.26}
                    stroke={selected ? tile.color : "var(--border)"}
                    strokeOpacity={selected ? 0.9 : 0.4}
                    strokeWidth={selected ? 1.6 : 0.75}
                    strokeDasharray={tile.remainder ? "4 3" : undefined}
                  />

                  {headerText ? (
                    <text
                      x={5}
                      y={tile.headerHeight - 5}
                      fontSize={10}
                      fontWeight={600}
                      fill="var(--foreground)"
                      fillOpacity={0.92}
                      style={{ pointerEvents: "none" }}
                    >
                      {headerText}
                    </text>
                  ) : null}

                  {headerText && width > 132 ? (
                    <text
                      x={width - 4}
                      y={tile.headerHeight - 5}
                      fontSize={9}
                      textAnchor="end"
                      fill="var(--muted-foreground)"
                      style={{ pointerEvents: "none" }}
                    >
                      {formatShare(tile.bytes, listing.bytes, language)}
                    </text>
                  ) : null}

                  {leafText ? (
                    <text
                      x={width / 2}
                      y={height / 2}
                      fontSize={10}
                      fontWeight={500}
                      textAnchor="middle"
                      dominantBaseline="middle"
                      fill="var(--foreground)"
                      fillOpacity={0.9}
                      style={{ pointerEvents: "none" }}
                    >
                      {leafText}
                    </text>
                  ) : null}

                  {remainderLabel ? (
                    <>
                      <text
                        x={width / 2}
                        y={height / 2 - (height > 34 ? 5 : 0)}
                        fontSize={10}
                        fontWeight={500}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        fill="var(--muted-foreground)"
                        style={{ pointerEvents: "none" }}
                      >
                        {remainderLabel}
                      </text>
                      {height > 34 ? (
                        <text
                          x={width / 2}
                          y={height / 2 + 8}
                          fontSize={9}
                          textAnchor="middle"
                          dominantBaseline="middle"
                          fill="var(--muted-foreground)"
                          fillOpacity={0.8}
                          style={{ pointerEvents: "none" }}
                        >
                          {formatBytes(tile.bytes, language)}
                        </text>
                      ) : null}
                    </>
                  ) : null}
                </g>
              );
            })}
          </svg>
        ) : null}

        {hover ? (
          <div
            className="bg-popover text-popover-foreground pointer-events-none absolute z-10 w-max max-w-60 rounded-md border px-2.5 py-1.5 text-[11px] shadow-md"
            style={{
              left: Math.max(4, Math.min(hover.x + 12, size.width - 232)),
              top: Math.max(4, Math.min(hover.y + 12, size.height - 104)),
            }}
          >
            {hover.tile.remainder ? (
              <div className="space-y-0.5">
                <p className="font-medium">{t("systools.analysis.other")}</p>
                <p className="text-muted-foreground">
                  {t("systools.analysis.remainderBytes", {
                    bytes: formatBytes(hover.tile.bytes, language),
                  })}
                </p>
              </div>
            ) : (
              <div className="space-y-0.5">
                <p className="max-w-52 truncate font-medium">{hover.tile.name}</p>
                <p className="text-muted-foreground break-all" title={hover.tile.path ?? undefined}>
                  {hover.tile.path}
                </p>
                <p className={cn("tabular-nums")}>
                  {formatBytes(hover.tile.bytes, language)}
                  <span className="text-muted-foreground">
                    {" · "}
                    {formatShare(hover.tile.bytes, listing.bytes, language)}
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
