import { memo, type KeyboardEvent, type MouseEvent } from "react";
import { Tag } from "lucide-react";
import { useAppTranslation } from "@/hooks/use-app-translation";
import type { CommitInfo, GraphRow, RefInfo } from "@/lib/git-core";
import { groupRefs, laneColor, type RefGroup } from "@/features/git/graph/graph-row";
import { formatDate, timeAgo } from "@/features/git/utils";
import { cn } from "@/lib/utils";

/** Openidea's log row: 26px high, 14px lanes, thin lines, inline ref labels. */
export const LOG_ROW_HEIGHT = 26;
const LANE_WIDTH = 14;
const LANE_WIDTH_MIN = 12;
const GUTTER_MAX_WIDTH = 190;
const AUTHOR_COL_WIDTH = 112;
const DATE_COL_WIDTH = 72;
const CY = LOG_ROW_HEIGHT / 2;

export function logLaneWidthFor(maxLane: number): number {
  const fit = Math.floor(GUTTER_MAX_WIDTH / (maxLane + 1));
  return Math.max(LANE_WIDTH_MIN, Math.min(LANE_WIDTH, fit));
}

export function logGutterWidthFor(maxLane: number, laneWidth: number): number {
  return (maxLane + 1) * laneWidth;
}

const laneX = (lane: number, laneWidth: number) => laneWidth / 2 + lane * laneWidth;

/** A straight line on one lane, a cubic with both control points at the midpoint otherwise. */
function seg(fromX: number, fromY: number, toX: number, toY: number): string {
  if (fromX === toX) return `M${fromX} ${fromY}L${toX} ${toY}`;
  const mid = (fromY + toY) / 2;
  return `M${fromX} ${fromY}C${fromX} ${mid} ${toX} ${mid} ${toX} ${toY}`;
}

interface Segment {
  from: number;
  to: number;
  color: number;
}

/**
 * The graph cell, drawn the way openidea draws it: each row is two halves —
 * what enters from the row above, and what leaves towards the next one.
 */
function GraphCell({
  row,
  laneWidth,
  width,
  head,
}: {
  row: GraphRow;
  laneWidth: number;
  width: number;
  head: boolean;
}) {
  const { node, passing } = row;
  const up: Segment[] = passing.map((lane) => ({
    from: lane.lane,
    to: lane.lane,
    color: lane.color,
  }));
  for (const lane of node.closing) up.push({ from: lane.lane, to: node.lane, color: lane.color });
  if (node.hasIncoming) up.push({ from: node.lane, to: node.lane, color: node.color });

  const down: Segment[] = passing.map((lane) => ({
    from: lane.lane,
    to: lane.lane,
    color: lane.color,
  }));
  if (node.continues) down.push({ from: node.lane, to: node.lane, color: node.color });
  for (const lane of node.merges) down.push({ from: node.lane, to: lane.lane, color: lane.color });
  const x = (lane: number) => laneX(lane, laneWidth);
  const nx = x(node.lane);
  return (
    <svg
      className="shrink-0"
      width={width}
      height={LOG_ROW_HEIGHT}
      style={{ fill: "none", strokeWidth: 1.6 }}
      aria-hidden
    >
      {up.map((segment, index) => (
        <path
          key={`u${index}`}
          d={seg(x(segment.from), 0, x(segment.to), CY)}
          stroke={laneColor(segment.color)}
          strokeLinecap="square"
        />
      ))}
      {down.map((segment, index) => (
        <path
          key={`d${index}`}
          d={seg(x(segment.from), CY, x(segment.to), LOG_ROW_HEIGHT)}
          stroke={laneColor(segment.color)}
          strokeLinecap="square"
        />
      ))}
      {head ? (
        <>
          <circle
            cx={nx}
            cy={CY}
            r={5}
            fill="var(--log-row-bg, var(--background))"
            stroke={laneColor(node.color)}
            strokeWidth={1.5}
          />
          <circle cx={nx} cy={CY} r={2.5} fill={laneColor(node.color)} />
        </>
      ) : (
        <circle cx={nx} cy={CY} r={3.8} fill={laneColor(node.color)} />
      )}
    </svg>
  );
}

/** Head, local branch, remote branch and tag each read in their own colour. */
const REF_CLASS = {
  head: "text-[hsl(var(--graph-6))]",
  local: "text-success",
  remote: "text-info",
  tag: "text-faint",
  stash: "text-muted-foreground",
} as const;

type RefTone = keyof typeof REF_CLASS;

function refTone(group: RefGroup, head: boolean): RefTone {
  if (group.detachedHead) return "head";
  if (group.local) return head ? "head" : "local";
  if (group.remote) return "remote";
  if (group.stash) return "stash";
  return "tag";
}

/** Refs as plain coloured labels — the tags the log is filtered by, not chips to click. */
function RefLabels({
  refs,
  isHead,
  headBranch,
}: {
  refs: readonly RefInfo[];
  isHead: boolean;
  headBranch: string | null;
}) {
  const groups = groupRefs([...refs], headBranch);
  if (groups.length === 0) return null;
  let marked = false;
  const heads = groups.map((group) => {
    const head =
      group.detachedHead ||
      (isHead && group.local && (headBranch ? group.label === headBranch : !marked));
    if (head) marked = true;
    return head;
  });
  return (
    <span className="flex max-w-[50%] min-w-0 shrink items-center gap-2 overflow-hidden">
      {groups.map((group, index) => (
        <span
          key={group.primary.name}
          className={cn("flex min-w-0 items-center gap-1", REF_CLASS[refTone(group, heads[index])])}
          title={group.label}
        >
          <Tag className="size-2.5 shrink-0" />
          <span className="max-w-[11rem] truncate">{group.label}</span>
        </span>
      ))}
    </span>
  );
}

export const LogRow = memo(function LogRow({
  commit,
  row,
  gutterWidth,
  laneWidth,
  selected,
  headBranch,
  onSelect,
  onContextMenu,
  onKeyDown,
}: {
  commit: CommitInfo;
  row: GraphRow;
  gutterWidth: number;
  laneWidth: number;
  selected: boolean;
  headBranch: string | null;
  onSelect: (oid: string, event: MouseEvent<HTMLDivElement>) => void;
  onContextMenu: (commit: CommitInfo, event: MouseEvent<HTMLDivElement>) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, commit: CommitInfo) => void;
}) {
  const { t } = useAppTranslation();
  const merge = commit.parents.length > 1;
  return (
    <div
      role="row"
      aria-selected={selected}
      tabIndex={0}
      data-oid={commit.oid}
      onClick={(event) => onSelect(commit.oid, event)}
      onContextMenu={(event) => onContextMenu(commit, event)}
      onKeyDown={(event) => onKeyDown(event, commit)}
      className={cn(
        "flex cursor-pointer items-center gap-1.5 px-2 text-xs whitespace-nowrap select-none",
        "bg-background outline-none [--log-row-bg:var(--background)]",
        "focus-visible:ring-ring focus-visible:ring-1 focus-visible:ring-inset",
        selected
          ? "bg-primary/10 [--log-row-bg:color-mix(in_oklab,var(--primary)_10%,var(--background))]"
          : "hover:bg-muted hover:[--log-row-bg:var(--muted)]"
      )}
      style={{ height: LOG_ROW_HEIGHT }}
    >
      <GraphCell row={row} laneWidth={laneWidth} width={gutterWidth} head={commit.isHead} />
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          commit.isHead && "font-semibold",
          merge && !selected && "text-muted-foreground"
        )}
        title={commit.summary}
      >
        {commit.summary || <span className="text-faint">{t("gitRepo.graph.row.noMessage")}</span>}
      </span>
      <RefLabels refs={commit.refs} isHead={commit.isHead} headBranch={headBranch} />
      <span
        className="text-faint hidden shrink-0 truncate text-[11px] @min-[30rem]:block"
        style={{ width: AUTHOR_COL_WIDTH }}
        title={`${commit.author.name} <${commit.author.email}>`}
      >
        {commit.author.name}
      </span>
      <span
        className="text-faint hidden shrink-0 text-[11px] @min-[22rem]:block"
        style={{ width: DATE_COL_WIDTH }}
        title={formatDate(commit.author.time)}
      >
        {timeAgo(commit.author.time)}
      </span>
    </div>
  );
});
