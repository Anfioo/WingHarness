/**
 * The pan-and-zoom board the workflow is drawn on.
 *
 * Nodes are plain DOM so the text inside them wraps and clamps the way every
 * other block in the app does; the edges between them are one SVG layer behind
 * them, curved so a branch reads as leaving the node above it rather than as a
 * straight line to it.
 */

import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import { Bot, Copy, GitFork, Maximize2, Minus, Plus, User } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import { formatHistoryTime } from "../claude-chat/format";
import {
  NODE_HEIGHT,
  NODE_WIDTH,
  type WorkflowEdge,
  type WorkflowLayout,
  type WorkflowNode,
} from "./graph";

const MIN_SCALE = 0.2;
const MAX_SCALE = 1.6;

interface View {
  x: number;
  y: number;
  scale: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function WorkflowCanvas({
  layout,
  selectedId,
  onSelect,
  onOpenSession,
}: {
  layout: WorkflowLayout;
  selectedId: string | null;
  onSelect: (node: WorkflowNode | null) => void;
  onOpenSession: (node: WorkflowNode) => void;
}) {
  const { t } = useAppTranslation();
  const board = useRef<HTMLDivElement | null>(null);
  const [view, setView] = useState<View>({ x: 0, y: 0, scale: 1 });
  const drag = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    fromX: number;
    fromY: number;
  } | null>(null);
  const moved = useRef(false);
  const [panning, setPanning] = useState(false);

  const fit = useCallback(() => {
    const element = board.current;
    if (!element) return;
    const width = element.clientWidth;
    const height = element.clientHeight;
    if (!width || !height) return;
    const scale = clamp(
      Math.min((width - 64) / layout.width, (height - 64) / layout.height),
      MIN_SCALE,
      MAX_SCALE
    );
    setView({
      scale,
      x: (width - layout.width * scale) / 2,
      y: Math.max((height - layout.height * scale) / 2, 24),
    });
  }, [layout]);

  // A new graph is a new board: start it fitted rather than wherever the last
  // one was left.
  useEffect(() => {
    fit();
  }, [fit]);

  // The wheel listener has to be native: React's is passive, so it cannot stop
  // the window from scrolling the page behind the board.
  useEffect(() => {
    const element = board.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const rect = element.getBoundingClientRect();
      const pointerX = event.clientX - rect.left;
      const pointerY = event.clientY - rect.top;
      setView((current) => {
        const scale = clamp(
          current.scale * (event.deltaY < 0 ? 1.1 : 1 / 1.1),
          MIN_SCALE,
          MAX_SCALE
        );
        const ratio = scale / current.scale;
        return {
          scale,
          // The point under the cursor stays under the cursor.
          x: pointerX - (pointerX - current.x) * ratio,
          y: pointerY - (pointerY - current.y) * ratio,
        };
      });
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, []);

  const zoom = (factor: number) => {
    const element = board.current;
    const width = element?.clientWidth ?? 0;
    const height = element?.clientHeight ?? 0;
    setView((current) => {
      const scale = clamp(current.scale * factor, MIN_SCALE, MAX_SCALE);
      const ratio = scale / current.scale;
      // Zoom about the middle of what is on screen.
      return {
        scale,
        x: width / 2 - (width / 2 - current.x) * ratio,
        y: height / 2 - (height / 2 - current.y) * ratio,
      };
    });
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    // A card handles its own clicks; only the empty board pans.
    if ((event.target as HTMLElement).closest("[data-workflow-node]")) return;
    drag.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      fromX: view.x,
      fromY: view.y,
    };
    moved.current = false;
    setPanning(true);
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const dx = event.clientX - current.startX;
    const dy = event.clientY - current.startY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) moved.current = true;
    setView((value) => ({ ...value, x: current.fromX + dx, y: current.fromY + dy }));
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current?.pointerId !== event.pointerId) return;
    drag.current = null;
    setPanning(false);
    // A click on the board clears the selection; a drag that ended here does not.
    if (!moved.current) onSelect(null);
  };

  return (
    <div className="relative h-full w-full overflow-hidden">
      <div
        ref={board}
        role="presentation"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        className={cn("absolute inset-0 touch-none", panning ? "cursor-grabbing" : "cursor-grab")}
        style={{
          backgroundImage: "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
          backgroundSize: `${24 * view.scale}px ${24 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      >
        <div
          className="absolute top-0 left-0 origin-top-left"
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            aria-hidden
            className="absolute top-0 left-0"
            width={layout.width}
            height={layout.height}
          >
            <defs>
              {[
                ["workflow-arrow", "var(--color-border)"],
                ["workflow-arrow-active", "var(--color-primary)"],
              ].map(([id, color]) => (
                <marker
                  key={id}
                  id={id}
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="7"
                  markerHeight="7"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                </marker>
              ))}
            </defs>
            {layout.edges.map((edge) => (
              <Edge key={edge.id} edge={edge} active={touches(edge, selectedId)} />
            ))}
          </svg>

          {layout.nodes.map((node) => (
            <NodeCard
              key={node.id}
              node={node}
              selected={node.id === selectedId}
              onSelect={() => onSelect(node)}
              onOpen={() => onOpenSession(node)}
            />
          ))}
        </div>
      </div>

      <div className="border-border bg-card/90 absolute right-3 bottom-3 flex items-center gap-1 rounded-lg border p-1 shadow-sm backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t("claudeWorkflow.zoomOut")}
          onClick={() => zoom(1 / 1.2)}
        >
          <Minus className="size-3.5" />
        </Button>
        <span className="text-muted-foreground w-10 text-center font-mono text-[11px]">
          {Math.round(view.scale * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t("claudeWorkflow.zoomIn")}
          onClick={() => zoom(1.2)}
        >
          <Plus className="size-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          title={t("claudeWorkflow.fit")}
          onClick={fit}
        >
          <Maximize2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** True when an edge is an end of the selected turn, so it is drawn as part of
 *  the path the selection is on. */
function touches(edge: WorkflowEdge, selectedId: string | null): boolean {
  return selectedId !== null && (edge.from.id === selectedId || edge.to.id === selectedId);
}

function Edge({ edge, active }: { edge: WorkflowEdge; active: boolean }) {
  const x1 = edge.from.x + NODE_WIDTH / 2;
  const y1 = edge.from.y + NODE_HEIGHT;
  const x2 = edge.to.x + NODE_WIDTH / 2;
  const y2 = edge.to.y;
  const mid = y1 + (y2 - y1) / 2;
  return (
    <path
      d={`M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`}
      fill="none"
      strokeWidth={2}
      className={cn("stroke-border", active && "stroke-primary")}
      markerEnd={active ? "url(#workflow-arrow-active)" : "url(#workflow-arrow)"}
    />
  );
}

/**
 * One turn: what was asked, and the last thing the CLI said in it.
 *
 * The card is one fixed box — the canvas lays it out on a grid, so it cannot
 * grow — and the whole text is in the details panel beside the board.
 */
function NodeCard({
  node,
  selected,
  onSelect,
  onOpen,
}: {
  node: WorkflowNode;
  selected: boolean;
  onSelect: () => void;
  onOpen: () => void;
}) {
  const { t } = useAppTranslation();
  // The conversation whose line opens here — a clone, drawn beside the one it
  // was copied from. Only the trunk has no caption.
  const line = node.lineStart;
  // The branch that opens here is what the turn is "for"; the ones forked from
  // it are only a count, so a long title has something to give way to.
  const label = node.branchOf[0]?.title ?? "";
  const forks = node.branchOf.length > 0 ? 0 : node.branches.length;

  // A copy nothing has been typed into yet: there is no turn to show, but the
  // branch it opens has to be visible, so the card is the branch and nothing else.
  if (node.empty) {
    return (
      <button
        type="button"
        data-workflow-node
        title={label}
        onClick={onSelect}
        onDoubleClick={onOpen}
        style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
        className={cn(
          "bg-card absolute flex cursor-pointer flex-col items-center justify-center gap-1.5 overflow-hidden rounded-xl border border-dashed p-3 text-center shadow-sm transition-colors",
          selected
            ? "border-primary ring-primary/30 ring-2"
            : "border-primary/50 hover:border-primary"
        )}
      >
        <GitFork className="text-primary size-4 shrink-0" />
        <span className="line-clamp-2 text-xs font-medium">{label}</span>
        <span className="text-muted-foreground text-[11px]">{t("claudeWorkflow.emptyFork")}</span>
      </button>
    );
  }

  return (
    <button
      type="button"
      data-workflow-node
      title={node.question || node.answer}
      onClick={onSelect}
      onDoubleClick={onOpen}
      style={{ left: node.x, top: node.y, width: NODE_WIDTH, height: NODE_HEIGHT }}
      className={cn(
        "bg-card absolute flex cursor-pointer flex-col overflow-hidden rounded-xl border p-3 text-left shadow-sm transition-colors",
        selected
          ? "border-primary ring-primary/30 ring-2"
          : "border-border hover:border-primary/40",
        !selected && label && "border-primary/40"
      )}
    >
      {line && (
        <div className="border-border bg-muted/50 -mx-3 -mt-3 mb-2 flex shrink-0 items-center gap-1.5 border-b px-3 py-1">
          <Copy className="text-muted-foreground size-3 shrink-0" />
          <span className="min-w-0 truncate text-[10px] font-medium" title={line.title}>
            {line.title}
          </span>
        </div>
      )}

      <div className="flex shrink-0 items-center gap-1.5">
        <User className="text-primary size-3.5 shrink-0" />
        <span className="text-[11px] font-medium">{t("claudeWorkflow.you")}</span>
        {node.timestamp && (
          <span className="text-muted-foreground font-mono text-[10px]">
            {formatHistoryTime(Date.parse(node.timestamp))}
          </span>
        )}
        {(label || forks > 0) && (
          <Badge
            variant="secondary"
            className="ml-auto max-w-28 gap-1 px-1.5 py-0 text-[10px] font-normal"
            title={label || undefined}
          >
            <GitFork className="size-2.5 shrink-0" />
            <span className="truncate">
              {label || t("claudeWorkflow.branches", { count: forks })}
            </span>
          </Badge>
        )}
      </div>

      <p className="mt-1 line-clamp-3 shrink-0 text-xs leading-[1.4] whitespace-pre-wrap">
        {node.question || t("claudeWorkflow.noQuestion")}
      </p>

      <div className="border-border mt-auto flex items-center gap-1.5 border-t pt-1.5">
        <Bot className="text-muted-foreground size-3.5 shrink-0" />
        <span className="text-[11px] font-medium">{t("claudeWorkflow.claude")}</span>
      </div>
      <p className="text-muted-foreground mt-1 line-clamp-2 text-[11px] leading-[1.35] whitespace-pre-wrap">
        {node.answer || t("claudeWorkflow.noReply")}
      </p>
    </button>
  );
}
