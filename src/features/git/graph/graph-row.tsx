import { memo, useState } from "react";
import type { CommitInfo, GraphRow as GraphRowData, RefInfo } from "@/lib/git-core";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import i18n from "@/i18n";
import { Archive, Check, Cloud, GitMerge, Monitor, Tag as TagIcon, FolderTree } from "lucide-react";
import { AuthorAvatar } from "@/features/git/inspector/author-avatar";
import { toast } from "sonner";
import { formatDate, timeAgo } from "@/features/git/utils";
import { DEFAULT_GRAPH_COLUMNS, type GraphColumns } from "@/features/git/ui-store";

export const ROW_HEIGHT = 32;
export const REF_COL_WIDTH = 150;
export const GUTTER_GAP = 10;
export const AUTHOR_COL_WIDTH = 112;
const OVERFLOW_BADGE_WIDTH = 34;
const REF_STACK_SIDE_OFFSET = -ROW_HEIGHT;
const REF_STACK_ALIGN_OFFSET = -5;
const CHAR_WIDTH = 6.4;
const CHIP_PADDING = 18;
const CHIP_ICON = 14;
export const LANE_WIDTH = 20;
export const LANE_WIDTH_MIN = 11;
export const GUTTER_MAX_WIDTH = 190;
export const GUTTER_BASE = 18;
const NODE_RADIUS = 4;
const AVATAR_SIZE = 20;
const TAIL_HEIGHT = 22;
const NODE_RING = 2;
const NODE_HALO = 1.5;

export function laneColor(color: number): string {
  return `hsl(var(--graph-${color % 10}))`;
}

export const laneX = (lane: number, laneWidth: number = LANE_WIDTH) =>
  AVATAR_SIZE / 2 + NODE_RING + NODE_HALO + 1 + lane * laneWidth;

export function GraphTailDefs() {
  return (
    <svg width={0} height={0} className="absolute" aria-hidden>
      <defs>
        {Array.from({ length: 10 }, (_, i) => (
          <linearGradient key={i} id={`graph-tail-${i}`} x1="0" x2="1" y1="0" y2="0">
            <stop
              offset="0"
              stopColor={laneColor(i)}
              style={{ stopOpacity: "var(--graph-tail-start)" }}
            />
            <stop
              offset="0.55"
              stopColor={laneColor(i)}
              style={{ stopOpacity: "var(--graph-tail-mid)" }}
            />
            <stop
              offset="1"
              stopColor={laneColor(i)}
              style={{ stopOpacity: "var(--graph-tail-end)" }}
            />
          </linearGradient>
        ))}
        {Array.from({ length: 10 }, (_, i) => (
          <linearGradient key={`edge-${i}`} id={`graph-tail-edge-${i}`} x1="0" x2="1" y1="0" y2="0">
            <stop offset="0" stopColor={laneColor(i)} stopOpacity={0} />
            <stop offset="0.6" stopColor={laneColor(i)} stopOpacity={0} />
            <stop
              offset="1"
              stopColor={laneColor(i)}
              style={{ stopOpacity: "var(--graph-tail-edge)" }}
            />
          </linearGradient>
        ))}
      </defs>
    </svg>
  );
}

export function laneWidthFor(maxLane: number): number {
  const fit = Math.floor((GUTTER_MAX_WIDTH - GUTTER_BASE) / (maxLane + 1));
  return Math.max(LANE_WIDTH_MIN, Math.min(LANE_WIDTH, fit));
}

export function gutterWidthFor(maxLane: number, laneWidth: number): number {
  return GUTTER_BASE + (maxLane + 1) * laneWidth;
}
const CY = ROW_HEIGHT / 2;

function StashNode({ color }: { color?: number }) {
  const { t } = useAppTranslation();
  return (
    <span
      role="img"
      aria-label={t("gitRepo.graph.row.stash")}
      className="flex items-center justify-center"
      style={{
        width: AVATAR_SIZE,
        height: AVATAR_SIZE,
        color: color === undefined ? "hsl(var(--muted-foreground))" : laneColor(color),
      }}
    >
      <Archive className="size-3" />
    </span>
  );
}

function GraphGutter({
  row,
  width,
  laneWidth,
  author,
  hasRefs,
  isStash,
  showTail,
  showAvatar,
}: {
  row: GraphRowData;
  width: number;
  laneWidth: number;
  author: CommitInfo["author"];
  hasRefs: boolean;
  isStash: boolean;
  showTail: boolean;
  showAvatar: boolean;
}) {
  const { t } = useAppTranslation();
  const { node, passing } = row;
  const x = (lane: number) => laneX(lane, laneWidth);
  const nx = Math.min(x(node.lane), width - AVATAR_SIZE / 2 - NODE_RING - NODE_HALO - 1);
  const total = width + GUTTER_GAP;
  return (
    <div className="relative shrink-0 overflow-hidden" style={{ width: total, height: ROW_HEIGHT }}>
      <svg width={total} height={ROW_HEIGHT} aria-hidden>
        {showTail && (
          <>
            <rect
              data-graph-tail
              x={nx}
              y={CY - TAIL_HEIGHT / 2}
              width={Math.max(0, total - nx - 1)}
              height={TAIL_HEIGHT}
              rx={TAIL_HEIGHT / 2}
              fill={`url(#graph-tail-${node.color % 10})`}
            />
            <rect
              x={nx + 0.5}
              y={CY - TAIL_HEIGHT / 2 + 0.5}
              width={Math.max(0, total - nx - 2)}
              height={TAIL_HEIGHT - 1}
              rx={(TAIL_HEIGHT - 1) / 2}
              fill="none"
              stroke={`url(#graph-tail-edge-${node.color % 10})`}
              strokeWidth={1}
            />
          </>
        )}
        {hasRefs && (
          <line
            x1={0}
            y1={CY}
            x2={nx}
            y2={CY}
            stroke={laneColor(node.color)}
            strokeOpacity={0.45}
            strokeWidth={1}
          />
        )}
        {passing.map((p) => (
          <line
            key={`p${p.lane}`}
            x1={x(p.lane)}
            y1={0}
            x2={x(p.lane)}
            y2={ROW_HEIGHT}
            stroke={laneColor(p.color)}
            strokeWidth={2}
          />
        ))}
        {node.closing.map((c) => (
          <path
            key={`c${c.lane}`}
            d={`M ${x(c.lane)} 0 C ${x(c.lane)} ${CY}, ${nx} ${CY * 0.4}, ${nx} ${CY}`}
            stroke={laneColor(c.color)}
            strokeWidth={2}
            fill="none"
          />
        ))}
        {node.merges.map((m) => (
          <path
            key={`m${m.lane}`}
            d={`M ${nx} ${CY} C ${x(m.lane)} ${CY * 1.6}, ${x(m.lane)} ${CY}, ${x(m.lane)} ${ROW_HEIGHT}`}
            stroke={laneColor(m.color)}
            strokeWidth={2}
            fill="none"
          />
        ))}
        {node.hasIncoming && (
          <line x1={nx} y1={0} x2={nx} y2={CY} stroke={laneColor(node.color)} strokeWidth={2} />
        )}
        {node.continues && (
          <line
            x1={nx}
            y1={CY}
            x2={nx}
            y2={ROW_HEIGHT}
            stroke={laneColor(node.color)}
            strokeWidth={2}
          />
        )}
        {node.isMerge && (
          <circle
            cx={nx}
            cy={CY}
            r={NODE_RADIUS - 0.5}
            fill="hsl(var(--card))"
            stroke={laneColor(node.color)}
            strokeWidth={2}
          />
        )}
        {!node.isMerge && !showAvatar && !isStash && (
          <circle
            cx={nx}
            cy={CY}
            r={NODE_RADIUS + 0.5}
            fill={laneColor(node.color)}
            stroke="hsl(var(--background))"
            strokeWidth={NODE_RING}
          />
        )}
      </svg>
      {!node.isMerge && (showAvatar || isStash) && (
        <span
          className="absolute overflow-hidden rounded-full"
          title={isStash ? t("gitRepo.graph.row.stash") : author.name}
          style={{
            left: nx - AVATAR_SIZE / 2,
            top: CY - AVATAR_SIZE / 2,
            width: AVATAR_SIZE,
            height: AVATAR_SIZE,
            boxShadow: `0 0 0 ${NODE_HALO}px hsl(var(--background)), 0 0 0 ${NODE_HALO + NODE_RING}px ${laneColor(node.color)}`,
            background: "hsl(var(--card))",
            outline: isStash ? `1.5px dashed ${laneColor(node.color)}` : undefined,
            outlineOffset: isStash ? -1.5 : undefined,
          }}
        >
          {isStash ? (
            <StashNode color={node.color} />
          ) : (
            <AuthorAvatar name={author.name} email={author.email} size={AVATAR_SIZE} />
          )}
        </span>
      )}
    </div>
  );
}

export interface RefGroup {
  label: string;
  primary: RefInfo;
  local: boolean;
  remote: boolean;
  tag: boolean;
  detachedHead: boolean;
  stash?: boolean;
}

const groupRank = (g: RefGroup, headBranch: string | null) =>
  g.detachedHead ? 0 : g.local ? (g.label === headBranch ? 1 : 2) : g.remote ? 3 : g.stash ? 5 : 4;

export function groupRefs(refs: RefInfo[], headBranch: string | null = null): RefGroup[] {
  const out: RefGroup[] = [];
  const index = new Map<string, number>();
  const hasLocal = refs.some((r) => r.kind === "localBranch");
  for (const ref of refs) {
    if (ref.kind === "head") {
      if (!hasLocal) {
        out.push({
          label: i18n.t("gitRepo.graph.row.head"),
          primary: ref,
          local: false,
          remote: false,
          tag: false,
          detachedHead: true,
        });
      }
    } else if (ref.kind === "localBranch") {
      const i = index.get(ref.shorthand);
      if (i !== undefined) {
        out[i].local = true;
        out[i].primary = ref;
      } else {
        index.set(ref.shorthand, out.length);
        out.push({
          label: ref.shorthand,
          primary: ref,
          local: true,
          remote: false,
          tag: false,
          detachedHead: false,
        });
      }
    } else if (ref.kind === "remoteBranch") {
      const base = ref.shorthand.split("/").slice(1).join("/") || ref.shorthand;
      const i = index.get(base);
      if (i !== undefined) {
        out[i].remote = true;
      } else {
        index.set(base, out.length);
        out.push({
          label: base,
          primary: ref,
          local: false,
          remote: true,
          tag: false,
          detachedHead: false,
        });
      }
    } else if (ref.kind === "stash") {
      out.push({
        label: ref.shorthand,
        primary: ref,
        local: false,
        remote: false,
        tag: false,
        detachedHead: false,
        stash: true,
      });
    } else {
      out.push({
        label: ref.shorthand,
        primary: ref,
        local: false,
        remote: false,
        tag: true,
        detachedHead: false,
      });
    }
  }
  return out.sort((a, b) => groupRank(a, headBranch) - groupRank(b, headBranch));
}

export function estimateChipWidth(group: RefGroup, head: boolean): number {
  const icons =
    (group.local ? 1 : 0) +
    (group.remote ? 1 : 0) +
    (group.tag ? 1 : 0) +
    (group.stash ? 1 : 0) +
    (head || group.detachedHead ? 1 : 0);
  return Math.round(group.label.length * CHAR_WIDTH + CHIP_PADDING + icons * CHIP_ICON);
}

function fitGroups(groups: RefGroup[], available: number, isHead: boolean): RefGroup[] {
  if (groups.length <= 1) return groups;
  const shown: RefGroup[] = [];
  let used = 0;
  for (let i = 0; i < groups.length; i += 1) {
    const width = estimateChipWidth(groups[i], isHead && shown.length === 0 && groups[i].local);
    const remainingAfter = groups.length - (i + 1);
    const reserve = remainingAfter > 0 ? OVERFLOW_BADGE_WIDTH : 0;
    if (shown.length > 0 && used + 4 + width + reserve > available) break;
    shown.push(groups[i]);
    used += (shown.length > 1 ? 4 : 0) + width;
  }
  return shown;
}

const CHIP_TONE: Record<string, string> = {
  neutral: "border-border bg-muted text-muted-foreground",
  primary: "",
  danger: "",
  success: "border-success/40 bg-success/15 text-success",
  info: "border-info/40 bg-info/15 text-info",
};

function RefChip({
  group,
  head,
  worktree,
  separated,
  interactive,
  onCheckoutRef,
  onRefMenu,
  onResetToRemote,
}: {
  group: RefGroup;
  head: boolean;
  worktree?: string;
  separated: boolean;
  interactive: boolean;
  onCheckoutRef: (ref: RefInfo) => void;
  onRefMenu: (event: React.MouseEvent, ref: RefInfo) => void;
  onResetToRemote: (ref: RefInfo) => void;
}) {
  const { t } = useAppTranslation();
  const tone = group.stash
    ? "neutral"
    : group.tag || group.detachedHead
      ? "primary"
      : group.local
        ? "success"
        : "info";
  const variant = tone === "primary" ? "default" : "outline";
  const title = !interactive
    ? group.label
    : group.stash
      ? t("gitRepo.graph.row.stashTooltip", { label: group.label })
      : group.tag || group.detachedHead
        ? group.detachedHead
          ? t("gitRepo.graph.row.headDetached")
          : group.label
        : separated
          ? `${group.primary.shorthand} — ${t("gitRepo.graph.row.tooltip.reset", { label: group.label })}, ${t("gitRepo.graph.row.tooltip.actions")}`
          : `${group.label}${group.local ? t("gitRepo.graph.row.tooltip.local") : ""}${group.remote ? t("gitRepo.graph.row.tooltip.remote") : ""}${worktree ? t("gitRepo.graph.row.tooltip.worktree", { name: worktree }) : ""} — ${
              worktree
                ? t("gitRepo.graph.row.tooltip.checkoutWorktree")
                : group.local
                  ? t("gitRepo.graph.row.tooltip.checkout")
                  : t("gitRepo.graph.row.tooltip.checkoutRemote", { label: group.label })
            }, ${t("gitRepo.graph.row.tooltip.actions")}`;
  return (
    <Badge
      variant={variant}
      className={cn(
        "min-w-0 shrink whitespace-nowrap",
        CHIP_TONE[tone],
        interactive &&
          !group.tag &&
          !group.stash &&
          "hover:!bg-accent hover:shadow-soft cursor-pointer hover:z-20 hover:shrink-0",
        interactive && group.stash && "hover:!bg-accent max-w-[11rem] cursor-pointer border-dashed",
        !interactive && group.stash && "max-w-[11rem] border-dashed",
        head && "border-success bg-success text-background shadow-soft hover:!bg-success"
      )}
      title={title}
      onDoubleClick={
        interactive
          ? (e) => {
              if (group.tag || group.detachedHead || group.stash) return;
              e.stopPropagation();
              if (separated) onResetToRemote(group.primary);
              else onCheckoutRef(group.primary);
            }
          : undefined
      }
      onContextMenu={
        interactive
          ? (e) => {
              if (group.detachedHead) return;
              e.preventDefault();
              e.stopPropagation();
              onRefMenu(e, group.primary);
            }
          : undefined
      }
    >
      {head && <Check className="size-2.5 shrink-0" />}
      {group.tag && <TagIcon className="size-2.5 shrink-0" />}
      {group.stash && <Archive className="size-2.5 shrink-0" />}
      <span className="truncate">{group.label}</span>
      {group.local && !worktree && <Monitor className="size-2.5 shrink-0" />}
      {worktree && <FolderTree className="size-2.5 shrink-0" />}
      {group.remote && <Cloud className="size-2.5 shrink-0" />}
    </Badge>
  );
}

const stopRowGestures = {
  onClick: (e: React.MouseEvent) => e.stopPropagation(),
  onDoubleClick: (e: React.MouseEvent) => e.stopPropagation(),
  onContextMenu: (e: React.MouseEvent) => e.stopPropagation(),
};

function RefCell({
  refs,
  isHead,
  color,
  width,
  headBranch = null,
  worktrees,
  resettableBranches,
  interactive,
  onCheckoutRef,
  onRefMenu,
  onResetToRemote,
}: {
  refs: RefInfo[];
  isHead: boolean;
  headBranch?: string | null;
  color: number;
  width: number;
  worktrees?: ReadonlyMap<string, string>;
  resettableBranches?: ReadonlySet<string>;
  interactive: boolean;
  onCheckoutRef: (ref: RefInfo) => void;
  onRefMenu: (event: React.MouseEvent, ref: RefInfo) => void;
  onResetToRemote: (ref: RefInfo) => void;
}) {
  const { t } = useAppTranslation();
  const [more, setMore] = useState(false);
  const groups = groupRefs(refs, headBranch);
  const shown = fitGroups(groups, width - 8, isHead);
  const hidden = groups.slice(shown.length);
  const headOf = (list: RefGroup[]) => {
    let marked = false;
    return list.map((group) => {
      const head =
        group.detachedHead ||
        (isHead && group.local && (headBranch ? group.label === headBranch : !marked));
      if (head) marked = true;
      return head;
    });
  };
  const chip = (group: RefGroup, head: boolean) => (
    <RefChip
      key={group.primary.name}
      group={group}
      head={head}
      worktree={group.local ? worktrees?.get(group.label) : undefined}
      separated={group.remote && !group.local && (resettableBranches?.has(group.label) ?? false)}
      interactive={interactive}
      onCheckoutRef={onCheckoutRef}
      onRefMenu={onRefMenu}
      onResetToRemote={onResetToRemote}
    />
  );
  const shownHeads = headOf(shown);
  const cell = (
    <span className="-mr-2 flex h-full shrink-0 items-center gap-1" style={{ width }}>
      {shown.map((group, i) => chip(group, shownHeads[i]))}
      {hidden.length > 0 && (
        <Badge
          role={interactive ? "button" : undefined}
          aria-label={
            interactive ? t("gitRepo.graph.row.moreRefs", { count: hidden.length }) : undefined
          }
          aria-expanded={interactive ? more : undefined}
          variant="outline"
          className={cn("shrink-0", interactive && "hover:!bg-accent cursor-pointer")}
          title={hidden.map((g) => g.label).join(", ")}
          onClick={
            interactive
              ? (e) => {
                  e.stopPropagation();
                  setMore(true);
                }
              : undefined
          }
          onDoubleClick={interactive ? (e) => e.stopPropagation() : undefined}
          onContextMenu={
            interactive
              ? (e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  setMore(true);
                }
              : undefined
          }
        >
          +{hidden.length}
        </Badge>
      )}
      {groups.length > 0 && (
        <span
          className="h-px min-w-1 flex-1"
          style={{ background: laneColor(color), opacity: 0.45 }}
        />
      )}
    </span>
  );
  if (hidden.length === 0 || !interactive) return cell;
  const allHeads = headOf(groups);
  return (
    <Popover open={more} onOpenChange={setMore}>
      <PopoverTrigger asChild>{cell}</PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={REF_STACK_SIDE_OFFSET}
        alignOffset={REF_STACK_ALIGN_OFFSET}
        data-more-refs
        className="flex w-auto flex-col items-start gap-1 p-1"
        {...stopRowGestures}
      >
        {groups.map((group, i) => chip(group, allHeads[i]))}
      </PopoverContent>
    </Popover>
  );
}

interface Props {
  commit: CommitInfo;
  row: GraphRowData;
  gutterWidth: number;
  selected: boolean;
  laneWidth?: number;
  columns?: GraphColumns;
  showTail?: boolean;
  /** Draw the author's avatar at the node; off shows a plain lane dot instead. */
  showAvatar?: boolean;
  /** Off means the refs read as labels: no checkout, no menu, no overflow. */
  interactive?: boolean;
  headBranch?: string | null;
  worktrees?: ReadonlyMap<string, string>;
  resettableBranches?: ReadonlySet<string>;
  onSelect: (oid: string, event: React.MouseEvent) => void;
  onContextMenu: (event: React.MouseEvent, commit: CommitInfo) => void;
  onCheckoutRef: (ref: RefInfo) => void;
  onRefMenu: (event: React.MouseEvent, ref: RefInfo, commit: CommitInfo) => void;
  onResetToRemote: (ref: RefInfo, commit: CommitInfo) => void;
}

export const CommitRow = memo(function CommitRow({
  commit,
  row,
  gutterWidth,
  selected,
  laneWidth = LANE_WIDTH,
  columns = DEFAULT_GRAPH_COLUMNS,
  showTail = true,
  showAvatar = true,
  interactive = true,
  headBranch = null,
  worktrees,
  resettableBranches,
  onSelect,
  onContextMenu,
  onCheckoutRef,
  onRefMenu,
  onResetToRemote,
}: Props) {
  const { t } = useAppTranslation();
  const isMergeCommit = commit.parents.length > 1;
  const isStash = commit.refs.some((ref) => ref.kind === "stash");
  const refCell = columns.refs ? (
    <RefCell
      refs={commit.refs}
      isHead={commit.isHead}
      headBranch={headBranch}
      color={row.node.color}
      width={REF_COL_WIDTH}
      worktrees={worktrees}
      resettableBranches={resettableBranches}
      interactive={interactive}
      onCheckoutRef={onCheckoutRef}
      onRefMenu={(e, ref) => onRefMenu(e, ref, commit)}
      onResetToRemote={(ref) => onResetToRemote(ref, commit)}
    />
  ) : null;
  return (
    <div
      role="row"
      aria-selected={selected}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2 pr-4 text-sm transition-colors select-none",
        columns.refs ? "pl-1" : "pl-4",
        selected ? "bg-primary/10" : "hover:bg-muted",
        commit.isHead && "font-medium"
      )}
      onClick={(e) => onSelect(commit.oid, e)}
      onContextMenu={(e) => onContextMenu(e, commit)}
    >
      {refCell}
      <GraphGutter
        row={row}
        width={gutterWidth}
        laneWidth={laneWidth}
        author={commit.author}
        hasRefs={columns.refs && commit.refs.length > 0}
        isStash={isStash}
        showTail={showTail}
        showAvatar={showAvatar}
      />
      {commit.isHead && commit.refs.length === 0 && (
        <Badge variant="default">{t("gitRepo.graph.row.head")}</Badge>
      )}
      {columns.message ? (
        <>
          {isMergeCommit && <GitMerge className="text-faint size-3.5 shrink-0" />}
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              isMergeCommit && !selected && "text-muted-foreground"
            )}
          >
            {commit.summary || (
              <span className="text-faint">{t("gitRepo.graph.row.noMessage")}</span>
            )}
          </span>
        </>
      ) : null}
      {columns.author && (
        <span
          className="text-muted-foreground shrink-0 truncate text-[11px]"
          style={{ width: AUTHOR_COL_WIDTH }}
          title={`${commit.author.name} <${commit.author.email}>`}
        >
          {commit.author.name}
        </span>
      )}
      {columns.hash && (
        <button
          type="button"
          className={cn(
            "text-faint hover:bg-muted hover:text-foreground w-14 shrink-0 rounded px-0.5 font-mono text-[11px]",
            columns.message ? "text-right" : "text-left"
          )}
          title={t("gitRepo.graph.row.copyFullHash")}
          onClick={(e) => {
            e.stopPropagation();
            void navigator.clipboard.writeText(commit.oid);
            toast.success(t("gitRepo.graph.row.hashCopied"));
          }}
        >
          {commit.shortOid.slice(0, 7)}
        </button>
      )}
      {columns.date && (
        <span
          className={cn(
            "text-faint w-[4.5rem] shrink-0 text-[11px] whitespace-nowrap",
            columns.message ? "text-right" : "text-left"
          )}
          title={formatDate(commit.author.time)}
        >
          {timeAgo(commit.author.time)}
        </span>
      )}
      {!columns.message && <span className="min-w-0 flex-1" />}
    </div>
  );
});
