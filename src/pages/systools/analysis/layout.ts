import type {
  AnalysisDirectoryListing,
  AnalysisDirectoryNode,
  AnalysisRemainderSelection,
  DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { entryChartColor, normalizePathKey } from "@/lib/systools/storage";

// ---------------------------------------------------------------------------
// Shared chart data
// ---------------------------------------------------------------------------

export const ANALYSIS_REMAINDER_COLOR = "var(--muted-foreground)";

/** Remainder request for the whole listing, or null when nothing was omitted. */
export function listingRemainderSelection(
  listing: AnalysisDirectoryListing
): AnalysisRemainderSelection | null {
  const visibleBytes = sum(listing.entries.map((entry) => entry.bytes));
  const omittedBytes = Math.max(0, listing.bytes - visibleBytes);
  if (omittedBytes <= 0 && listing.totalEntryCount <= listing.entries.length) return null;
  return {
    parentPath: listing.path,
    bytes: omittedBytes > 0 ? omittedBytes : listing.bytes,
    visiblePaths: listing.entries.map((entry) => entry.path),
  };
}

/** Hard ceiling on rendered treemap tiles; layout is memoized per viewport. */
export const ANALYSIS_TREEMAP_MAX_TILES = 1200;
/** Below this area a tile is folded into the remainder instead of rendered. */
const TREEMAP_MIN_TILE_AREA = 20;
/** Per-directory child cap keeps recursion cost bounded on flat trees. */
const TREEMAP_MAX_GROUP_ENTRIES = 64;
/** Minimum tile size before a directory recurses. */
const TREEMAP_RECURSE_MIN_WIDTH = 116;
const TREEMAP_RECURSE_MIN_HEIGHT = 84;
const TREEMAP_HEADER_HEIGHT = 17;
const TREEMAP_LEAF_HEADER_HEIGHT = 0;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface GroupItem {
  entry: DirectoryEntryInfo | null;
  bytes: number;
  /** Null when the omitted count cannot be known from the projection. */
  entryCount: number | null;
  remainder: AnalysisRemainderSelection | null;
}

function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) total += value;
  return total;
}

function worstAspectRatio(areas: readonly number[], side: number): number {
  if (areas.length === 0 || side <= 0) return Number.POSITIVE_INFINITY;
  const total = sum(areas);
  if (total <= 0) return Number.POSITIVE_INFINITY;
  let smallest = Number.POSITIVE_INFINITY;
  let largest = 0;
  for (const area of areas) {
    if (area < smallest) smallest = area;
    if (area > largest) largest = area;
  }
  const squaredSide = side * side;
  const squaredTotal = total * total;
  return Math.max((squaredSide * largest) / squaredTotal, squaredTotal / (squaredSide * smallest));
}

/** Squarified subdivision of one rectangle; values are relative areas. */
function squarify(areas: readonly number[], rect: Rect): Rect[] {
  const output: Rect[] = [];
  if (rect.width <= 0 || rect.height <= 0) return output;
  let remaining = [...areas];
  let free = rect;

  while (remaining.length > 0) {
    const side = Math.min(free.width, free.height);
    if (side <= 0) break;

    const row: number[] = [remaining[0]];
    let index = 1;
    let currentWorst = worstAspectRatio(row, side);
    while (index < remaining.length) {
      const candidateWorst = worstAspectRatio([...row, remaining[index]], side);
      if (candidateWorst > currentWorst) break;
      row.push(remaining[index]);
      currentWorst = candidateWorst;
      index += 1;
    }

    const rowArea = sum(row);
    if (rowArea <= 0) break;
    const thickness = rowArea / side;
    let offset = 0;

    if (free.width >= free.height) {
      for (const area of row) {
        const height = (area / rowArea) * free.height;
        output.push({ x: free.x, y: free.y + offset, width: thickness, height });
        offset += height;
      }
      free = {
        x: free.x + thickness,
        y: free.y,
        width: Math.max(0, free.width - thickness),
        height: free.height,
      };
    } else {
      for (const area of row) {
        const width = (area / rowArea) * free.width;
        output.push({ x: free.x + offset, y: free.y, width, height: thickness });
        offset += width;
      }
      free = {
        x: free.x,
        y: free.y + thickness,
        width: free.width,
        height: Math.max(0, free.height - thickness),
      };
    }

    remaining = remaining.slice(index);
  }

  return output;
}

// ---------------------------------------------------------------------------
// Treemap
// ---------------------------------------------------------------------------

export interface AnalysisChartTile {
  key: string;
  entry: DirectoryEntryInfo | null;
  name: string;
  path: string | null;
  bytes: number;
  fileCount: number;
  isDirectory: boolean;
  /** One-based level relative to the displayed folder. */
  level: number;
  rect: Rect;
  /** Space reserved for a nested label; zero for leaf tiles. */
  headerHeight: number;
  color: string;
  remainder: AnalysisRemainderSelection | null;
}

export interface TreemapLayoutOptions {
  listing: AnalysisDirectoryListing;
  hierarchy: ReadonlyMap<string, AnalysisDirectoryNode>;
  width: number;
  height: number;
  /** Levels below the displayed folder; 1 renders direct children only. */
  depth: number;
}

/**
 * Lays out the displayed folder as nested tiles. Omitted or culled children
 * collapse into a single remainder tile that links to the native paging list.
 */
export function layoutTreemap({
  listing,
  hierarchy,
  width,
  height,
  depth,
}: TreemapLayoutOptions): AnalysisChartTile[] {
  if (width <= 4 || height <= 4 || listing.bytes <= 0) return [];

  const tiles: AnalysisChartTile[] = [];
  const budget = { remaining: ANALYSIS_TREEMAP_MAX_TILES };
  const scale = (width * height) / Math.max(1, listing.bytes);

  const layoutGroup = (
    entries: readonly DirectoryEntryInfo[],
    totalBytes: number,
    totalEntryCount: number,
    parentPath: string,
    rect: Rect,
    level: number
  ) => {
    if (budget.remaining <= 0 || rect.width < 2 || rect.height < 2 || totalBytes <= 0) return;

    const sorted = entries
      .filter((entry) => entry.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes);
    const visible: DirectoryEntryInfo[] = [];
    let visibleBytes = 0;

    for (const entry of sorted) {
      if (visible.length >= TREEMAP_MAX_GROUP_ENTRIES) break;
      const area = entry.bytes * scale;
      if (visible.length > 0 && area < TREEMAP_MIN_TILE_AREA) break;
      visible.push(entry);
      visibleBytes += entry.bytes;
    }

    const remainderBytes = Math.max(0, totalBytes - visibleBytes);
    const omittedDirect = totalEntryCount > entries.length;

    const items: GroupItem[] = visible.map((entry) => ({
      entry,
      bytes: entry.bytes,
      entryCount: entry.fileCount,
      remainder: null,
    }));
    if (remainderBytes > 0) {
      items.push({
        entry: null,
        bytes: remainderBytes,
        entryCount: null,
        remainder: {
          parentPath,
          bytes: remainderBytes,
          visiblePaths: visible.map((entry) => entry.path),
        },
      });
    } else if (omittedDirect) {
      // The native projection already dropped children without byte detail.
      const visiblePaths = visible.map((entry) => entry.path);
      items.push({
        entry: null,
        bytes: Math.max(1, totalBytes - visibleBytes),
        entryCount: null,
        remainder: { parentPath, bytes: totalBytes, visiblePaths },
      });
    }

    const itemAreas = items.map((item) => item.bytes * scale);
    const rects = squarify(itemAreas, rect);

    items.forEach((item, index) => {
      const tileRect = rects[index];
      if (!tileRect || tileRect.width < 1 || tileRect.height < 1) return;
      if (budget.remaining <= 0) return;
      budget.remaining -= 1;

      const node =
        item.entry?.isDirectory === true
          ? (hierarchy.get(normalizePathKey(item.entry.path)) ?? null)
          : null;
      const canRecurse =
        node !== null &&
        level < depth &&
        tileRect.width >= TREEMAP_RECURSE_MIN_WIDTH &&
        tileRect.height >= TREEMAP_RECURSE_MIN_HEIGHT;
      const headerHeight = canRecurse ? TREEMAP_HEADER_HEIGHT : TREEMAP_LEAF_HEADER_HEIGHT;

      tiles.push({
        key: item.remainder
          ? `remainder:${parentPath}:${level}`
          : (item.entry?.path ?? `entry:${parentPath}:${index}`),
        entry: item.entry,
        name: item.entry?.name ?? "",
        path: item.entry?.path ?? null,
        bytes: item.bytes,
        fileCount: item.entryCount ?? 0,
        isDirectory: item.entry?.isDirectory ?? false,
        level,
        rect: tileRect,
        headerHeight,
        color: item.entry ? entryChartColor(item.entry) : ANALYSIS_REMAINDER_COLOR,
        remainder: item.remainder,
      });

      if (!canRecurse || !node) return;
      const childEntries = [...node.children.map(nodeEntry), ...(node.files ?? [])];
      const childTotal = Math.max(node.bytes, sum(childEntries.map((child) => child.bytes)));
      const childRect: Rect = {
        x: tileRect.x + 1,
        y: tileRect.y + headerHeight,
        width: Math.max(0, tileRect.width - 2),
        height: Math.max(0, tileRect.height - headerHeight - 1),
      };
      layoutGroup(
        childEntries,
        childTotal,
        node.totalEntryCount ?? childEntries.length,
        node.path,
        childRect,
        level + 1
      );
    });
  };

  layoutGroup(
    listing.entries,
    listing.bytes,
    listing.totalEntryCount,
    listing.path,
    { x: 0, y: 0, width, height },
    1
  );

  return tiles;
}

function nodeEntry(node: AnalysisDirectoryNode): DirectoryEntryInfo {
  return {
    sizeStatus: "complete",
    name: node.name,
    path: node.path,
    bytes: node.bytes,
    fileCount: node.fileCount,
    isDirectory: true,
    modifiedAtMs: null,
    contentFingerprint: null,
    deletionProtection: null,
  };
}

// ---------------------------------------------------------------------------
// Sunburst
// ---------------------------------------------------------------------------

export const SUNBURST_INNER_RADIUS = 64;
export const SUNBURST_OUTER_RADIUS = 232;
export const SUNBURST_VIEWBOX = 480;
const TAU = Math.PI * 2;
const SUNBURST_MIN_SECTOR_ANGLE = 0.012;
const SUNBURST_MAX_SECTORS = 900;

export interface AnalysisSunburstSector {
  key: string;
  entry: DirectoryEntryInfo | null;
  name: string;
  path: string | null;
  bytes: number;
  fileCount: number;
  isDirectory: boolean;
  level: number;
  color: string;
  pathData: string;
  label: string | null;
  labelX: number;
  labelY: number;
  labelRotation: number;
  remainder: AnalysisRemainderSelection | null;
}

export interface SunburstLayoutOptions {
  listing: AnalysisDirectoryListing;
  hierarchy: ReadonlyMap<string, AnalysisDirectoryNode>;
  /** Ring count; 1 renders direct children only. */
  depth: number;
  innerRadius?: number;
  outerRadius?: number;
}

function point(radius: number, angle: number): { x: number; y: number } {
  return { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius };
}

function annularSector(
  innerRadius: number,
  outerRadius: number,
  startAngle: number,
  endAngle: number
): string {
  const end = Math.min(endAngle, startAngle + TAU - 0.0001);
  const largeArc = end - startAngle > Math.PI ? 1 : 0;
  const outerStart = point(outerRadius, startAngle);
  const outerEnd = point(outerRadius, end);
  const innerEnd = point(innerRadius, end);
  const innerStart = point(innerRadius, startAngle);
  return [
    `M ${outerStart.x.toFixed(2)} ${outerStart.y.toFixed(2)}`,
    `A ${outerRadius} ${outerRadius} 0 ${largeArc} 1 ${outerEnd.x.toFixed(2)} ${outerEnd.y.toFixed(2)}`,
    `L ${innerEnd.x.toFixed(2)} ${innerEnd.y.toFixed(2)}`,
    `A ${innerRadius} ${innerRadius} 0 ${largeArc} 0 ${innerStart.x.toFixed(2)} ${innerStart.y.toFixed(2)}`,
    "Z",
  ].join(" ");
}

/** Radial layout with one ring per level, starting at twelve o'clock. */
export function layoutSunburst({
  listing,
  hierarchy,
  depth,
  innerRadius = SUNBURST_INNER_RADIUS,
  outerRadius = SUNBURST_OUTER_RADIUS,
}: SunburstLayoutOptions): AnalysisSunburstSector[] {
  const rings = Math.min(6, Math.max(1, Math.trunc(depth)));
  if (listing.bytes <= 0 || outerRadius <= innerRadius) return [];

  const sectors: AnalysisSunburstSector[] = [];
  const ringWidth = (outerRadius - innerRadius) / rings;

  const layoutGroup = (
    entries: readonly DirectoryEntryInfo[],
    totalBytes: number,
    totalEntryCount: number,
    parentPath: string,
    level: number,
    startAngle: number,
    endAngle: number
  ) => {
    if (sectors.length >= SUNBURST_MAX_SECTORS || totalBytes <= 0) return;
    const span = endAngle - startAngle;
    if (span <= 0) return;

    const sorted = entries
      .filter((entry) => entry.bytes > 0)
      .sort((left, right) => right.bytes - left.bytes);
    const visible: DirectoryEntryInfo[] = [];
    let visibleBytes = 0;

    for (const entry of sorted) {
      const angle = (entry.bytes / totalBytes) * span;
      if (visible.length > 0 && angle < SUNBURST_MIN_SECTOR_ANGLE) break;
      visible.push(entry);
      visibleBytes += entry.bytes;
      if (sectors.length + visible.length + 1 >= SUNBURST_MAX_SECTORS) break;
    }

    const remainderBytes = Math.max(0, totalBytes - visibleBytes);
    const omittedDirect = totalEntryCount > entries.length;
    const items: GroupItem[] = visible.map((entry) => ({
      entry,
      bytes: entry.bytes,
      entryCount: entry.fileCount,
      remainder: null,
    }));
    if (remainderBytes > 0) {
      items.push({
        entry: null,
        bytes: remainderBytes,
        entryCount: null,
        remainder: {
          parentPath,
          bytes: remainderBytes,
          visiblePaths: visible.map((entry) => entry.path),
        },
      });
    } else if (omittedDirect) {
      items.push({
        entry: null,
        bytes: Math.max(1, totalBytes - visibleBytes),
        entryCount: null,
        remainder: {
          parentPath,
          bytes: totalBytes,
          visiblePaths: visible.map((entry) => entry.path),
        },
      });
    }

    const totalItemBytes = sum(items.map((item) => item.bytes));
    if (totalItemBytes <= 0) return;

    const ringInner = innerRadius + (level - 1) * ringWidth;
    const ringOuter = ringInner + ringWidth;
    const labelRadius = ringInner + ringWidth / 2;
    let angle = startAngle;

    items.forEach((item, index) => {
      const itemSpan = (item.bytes / totalItemBytes) * span;
      const itemStart = angle;
      const itemEnd = index === items.length - 1 ? endAngle : angle + itemSpan;
      angle = itemEnd;
      if (itemEnd <= itemStart) return;
      if (sectors.length >= SUNBURST_MAX_SECTORS) return;

      const entry = item.entry;
      const mid = (itemStart + itemEnd) / 2;
      const labelLength = Math.floor(((itemEnd - itemStart) * labelRadius) / 6.4);
      const shouldLabel = entry !== null && labelLength >= 4;
      const labelText = shouldLabel
        ? entry.name.length > labelLength
          ? `${entry.name.slice(0, Math.max(1, labelLength - 1))}…`
          : entry.name
        : null;
      const labelPoint = point(labelRadius, mid);
      let rotation = (mid * 180) / Math.PI;
      if (mid > Math.PI / 2 || mid < -Math.PI / 2) rotation += 180;

      sectors.push({
        key: item.remainder
          ? `remainder:${parentPath}:${level}`
          : (entry?.path ?? `entry:${parentPath}:${level}:${index}`),
        entry,
        name: entry?.name ?? "",
        path: entry?.path ?? null,
        bytes: item.bytes,
        fileCount: item.entryCount ?? 0,
        isDirectory: entry?.isDirectory ?? false,
        level,
        color: entry ? entryChartColor(entry) : ANALYSIS_REMAINDER_COLOR,
        pathData: annularSector(ringInner, ringOuter, itemStart, itemEnd),
        label: labelText,
        labelX: labelPoint.x,
        labelY: labelPoint.y,
        labelRotation: rotation,
        remainder: item.remainder,
      });

      if (!entry?.isDirectory || level >= rings) return;
      const node = hierarchy.get(normalizePathKey(entry.path));
      if (!node) return;
      const childEntries = [...node.children.map(nodeEntry), ...(node.files ?? [])];
      layoutGroup(
        childEntries,
        Math.max(node.bytes, sum(childEntries.map((child) => child.bytes))),
        node.totalEntryCount ?? childEntries.length,
        node.path,
        level + 1,
        itemStart,
        itemEnd
      );
    });
  };

  layoutGroup(
    listing.entries,
    listing.bytes,
    listing.totalEntryCount,
    listing.path,
    1,
    -Math.PI / 2,
    -Math.PI / 2 + TAU
  );
  return sectors;
}
