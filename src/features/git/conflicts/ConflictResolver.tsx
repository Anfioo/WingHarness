import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type RefObject,
} from "react";
import { Group, Panel, Separator, useDefaultLayout } from "react-resizable-panels";
import { useVirtualizer } from "@tanstack/react-virtual";
import { toast } from "sonner";
import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  GitMerge,
  Loader2,
  Pencil,
  Plus,
  RotateCcw,
  Sparkles,
  X,
} from "lucide-react";

import { conflictRead, conflictResolve } from "@/commands";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/confirm";
import { AiText, aiConfigured, getAiProvider } from "@/features/git/ai";
import { useRepo } from "@/features/git/repository-store";
import { useUi } from "@/features/git/ui-store";
import { basename, dirname, modKey } from "@/features/git/utils";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { explainConflict } from "@/lib/git-core/ai";
import {
  parseConflicts,
  serializeResolution,
  type Block,
  type ConflictBlock,
  type RepoState,
} from "@/lib/git-core";
import { cn } from "@/lib/utils";

import { mergeConflicts } from "./auto-merge";

type Side = "current" | "incoming";

interface Pick {
  side: Side;
  line: number;
}

const EMPTY_SIDE = -1;
const VIRTUAL_THRESHOLD = 1500;
const TEXT_ROW_HEIGHT = 20;
const CONFLICT_ROW_HEIGHT = 24;
const MARKER_LINE = /^<{7}(?: |\r?$)/m;

type PaneRow =
  | { kind: "text"; block: number; text: string; li: number }
  | { kind: "header"; block: number }
  | { kind: "conflict"; block: number; li: number; last: boolean };

interface SideStart {
  a: number;
  b: number;
}

type OutputRow =
  | { kind: "text"; text: string; key: string; lineNo: number }
  | { kind: "unresolved"; block: number; text: string; first: boolean; key: string; lineNo: number }
  | {
      kind: "pick";
      side: Side;
      text: string;
      block: number;
      first: boolean;
      key: string;
      lineNo: number;
    }
  | { kind: "edited"; text: string; block: number; first: boolean; key: string; lineNo: number }
  | { kind: "deleted"; block: number; side: Side | null; key: string }
  | { kind: "editor"; block: number; key: string };

type BlockState = "unresolved" | "resolved" | "edited";

function unresolvedPreview(block: ConflictBlock): string[] {
  if (block.base && block.base.length > 0) return block.base;
  if (block.current.length > 0) return block.current;
  return [""];
}

function stripCr(line: string): string {
  return line.replace(/\r$/, "");
}

function blockUsesCrlf(block: ConflictBlock): boolean {
  return block.markers.open.endsWith("\r");
}

function editSaveLines(edit: string, crlf: boolean): string[] {
  if (edit === "") return [];
  const lines = edit.split("\n").map(stripCr);
  return crlf ? lines.map((line) => `${line}\r`) : lines;
}

function normalizePicks(picks: Pick[]): Pick[] {
  return [...picks].sort((x, y) =>
    x.side === y.side ? x.line - y.line : x.side === "current" ? -1 : 1
  );
}

function buildPaneRows(blocks: Block[] | null): {
  rows: PaneRow[];
  blockStart: Map<number, number>;
  lineStart: Map<number, SideStart>;
  lastLine: number;
} {
  const rows: PaneRow[] = [];
  const blockStart = new Map<number, number>();
  const lineStart = new Map<number, SideStart>();
  let a = 1;
  let b = 1;
  (blocks ?? []).forEach((block, index) => {
    blockStart.set(index, rows.length);
    lineStart.set(index, { a, b });
    if (block.kind === "text") {
      block.lines.forEach((text, li) => rows.push({ kind: "text", block: index, text, li }));
      a += block.lines.length;
      b += block.lines.length;
      return;
    }
    rows.push({ kind: "header", block: index });
    const count = Math.max(
      block.current.length || 1,
      block.incoming.length || 1,
      block.base?.length || 1
    );
    for (let li = 0; li < count; li += 1) {
      rows.push({ kind: "conflict", block: index, li, last: li === count - 1 });
    }
    a += block.current.length;
    b += block.incoming.length;
  });
  return { rows, blockStart, lineStart, lastLine: Math.max(a, b) };
}

function gutterWidth(lastLine: number): number {
  return Math.max(36, String(lastLine).length * 7 + 14);
}

function LineNo({ n }: { n: number | null }) {
  return (
    <span
      data-line-no
      style={{ width: "var(--gutter)" }}
      className="text-faint shrink-0 pr-2 text-right font-mono text-[10px] leading-5 tabular-nums select-none"
    >
      {n ?? ""}
    </span>
  );
}

function useOffsetTop(ref: RefObject<HTMLDivElement | null>): number {
  const [offset, setOffset] = useState(0);
  // Re-measured after every render: the rows above move when the panes resize,
  // and the equality guard keeps the update from looping.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) setOffset((prev) => (prev === el.offsetTop ? prev : el.offsetTop));
  });
  return offset;
}

function sideLabel(block: ConflictBlock, side: Side, headBranch: string | null): string {
  const raw = side === "current" ? block.currentLabel : block.incomingLabel;
  if (side === "current" && (raw === "HEAD" || raw === "") && headBranch) return headBranch;
  return raw || (side === "current" ? "current" : "incoming");
}

function Checkbox({
  checked,
  onCheckedChange,
  className,
  onClick,
  "aria-label": ariaLabel,
}: {
  checked: boolean | "indeterminate";
  onCheckedChange?: () => void;
  className?: string;
  onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void;
  "aria-label"?: string;
}) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked === "indeterminate" ? "mixed" : checked}
      aria-label={ariaLabel}
      onClick={(event) => {
        onClick?.(event);
        if (event.defaultPrevented) return;
        onCheckedChange?.();
      }}
      className={cn(
        "flex size-3.5 shrink-0 items-center justify-center rounded border transition-colors",
        checked === true
          ? "border-primary bg-primary text-primary-foreground"
          : checked === "indeterminate"
            ? "border-primary bg-primary/20 text-primary"
            : "border-border bg-background",
        className
      )}
    >
      {checked === true && <Check className="size-3" />}
      {checked === "indeterminate" && <span className="h-0.5 w-2 rounded-full bg-current" />}
    </button>
  );
}

export function ConflictResolver() {
  const { t } = useAppTranslation();
  const conflictFile = useUi((s) => s.conflictFile);
  const openConflict = useUi((s) => s.openConflict);
  const repo = useRepo((s) => s.repo);
  const conflicts = useRepo((s) => s.conflicts);
  const refreshStatus = useRepo((s) => s.refreshStatus);
  const { defaultLayout, onLayoutChanged } = useDefaultLayout({ id: "conflict-resolver" });

  const overlayRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    overlayRef.current?.focus({ preventScroll: true });
  }, []);

  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [picks, setPicks] = useState<Map<number, Pick[]>>(new Map());
  const [manualText, setManualText] = useState<string | null>(null);
  const [activeConflict, setActiveConflict] = useState(0);
  const [saving, setSaving] = useState(false);
  const [aiText, setAiText] = useState<string | null>(null);
  const [aiBusy, setAiBusy] = useState(false);
  const aiRunRef = useRef(0);
  const [blockEdits, setBlockEdits] = useState<Map<number, string>>(new Map());
  const [editingBlock, setEditingBlock] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [lastTouched, setLastTouched] = useState<number | null>(null);
  const editSessionRef = useRef<{
    block: number;
    before: string | undefined;
    focused: boolean;
    caretLine: number;
  } | null>(null);
  const blockRefs = useRef(new Map<number, HTMLDivElement>());
  const outputBlockRefs = useRef(new Map<number, HTMLDivElement>());
  const topScrollRef = useRef<HTMLDivElement>(null);
  const topListRef = useRef<HTMLDivElement>(null);
  const outputScrollRef = useRef<HTMLDivElement>(null);
  const outputListRef = useRef<HTMLDivElement>(null);

  const path = repo?.path ?? "";
  const repoState: RepoState = repo?.state ?? "clean";
  const file = conflictFile;

  useEffect(() => {
    if (!path || !file) return;
    let cancelled = false;
    conflictRead(path, file)
      .then((conflict) => {
        if (cancelled) return;
        setBlocks(parseConflicts(conflict.content));
        setPicks(new Map());
        setManualText(null);
        setBlockEdits(new Map());
        editSessionRef.current = null;
        setEditingBlock(null);
        setActiveConflict(0);
      })
      .catch(() => {
        if (cancelled) return;
        toast.error(t("gitRepo.conflicts.loadFailed"));
        openConflict(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, file, openConflict]);

  const conflictIndices = useMemo(
    () => (blocks ? blocks.flatMap((b, i) => (b.kind === "conflict" ? [i] : [])) : []),
    [blocks]
  );
  const paneModel = useMemo(() => buildPaneRows(blocks), [blocks]);
  const virtualized = paneModel.rows.length > VIRTUAL_THRESHOLD;

  const outputStarts = useMemo(() => {
    const starts = new Map<number, number>();
    let n = 1;
    (blocks ?? []).forEach((block, index) => {
      starts.set(index, n);
      if (block.kind === "text") {
        n += block.lines.length;
        return;
      }
      if (editingBlock === index) {
        n += Math.max(1, editDraft === "" ? 0 : editDraft.split("\n").length);
        return;
      }
      const edit = blockEdits.get(index);
      if (edit !== undefined) {
        n += edit === "" ? 0 : edit.split("\n").length;
        return;
      }
      const blockPicks = picks.get(index) ?? [];
      if (blockPicks.length === 0) {
        n += unresolvedPreview(block).length;
        return;
      }
      n += blockPicks.filter((p) => p.line !== EMPTY_SIDE).length;
    });
    return starts;
  }, [blocks, picks, blockEdits, editingBlock, editDraft]);

  const outputModel = useMemo<{ rows: OutputRow[]; blockRow: Map<number, number> }>(() => {
    const rows: OutputRow[] = [];
    const blockRow = new Map<number, number>();
    if (!blocks) return { rows, blockRow };
    blocks.forEach((block, index) => {
      const start = outputStarts.get(index) ?? 1;
      if (block.kind === "text") {
        block.lines.forEach((text, li) =>
          rows.push({ kind: "text", text, key: `t${index}:${li}`, lineNo: start + li })
        );
        return;
      }
      blockRow.set(index, rows.length);
      if (editingBlock === index) {
        rows.push({ kind: "editor", block: index, key: `ed${index}` });
        return;
      }
      const edit = blockEdits.get(index);
      if (edit !== undefined) {
        if (edit === "") {
          rows.push({ kind: "deleted", block: index, side: null, key: `d${index}` });
          return;
        }
        edit.split("\n").forEach((text, li) =>
          rows.push({
            kind: "edited",
            text,
            block: index,
            first: li === 0,
            key: `e${index}:${li}`,
            lineNo: start + li,
          })
        );
        return;
      }
      const blockPicks = picks.get(index) ?? [];
      if (blockPicks.length === 0) {
        unresolvedPreview(block).forEach((text, li) =>
          rows.push({
            kind: "unresolved",
            block: index,
            text,
            first: li === 0,
            key: `u${index}:${li}`,
            lineNo: start + li,
          })
        );
        return;
      }
      const kept = blockPicks.filter((p) => p.line !== EMPTY_SIDE);
      if (kept.length === 0) {
        rows.push({
          kind: "deleted",
          block: index,
          side: blockPicks[0]?.side ?? null,
          key: `d${index}`,
        });
        return;
      }
      kept.forEach((pick, pi) =>
        rows.push({
          kind: "pick",
          side: pick.side,
          text: (pick.side === "current" ? block.current : block.incoming)[pick.line],
          block: index,
          first: pi === 0,
          key: `p${index}:${pi}`,
          lineNo: start + pi,
        })
      );
    });
    return { rows, blockRow };
  }, [blocks, picks, blockEdits, editingBlock, outputStarts]);

  const topMargin = useOffsetTop(topListRef);
  const outputMargin = useOffsetTop(outputListRef);

  const paneRowKey = (row: PaneRow): string =>
    row.kind === "header" ? `h${row.block}` : `${row.kind[0]}${row.block}:${row.li}`;

  const topVirtualizer = useVirtualizer({
    count: paneModel.rows.length,
    getScrollElement: () => topScrollRef.current,
    estimateSize: (index) =>
      paneModel.rows[index].kind === "text" ? TEXT_ROW_HEIGHT : CONFLICT_ROW_HEIGHT,
    getItemKey: (index) => paneRowKey(paneModel.rows[index]),
    overscan: 20,
    scrollMargin: topMargin,
    enabled: virtualized,
  });

  const outputVirtualizer = useVirtualizer({
    count: outputModel.rows.length,
    getScrollElement: () => outputScrollRef.current,
    estimateSize: (index) => (outputModel.rows[index].kind === "editor" ? 240 : TEXT_ROW_HEIGHT),
    getItemKey: (index) => outputModel.rows[index].key,
    overscan: 20,
    scrollMargin: outputMargin,
    enabled: virtualized,
  });

  const total = conflictIndices.length;
  const resolvedCount = useMemo(
    () =>
      conflictIndices.filter((i) => (picks.get(i)?.length ?? 0) > 0 || blockEdits.has(i)).length,
    [conflictIndices, picks, blockEdits]
  );
  const hasProgress = manualText !== null || blockEdits.size > 0 || resolvedCount > 0;

  const firstConflict = blocks?.find((b): b is ConflictBlock => b.kind === "conflict");
  const headBranch = repo?.headBranch ?? null;
  const aLabel = firstConflict ? sideLabel(firstConflict, "current", headBranch) : "current";
  const bLabel = firstConflict ? sideLabel(firstConflict, "incoming", headBranch) : "incoming";
  const hasBase = useMemo(
    () =>
      (blocks ?? []).some(
        (block) => block.kind === "conflict" && block.base !== null && block.base.length > 0
      ),
    [blocks]
  );
  const topCols = hasBase ? "grid-cols-3" : "grid-cols-2";
  const fileIndex = file ? conflicts.indexOf(file) : -1;

  const sideHint = (side: Side): string => {
    const key = side === "current" ? "current" : "incoming";
    switch (repoState) {
      case "rebase":
        return t(`gitRepo.conflicts.sideHint.rebase.${key}`);
      case "cherrypick":
        return t(`gitRepo.conflicts.sideHint.cherrypick.${key}`);
      case "revert":
        return t(`gitRepo.conflicts.sideHint.revert.${key}`);
      default:
        return t(`gitRepo.conflicts.sideHint.merge.${key}`);
    }
  };

  const finishHint = (): string => {
    switch (repoState) {
      case "rebase":
        return t("gitRepo.conflicts.finishHint.rebase");
      case "cherrypick":
        return t("gitRepo.conflicts.finishHint.cherrypick");
      case "revert":
        return t("gitRepo.conflicts.finishHint.revert");
      default:
        return t("gitRepo.conflicts.finishHint.merge");
    }
  };

  const pickedLines = (block: ConflictBlock, blockPicks: Pick[]): string[] =>
    blockPicks
      .filter((pick) => pick.line !== EMPTY_SIDE)
      .map((pick) => (pick.side === "current" ? block.current : block.incoming)[pick.line]);

  const buildResult = (): string => {
    if (!blocks) return "";
    const manualEdits = new Map<number, string[]>();
    const resolved = blocks.map((block, index) => {
      if (block.kind !== "conflict") return block;
      const edit = blockEdits.get(index);
      const blockPicks = picks.get(index) ?? [];
      if (edit === undefined && blockPicks.length === 0) return block;
      manualEdits.set(
        index,
        edit !== undefined
          ? editSaveLines(edit, blockUsesCrlf(block))
          : pickedLines(block, blockPicks)
      );
      return { ...block, resolution: "manual" as const };
    });
    return serializeResolution(resolved, manualEdits);
  };

  const manualHasMarkers = manualText !== null && MARKER_LINE.test(manualText);
  const blockEditsHaveMarkers = useMemo(
    () => [...blockEdits.values()].some((text) => MARKER_LINE.test(text)),
    [blockEdits]
  );
  const canSave =
    manualText !== null
      ? !manualHasMarkers
      : blocks !== null && resolvedCount === total && !blockEditsHaveMarkers;

  const guardEdits = async (blockIndex?: number): Promise<boolean> => {
    const replaceManual = manualText !== null;
    const replaceBlocks =
      blockIndex === undefined ? blockEdits.size > 0 : blockEdits.has(blockIndex);
    if (!replaceManual && !replaceBlocks) return true;
    const ok = await confirmDialog({
      title: t("gitRepo.conflicts.replaceEditsTitle"),
      description: replaceManual
        ? t("gitRepo.conflicts.replaceEditsBodyManual")
        : blockIndex === undefined
          ? t("gitRepo.conflicts.replaceEditsBodyAll")
          : t("gitRepo.conflicts.replaceEditsBodyBlock"),
      confirmLabel: t("gitRepo.conflicts.replace"),
      destructive: true,
    });
    if (!ok) return false;
    if (replaceManual) setManualText(null);
    if (replaceBlocks) {
      if (blockIndex === undefined) setBlockEdits(new Map());
      else
        setBlockEdits((prev) => {
          const next = new Map(prev);
          next.delete(blockIndex);
          return next;
        });
    }
    return true;
  };

  const confirmLeave = async (): Promise<boolean> => {
    if (!hasProgress) return true;
    return confirmDialog({
      title: t("gitRepo.conflicts.closeTitle"),
      description: t("gitRepo.conflicts.closeBody"),
      path: file ?? undefined,
      confirmLabel: t("gitRepo.conflicts.closeConfirm"),
      destructive: true,
    });
  };

  const requestClose = async () => {
    if (await confirmLeave()) openConflict(null);
  };

  const switchFile = async (direction: 1 | -1) => {
    if (conflicts.length < 2 || fileIndex < 0) return;
    const next = conflicts[(fileIndex + direction + conflicts.length) % conflicts.length];
    if (await confirmLeave()) openConflict(next);
  };

  const isPicked = (index: number, side: Side, line: number): boolean =>
    (picks.get(index) ?? []).some((pick) => pick.side === side && pick.line === line);

  const touch = (index: number) => {
    const at = conflictIndices.indexOf(index);
    if (at >= 0) setActiveConflict(at);
    setLastTouched(index);
  };

  const toggleLine = async (index: number, side: Side, line: number) => {
    if (!(await guardEdits(index))) return;
    setPicks((prev) => {
      const next = new Map(prev);
      const blockPicks = [...(next.get(index) ?? [])];
      const at = blockPicks.findIndex((pick) => pick.side === side && pick.line === line);
      if (at >= 0) blockPicks.splice(at, 1);
      else blockPicks.push({ side, line });
      next.set(index, normalizePicks(blockPicks));
      return next;
    });
    touch(index);
  };

  const sideFullyPicked = (index: number, side: Side): boolean => {
    if (!blocks) return false;
    const block = blocks[index];
    if (!block || block.kind !== "conflict") return false;
    const lines = side === "current" ? block.current : block.incoming;
    const blockPicks = picks.get(index) ?? [];
    if (lines.length === 0)
      return blockPicks.some((pick) => pick.side === side && pick.line === EMPTY_SIDE);
    return lines.every((_, li) =>
      blockPicks.some((pick) => pick.side === side && pick.line === li)
    );
  };

  const sidePartlyPicked = (index: number, side: Side): boolean =>
    (picks.get(index) ?? []).some((pick) => pick.side === side);

  const allOfSidePicked = (side: Side): boolean =>
    total > 0 && conflictIndices.every((i) => sideFullyPicked(i, side));

  const blockState = (index: number): BlockState =>
    blockEdits.has(index)
      ? "edited"
      : (picks.get(index)?.length ?? 0) > 0
        ? "resolved"
        : "unresolved";

  const toggleBlockSide = async (index: number, side: Side) => {
    if (!blocks || !(await guardEdits(index))) return;
    const block = blocks[index];
    if (!block || block.kind !== "conflict") return;
    const lines = side === "current" ? block.current : block.incoming;
    const takeAll = !sideFullyPicked(index, side);
    setPicks((prev) => {
      const next = new Map(prev);
      const blockPicks = [...(next.get(index) ?? [])].filter((pick) => pick.side !== side);
      if (takeAll) {
        if (lines.length === 0) blockPicks.push({ side, line: EMPTY_SIDE });
        else lines.forEach((_, li) => blockPicks.push({ side, line: li }));
      }
      next.set(index, normalizePicks(blockPicks));
      return next;
    });
    touch(index);
  };

  const togglePaneSide = async (side: Side) => {
    if (!blocks || !(await guardEdits())) return;
    const takeAll = !allOfSidePicked(side);
    setPicks((prev) => {
      const next = new Map(prev);
      for (const index of conflictIndices) {
        const block = blocks[index];
        if (!block || block.kind !== "conflict") continue;
        const lines = side === "current" ? block.current : block.incoming;
        const blockPicks = [...(next.get(index) ?? [])].filter((pick) => pick.side !== side);
        if (takeAll) {
          if (lines.length === 0) blockPicks.push({ side, line: EMPTY_SIDE });
          else lines.forEach((_, li) => blockPicks.push({ side, line: li }));
        }
        next.set(index, normalizePicks(blockPicks));
      }
      return next;
    });
  };

  const reset = async () => {
    if (!(await guardEdits())) return;
    setPicks(new Map());
    editSessionRef.current = null;
    setEditingBlock(null);
    setActiveConflict(0);
  };

  const discardManual = async () => {
    const ok = await confirmDialog({
      title: t("gitRepo.conflicts.discardResultTitle"),
      description: t("gitRepo.conflicts.discardResultBody"),
      confirmLabel: t("gitRepo.conflicts.discard"),
      destructive: true,
    });
    if (ok) setManualText(null);
  };

  const lineFromEvent = (event: ReactMouseEvent): number => {
    const row = (event.target as HTMLElement).closest("[data-line]");
    const value = row?.getAttribute("data-line");
    return value ? Number(value) : 0;
  };

  const startEdit = (index: number, caretLine = 0) => {
    if (!blocks) return;
    const block = blocks[index];
    if (!block || block.kind !== "conflict") return;
    const edit = blockEdits.get(index);
    const blockPicks = picks.get(index) ?? [];
    const initial =
      edit !== undefined
        ? edit
        : blockPicks.length > 0
          ? pickedLines(block, blockPicks).map(stripCr).join("\n")
          : [...block.current, ...block.incoming].map(stripCr).join("\n");
    editSessionRef.current = { block: index, before: edit, focused: false, caretLine };
    setEditDraft(initial);
    setEditingBlock(index);
    const at = conflictIndices.indexOf(index);
    if (at >= 0) setActiveConflict(at);
    scrollTopToBlock(index);
  };

  const closeEditor = (revert: boolean) => {
    const session = editSessionRef.current;
    if (!session) return;
    if (revert) {
      setBlockEdits((prev) => {
        const next = new Map(prev);
        if (session.before === undefined) next.delete(session.block);
        else next.set(session.block, session.before);
        return next;
      });
    }
    editSessionRef.current = null;
    setEditingBlock(null);
  };

  const revertEdit = async (index: number) => {
    const ok = await confirmDialog({
      title: t("gitRepo.conflicts.discardEditTitle"),
      description: t("gitRepo.conflicts.discardEditBody"),
      confirmLabel: t("gitRepo.conflicts.discard"),
      destructive: true,
    });
    if (!ok) return;
    setBlockEdits((prev) => {
      const next = new Map(prev);
      next.delete(index);
      return next;
    });
  };

  const registerBlock = (index: number) => (el: HTMLDivElement | null) => {
    if (el) blockRefs.current.set(index, el);
    else blockRefs.current.delete(index);
  };

  const registerOutputBlock = (index: number) => (el: HTMLDivElement | null) => {
    if (el) outputBlockRefs.current.set(index, el);
    else outputBlockRefs.current.delete(index);
  };

  const scrollTopToBlock = (blockIndex: number) => {
    if (virtualized) {
      topVirtualizer.scrollToIndex(paneModel.blockStart.get(blockIndex) ?? 0, { align: "center" });
    } else {
      blockRefs.current.get(blockIndex)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  const scrollOutputToBlock = (blockIndex: number) => {
    if (manualText !== null) return;
    if (virtualized) {
      const row = outputModel.blockRow.get(blockIndex);
      if (row !== undefined) outputVirtualizer.scrollToIndex(row, { align: "center" });
    } else {
      outputBlockRefs.current
        .get(blockIndex)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  };

  useEffect(() => {
    if (lastTouched === null) return;
    scrollOutputToBlock(lastTouched);
    setLastTouched(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastTouched]);

  useEffect(() => {
    if (!blocks || conflictIndices.length === 0) return;
    const id = requestAnimationFrame(() => {
      scrollTopToBlock(conflictIndices[0]);
      scrollOutputToBlock(conflictIndices[0]);
    });
    return () => cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [blocks]);

  const jump = (direction: number) => {
    if (total === 0) return;
    const next = (activeConflict + direction + total) % total;
    setActiveConflict(next);
    const blockIndex = conflictIndices[next];
    scrollTopToBlock(blockIndex);
    scrollOutputToBlock(blockIndex);
  };

  const explain = async (current: string, incoming: string) => {
    if (!aiConfigured()) {
      toast.info(t("gitRepo.conflicts.aiNotConfigured"));
      return;
    }
    const run = ++aiRunRef.current;
    const stillRunning = () => aiRunRef.current === run;
    setAiBusy(true);
    try {
      const text = await explainConflict(getAiProvider(), file ?? "", current, incoming);
      if (stillRunning()) setAiText(text);
    } catch (error) {
      if (stillRunning()) {
        toast.error(
          t("gitRepo.conflicts.aiFailed", {
            error: (error as { message?: string } | null)?.message ?? String(error),
          })
        );
      }
    } finally {
      if (stillRunning()) setAiBusy(false);
    }
  };

  const stopExplain = () => {
    aiRunRef.current += 1;
    setAiBusy(false);
  };

  const autoMerge = () => {
    if (!blocks) return;
    const next = new Map(blockEdits);
    const failed: number[] = [];
    let merged = 0;
    conflictIndices.forEach((index, position) => {
      if (next.has(index) || (picks.get(index)?.length ?? 0) > 0) return;
      const block = blocks[index];
      if (!block || block.kind !== "conflict") return;
      const lines = mergeConflicts(file ?? "", block);
      if (lines === null) {
        failed.push(position + 1);
        return;
      }
      next.set(index, lines.map(stripCr).join("\n"));
      merged += 1;
    });
    if (merged > 0) setBlockEdits(next);
    if (failed.length === 0) {
      if (merged === 0) toast.info(t("gitRepo.conflicts.autoMergeNone"));
      else toast.success(t("gitRepo.conflicts.autoMergeToast", { count: merged }));
      return;
    }
    if (merged > 0) toast.success(t("gitRepo.conflicts.autoMergeToast", { count: merged }));
    toast.warning(t("gitRepo.conflicts.autoMergeFailed", { count: failed.length }), {
      description: t("gitRepo.conflicts.autoMergeFailedDesc", { list: failed.join(", ") }),
    });
  };

  const save = async () => {
    if (!path || !file || !canSave || saving) return;
    setSaving(true);
    try {
      const list = useRepo.getState().conflicts;
      const at = list.indexOf(file);
      const remaining = [...list.slice(at + 1), ...list.slice(0, Math.max(at, 0))].filter(
        (f) => f !== file
      );
      await conflictResolve(path, file, manualText ?? buildResult());
      if (remaining.length > 0) {
        toast.success(t("gitRepo.conflicts.resolvedFileToast", { name: basename(file) }), {
          description: t("gitRepo.conflicts.moreFiles", { count: remaining.length }),
        });
        openConflict(remaining[0]);
      } else {
        toast.success(t("gitRepo.conflicts.resolvedFileToast", { name: basename(file) }), {
          description: t("gitRepo.conflicts.allFilesResolved", { hint: finishHint() }),
        });
        openConflict(null);
      }
      await refreshStatus();
    } catch {
      toast.error(t("gitRepo.conflicts.resolveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const mod = event.metaKey || event.ctrlKey;
    const target = event.target as HTMLElement;
    const editable =
      target.tagName === "TEXTAREA" || target.tagName === "INPUT" || target.isContentEditable;
    if (mod && event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      void save();
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.stopPropagation();
      return;
    }
    if (editable) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (aiText !== null || aiBusy) {
        if (aiBusy) stopExplain();
        setAiText(null);
        return;
      }
      void requestClose();
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      jump(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (!mod && !event.altKey && /^[abAB]$/.test(event.key)) {
      const index = conflictIndices[activeConflict];
      if (index === undefined) return;
      event.preventDefault();
      void toggleBlockSide(index, event.key.toLowerCase() === "a" ? "current" : "incoming");
    }
  };

  const stateLabel = (state: BlockState): string =>
    state === "edited"
      ? t("gitRepo.conflicts.stateEdited")
      : state === "resolved"
        ? t("gitRepo.conflicts.stateResolved")
        : t("gitRepo.conflicts.unresolved");

  const resultStatus = (): string =>
    total === 0
      ? t("gitRepo.conflicts.noConflicts")
      : resolvedCount < total
        ? t("gitRepo.conflicts.resolvedCount", { n: resolvedCount, total })
        : t("gitRepo.conflicts.allResolvedStatus");

  const renderLineControl = (index: number, side: Side, li: number, lineCount: number) => {
    const middle = Math.floor((lineCount - 1) / 2);
    if (li === middle) {
      const edited = blockEdits.has(index);
      const checked = edited
        ? false
        : sideFullyPicked(index, side)
          ? true
          : sidePartlyPicked(index, side)
            ? ("indeterminate" as const)
            : false;
      return (
        <Checkbox
          className="mt-1"
          checked={checked}
          onCheckedChange={() => void toggleBlockSide(index, side)}
          onClick={(event) => event.stopPropagation()}
          aria-label={
            side === "current"
              ? t("gitRepo.conflicts.takeBlockAAria")
              : t("gitRepo.conflicts.takeBlockBAria")
          }
        />
      );
    }
    const picked = isPicked(index, side, li);
    return (
      <button
        type="button"
        className={cn(
          "mt-1 flex size-4 shrink-0 items-center justify-center rounded transition-opacity",
          picked
            ? side === "current"
              ? "text-info"
              : "text-success"
            : "text-muted-foreground hover:bg-accent opacity-0 group-hover/line:opacity-100 focus-visible:opacity-100"
        )}
        aria-label={t("gitRepo.conflicts.takeLineAria", {
          line: li + 1,
          side: side === "current" ? "A" : "B",
        })}
        onClick={(event) => {
          event.stopPropagation();
          void toggleLine(index, side, li);
        }}
      >
        {picked ? <Check className="size-3" /> : <Plus className="size-3" />}
      </button>
    );
  };

  const renderSideLine = (index: number, side: Side, li: number) => {
    const block = blocks?.[index];
    if (!block || block.kind !== "conflict") return null;
    const lines = side === "current" ? block.current : block.incoming;
    const start = paneModel.lineStart.get(index) ?? { a: 1, b: 1 };
    const first = side === "current" ? start.a : start.b;
    const paneCls =
      side === "current"
        ? "border-l-2 border-l-info/60 border-r border-border"
        : "border-l-2 border-l-success/60";
    if (lines.length === 0) {
      const taken = sideFullyPicked(index, side);
      return (
        <div className={cn("flex items-start gap-2 px-2 py-0.5", paneCls)}>
          <Checkbox
            className="mt-1"
            checked={taken}
            onCheckedChange={() => void toggleBlockSide(index, side)}
            aria-label={
              side === "current"
                ? t("gitRepo.conflicts.takeBlockAAria")
                : t("gitRepo.conflicts.takeBlockBAria")
            }
          />
          <span className="text-muted-foreground/70 text-xs leading-5 italic">
            {t("gitRepo.conflicts.emptySideNoLines")}
          </span>
        </div>
      );
    }
    if (li >= lines.length) return <div className={cn("h-5", paneCls)} />;
    const picked = isPicked(index, side, li);
    return (
      <div
        role="button"
        tabIndex={0}
        className={cn(
          "group/line flex cursor-pointer items-start gap-2 px-2 transition-colors",
          paneCls,
          picked ? (side === "current" ? "bg-info/10" : "bg-success/10") : "hover:bg-accent/40"
        )}
        onClick={() => void toggleLine(index, side, li)}
      >
        {renderLineControl(index, side, li, lines.length)}
        <LineNo n={first + li} />
        <pre className="text-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
          {lines[li] || " "}
        </pre>
      </div>
    );
  };

  const renderTextPair = (index: number, li: number) => {
    const block = blocks?.[index];
    if (!block || block.kind !== "text") return null;
    const start = paneModel.lineStart.get(index) ?? { a: 1, b: 1 };
    const text = block.lines[li] ?? "";
    return (
      <div className={cn("grid", topCols)}>
        <div className="border-l-info/30 border-border flex items-start gap-2 border-r border-l-2 px-2">
          <LineNo n={start.a + li} />
          <pre className="text-muted-foreground/70 min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {text || " "}
          </pre>
        </div>
        <div className="border-l-success/30 flex items-start gap-2 border-l-2 px-2">
          <LineNo n={start.b + li} />
          <pre className="text-muted-foreground/70 min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
            {text || " "}
          </pre>
        </div>
        {hasBase ? (
          <div className="border-l-border flex items-start gap-2 border-l-2 px-2">
            <pre className="text-muted-foreground/50 min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {text || " "}
            </pre>
          </div>
        ) : null}
      </div>
    );
  };

  const renderPaneRow = (row: PaneRow) => {
    if (row.kind === "text") return renderTextPair(row.block, row.li);
    if (row.kind === "header") {
      const index = row.block;
      const block = blocks?.[index];
      if (!block || block.kind !== "conflict") return null;
      return (
        <div
          ref={registerBlock(index)}
          data-block={index}
          className="group border-border bg-accent/40 relative flex items-center gap-2 border-y px-3 py-1 pr-8"
        >
          <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {t("gitRepo.conflicts.conflictN", { n: conflictIndices.indexOf(index) + 1 })}
          </span>
          <span className="text-muted-foreground/70 text-[10px]">
            {stateLabel(blockState(index))}
          </span>
          <span className="absolute top-0.5 right-1">
            <Button
              variant="ghost"
              size="icon-sm"
              className="h-5 w-5"
              aria-label={t("gitRepo.conflicts.explain")}
              title={t("gitRepo.conflicts.explainHint")}
              onClick={() => void explain(block.current.join("\n"), block.incoming.join("\n"))}
            >
              <Sparkles className="size-3" />
            </Button>
          </span>
        </div>
      );
    }
    const conflictBlock = blocks?.[row.block];
    const baseLines = conflictBlock?.kind === "conflict" ? conflictBlock.base : null;
    const baseText = baseLines && row.li < baseLines.length ? stripCr(baseLines[row.li]) : "";
    return (
      <div className={cn("grid", topCols, !row.last && "border-border border-b")}>
        {renderSideLine(row.block, "current", row.li)}
        {renderSideLine(row.block, "incoming", row.li)}
        {hasBase ? (
          <div className="border-l-border flex items-start gap-2 border-l-2 px-2">
            <pre className="text-muted-foreground/50 min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {baseText || " "}
            </pre>
          </div>
        ) : null}
      </div>
    );
  };

  const renderRevertAction = (index: number) => (
    <span className="absolute top-0.5 right-2 z-10 flex items-center opacity-0 transition-opacity group-hover:opacity-100">
      <Button
        variant="ghost"
        size="icon-sm"
        className="border-border bg-card shadow-soft h-5 w-5 border"
        aria-label={t("gitRepo.conflicts.discardHandEditAria")}
        title={t("gitRepo.conflicts.discardHandEditHint")}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          void revertEdit(index);
        }}
      >
        <RotateCcw className="size-3" />
      </Button>
    </span>
  );

  const renderDeletedRow = (index: number, side: Side | null) => (
    <div
      className={cn(
        "group hover:ring-primary/40 relative flex cursor-text items-start gap-2 px-2 transition-shadow hover:ring-1 hover:ring-inset",
        side === "current" ? "bg-info/5" : side === "incoming" ? "bg-success/5" : "bg-primary/5"
      )}
      onMouseDown={(event) => {
        event.preventDefault();
        startEdit(index, lineFromEvent(event));
      }}
    >
      <LineNo n={null} />
      {side === null ? (
        <span className="flex w-4 shrink-0 items-center justify-center leading-5">
          <Pencil className="text-primary size-3" />
        </span>
      ) : (
        <span className="flex w-4 shrink-0 justify-center pt-1.5">
          <span
            className={cn(
              "h-2.5 w-0.5 rounded-full",
              side === "current" ? "bg-info" : "bg-success"
            )}
          />
        </span>
      )}
      <pre className="text-faint min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap italic">
        {t("gitRepo.conflicts.sectionDeleted")}
      </pre>
      {side === null && renderRevertAction(index)}
    </div>
  );

  const renderBlockEditor = (index: number) => {
    const draftLines = editDraft.split("\n");
    const start = outputStarts.get(index) ?? 1;
    return (
      <div className="flex items-start px-2">
        <div className="flex shrink-0 flex-col" aria-hidden>
          {draftLines.map((_, li) => (
            <div key={li} className="flex items-start gap-2">
              <LineNo n={start + li} />
              <span className="flex w-4 shrink-0 justify-center pt-1.5">
                <span className="bg-primary h-2.5 w-0.5 rounded-full" />
              </span>
            </div>
          ))}
        </div>
        <textarea
          ref={(el) => {
            const session = editSessionRef.current;
            if (el && session && session.block === index && !session.focused) {
              session.focused = true;
              el.focus();
              const lines = el.value.split("\n");
              const line = Math.min(session.caretLine, lines.length - 1);
              const offset = lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0);
              el.setSelectionRange(offset, offset);
            }
          }}
          value={editDraft}
          onChange={(event) => {
            setEditDraft(event.target.value);
            setBlockEdits((prev) => new Map(prev).set(index, event.target.value));
          }}
          onBlur={() => {
            if (editSessionRef.current?.block === index) closeEditor(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closeEditor(true);
            } else if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              closeEditor(false);
            }
          }}
          spellCheck={false}
          rows={Math.max(draftLines.length, 1)}
          aria-label={t("gitRepo.conflicts.handEditAria")}
          className={cn(
            "text-foreground ml-2 min-w-0 flex-1 resize-none overflow-hidden bg-transparent p-0 font-mono text-xs leading-5",
            "focus:outline-none"
          )}
        />
      </div>
    );
  };

  const renderUnresolvedLine = (index: number, text: string, lineNo: number, first: boolean) => (
    <div
      data-line={lineNo - (outputStarts.get(index) ?? 1)}
      className="border-destructive bg-destructive/5 hover:bg-destructive/10 flex cursor-text items-start gap-2 border-l-2 px-2 transition-colors"
      title={t("gitRepo.conflicts.unresolvedHint")}
      onMouseDown={(event) => {
        event.preventDefault();
        startEdit(index, lineFromEvent(event));
      }}
    >
      <LineNo n={lineNo} />
      <span className="w-3.5 shrink-0" />
      <pre className="text-faint min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap italic">
        {text || " "}
      </pre>
      {first && (
        <span className="text-destructive/80 shrink-0 pl-3 text-[10px] leading-5 font-medium whitespace-nowrap select-none">
          {t("gitRepo.conflicts.conflictUnresolved", { n: conflictIndices.indexOf(index) + 1 })}
        </span>
      )}
    </div>
  );

  const renderOutputRow = (row: OutputRow) => {
    switch (row.kind) {
      case "text":
        return (
          <div className="flex items-start gap-2 px-2">
            <LineNo n={row.lineNo} />
            <span className="w-3.5 shrink-0" />
            <pre className="text-muted-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {row.text || " "}
            </pre>
          </div>
        );
      case "editor":
        return renderBlockEditor(row.block);
      case "unresolved":
        return renderUnresolvedLine(row.block, row.text, row.lineNo, row.first);
      case "deleted":
        return renderDeletedRow(row.block, row.side);
      case "edited":
        return (
          <div
            data-line={row.lineNo - (outputStarts.get(row.block) ?? 1)}
            className="group bg-primary/5 hover:ring-primary/40 relative flex cursor-text items-start gap-2 px-2 transition-shadow hover:ring-1 hover:ring-inset"
            onMouseDown={(event) => {
              event.preventDefault();
              startEdit(row.block, lineFromEvent(event));
            }}
          >
            <LineNo n={row.lineNo} />
            <span className="flex w-4 shrink-0 justify-center pt-1.5">
              <Pencil className="text-primary size-3" />
            </span>
            <pre className="text-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {row.text || " "}
            </pre>
            {row.first && renderRevertAction(row.block)}
          </div>
        );
      case "pick":
        return (
          <div
            data-line={row.lineNo - (outputStarts.get(row.block) ?? 1)}
            className={cn(
              "group hover:ring-primary/40 relative flex cursor-text items-start gap-2 px-2 transition-shadow hover:ring-1 hover:ring-inset",
              row.side === "current" ? "bg-info/5" : "bg-success/5"
            )}
            onMouseDown={(event) => {
              event.preventDefault();
              startEdit(row.block, lineFromEvent(event));
            }}
          >
            <LineNo n={row.lineNo} />
            <span className="flex w-4 shrink-0 justify-center pt-1.5">
              <span
                className={cn(
                  "h-2.5 w-0.5 rounded-full",
                  row.side === "current" ? "bg-info" : "bg-success"
                )}
              />
            </span>
            <pre className="text-foreground min-w-0 flex-1 font-mono text-xs leading-5 break-words whitespace-pre-wrap">
              {row.text || " "}
            </pre>
          </div>
        );
    }
  };

  const headerHint = manualHasMarkers
    ? t("gitRepo.conflicts.remainingMarkersHint")
    : !canSave
      ? t("gitRepo.conflicts.pickEveryHint")
      : t("gitRepo.conflicts.saveHint", { mod: modKey() });

  const centered = "flex h-full w-full items-center justify-center gap-2 text-sm";

  if (!file) return null;

  return (
    <div
      ref={overlayRef}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={t("gitRepo.conflicts.title")}
      onKeyDown={onKeyDown}
      style={{ "--gutter": `${gutterWidth(paneModel.lastLine)}px` } as CSSProperties}
      className="bg-background fixed inset-0 z-50 flex flex-col outline-none"
    >
      <header className="border-border bg-card flex h-14 shrink-0 items-center gap-3 border-b px-4">
        <span className="bg-destructive/10 text-destructive flex size-8 shrink-0 items-center justify-center rounded-md">
          <GitMerge className="size-4" />
        </span>
        <div className="flex min-w-0 flex-col">
          <span className="text-muted-foreground text-[10px] font-medium tracking-wide uppercase">
            {t("gitRepo.conflicts.title")}
          </span>
          <span className="flex min-w-0 items-baseline gap-1 text-sm">
            <span className="text-foreground truncate font-mono">{basename(file)}</span>
            <span className="text-muted-foreground/70 truncate font-mono text-[10px]">
              {dirname(file)}
            </span>
          </span>
        </div>

        <span className="ml-2 flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={conflicts.length < 2}
            aria-label={t("gitRepo.conflicts.prevFile")}
            title={t("gitRepo.conflicts.prevFile")}
            onClick={() => void switchFile(-1)}
          >
            <ChevronLeft />
          </Button>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("gitRepo.conflicts.filePosition", { n: fileIndex + 1, total: conflicts.length })}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            disabled={conflicts.length < 2}
            aria-label={t("gitRepo.conflicts.nextFile")}
            title={t("gitRepo.conflicts.nextFile")}
            onClick={() => void switchFile(1)}
          >
            <ChevronRight />
          </Button>
        </span>

        <span className="hidden items-center gap-2 sm:flex">
          <span className="bg-accent h-1.5 w-28 overflow-hidden rounded-full">
            <span
              className="bg-primary block h-full rounded-full transition-all"
              style={{ width: `${total > 0 ? (resolvedCount / total) * 100 : 0}%` }}
            />
          </span>
          <span className="text-muted-foreground text-xs tabular-nums">
            {t("gitRepo.conflicts.resolvedCount", { n: resolvedCount, total })}
          </span>
        </span>

        <span className="ml-auto flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={saving || total === 0}
            title={t("gitRepo.conflicts.autoMergeHint")}
            onClick={autoMerge}
          >
            <Sparkles />
            {t("gitRepo.conflicts.autoMerge")}
          </Button>
          <Button
            size="sm"
            disabled={!canSave || saving}
            title={headerHint}
            onClick={() => void save()}
          >
            {saving ? <Loader2 className="animate-spin" /> : <Check />}
            {t("gitRepo.conflicts.markResolved")}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("gitRepo.conflicts.close")}
            title={t("gitRepo.conflicts.close")}
            onClick={() => void requestClose()}
          >
            <X />
          </Button>
        </span>
      </header>

      {!blocks ? (
        <div className={cn(centered, "text-muted-foreground")}>
          <Loader2 className="size-4 animate-spin" />
          {t("gitRepo.conflicts.loading")}
        </div>
      ) : (
        <Group
          orientation="vertical"
          className="min-h-0 flex-1"
          defaultLayout={defaultLayout}
          onLayoutChanged={onLayoutChanged}
        >
          <Panel id="pane" defaultSize="60" minSize="25" className="overflow-hidden">
            <div ref={topScrollRef} className="relative h-full overflow-y-auto">
              <div className={cn("border-border bg-card sticky top-0 z-10 grid border-b", topCols)}>
                <div className="border-border flex items-center gap-2 border-r px-3 py-1.5">
                  <Checkbox
                    checked={allOfSidePicked("current")}
                    onCheckedChange={() => void togglePaneSide("current")}
                    aria-label={t("gitRepo.conflicts.takeAllAAria")}
                  />
                  <Badge variant="secondary">A</Badge>
                  <span
                    className="text-foreground min-w-0 flex-1 truncate text-xs font-medium"
                    title={sideHint("current")}
                  >
                    {aLabel}
                  </span>
                  <span className="text-muted-foreground/70 shrink-0 text-[10px]">
                    {t("gitRepo.conflicts.sideLabel.current")}
                  </span>
                </div>
                <div className="flex items-center gap-2 px-3 py-1.5">
                  <Checkbox
                    checked={allOfSidePicked("incoming")}
                    onCheckedChange={() => void togglePaneSide("incoming")}
                    aria-label={t("gitRepo.conflicts.takeAllBAria")}
                  />
                  <Badge variant="secondary">B</Badge>
                  <span
                    className="text-foreground min-w-0 flex-1 truncate text-xs font-medium"
                    title={sideHint("incoming")}
                  >
                    {bLabel}
                  </span>
                  <span className="text-muted-foreground/70 shrink-0 text-[10px]">
                    {t("gitRepo.conflicts.sideLabel.incoming")}
                  </span>
                </div>
                {hasBase ? (
                  <div className="border-border flex items-center gap-2 border-l px-3 py-1.5">
                    <Badge variant="outline">base</Badge>
                    <span className="text-muted-foreground/70 min-w-0 flex-1 truncate text-xs font-medium">
                      {t("gitRepo.conflicts.sideLabel.base")}
                    </span>
                  </div>
                ) : null}
              </div>

              <div
                ref={topListRef}
                className="relative"
                style={virtualized ? { height: topVirtualizer.getTotalSize() } : undefined}
              >
                {virtualized
                  ? topVirtualizer.getVirtualItems().map((item) => (
                      <div
                        key={item.key}
                        ref={topVirtualizer.measureElement}
                        data-index={item.index}
                        className="absolute top-0 left-0 w-full"
                        style={{ transform: `translateY(${item.start - topMargin}px)` }}
                      >
                        {renderPaneRow(paneModel.rows[item.index])}
                      </div>
                    ))
                  : paneModel.rows.map((row) => (
                      <div key={paneRowKey(row)}>{renderPaneRow(row)}</div>
                    ))}
              </div>

              {(aiBusy || aiText !== null) && (
                <div className="border-border bg-popover shadow-soft pointer-events-auto absolute right-2 bottom-2 z-20 w-[min(420px,80%)] rounded-lg border p-3">
                  <div className="mb-1 flex items-center gap-2">
                    <Sparkles className="text-primary size-3.5" />
                    <span className="text-foreground text-xs font-medium">
                      {t("gitRepo.conflicts.aiSuggestion")}
                    </span>
                    {aiBusy ? (
                      <Loader2 className="text-muted-foreground ml-auto size-3.5 animate-spin" />
                    ) : (
                      <button
                        type="button"
                        aria-label={t("gitRepo.conflicts.close")}
                        className="text-muted-foreground hover:text-foreground ml-auto transition-colors"
                        onClick={() => setAiText(null)}
                      >
                        <X className="size-3.5" />
                      </button>
                    )}
                  </div>
                  {aiBusy ? (
                    <p className="text-muted-foreground text-xs italic">
                      {t("gitRepo.conflicts.explaining")}
                    </p>
                  ) : (
                    <AiText text={aiText ?? ""} className="max-h-64 overflow-y-auto text-xs" />
                  )}
                </div>
              )}
            </div>
          </Panel>

          <Separator className="bg-border h-1.5" />

          <Panel id="result" defaultSize="40" minSize="20" className="overflow-hidden">
            <div className="flex h-full flex-col">
              <div className="border-border bg-card flex shrink-0 items-center gap-2 border-b px-3 py-1.5">
                <span className="text-foreground text-xs font-medium">
                  {t("gitRepo.conflicts.result")}
                </span>
                {total > 0 && (
                  <>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("gitRepo.conflicts.prevConflict")}
                      title={t("gitRepo.conflicts.prevConflict")}
                      onClick={() => jump(-1)}
                    >
                      <ChevronUp />
                    </Button>
                    <span className="text-muted-foreground text-xs tabular-nums">
                      {t("gitRepo.conflicts.position", { n: activeConflict + 1, total })}
                    </span>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      aria-label={t("gitRepo.conflicts.nextConflict")}
                      title={t("gitRepo.conflicts.nextConflict")}
                      onClick={() => jump(1)}
                    >
                      <ChevronDown />
                    </Button>
                  </>
                )}
                <span className="text-muted-foreground/70 text-xs">{resultStatus()}</span>
                {manualText !== null && (
                  <>
                    <Badge variant="default">
                      <Pencil className="size-3" />
                      {t("gitRepo.conflicts.editedByHand")}
                    </Badge>
                    {manualHasMarkers && (
                      <Badge variant="destructive">{t("gitRepo.conflicts.markersRemain")}</Badge>
                    )}
                  </>
                )}
                <span className="ml-auto flex items-center gap-1">
                  {manualText === null ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("gitRepo.conflicts.editByHand")}
                      title={t("gitRepo.conflicts.editByHand")}
                      onClick={() => setManualText(buildResult())}
                    >
                      <Pencil />
                      {t("gitRepo.conflicts.editByHand")}
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={t("gitRepo.conflicts.resetManual")}
                      title={t("gitRepo.conflicts.resetManual")}
                      onClick={() => void discardManual()}
                    >
                      <RotateCcw />
                      {t("gitRepo.conflicts.resetManual")}
                    </Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => void reset()}>
                    {t("gitRepo.conflicts.reset")}
                  </Button>
                </span>
              </div>

              {manualText !== null ? (
                <textarea
                  value={manualText}
                  onChange={(event) => setManualText(event.target.value)}
                  spellCheck={false}
                  aria-label={t("gitRepo.conflicts.resultContentAria")}
                  className="text-foreground focus:ring-primary/40 min-h-0 flex-1 resize-none bg-transparent px-4 py-2 font-mono text-xs leading-5 focus:ring-1 focus:outline-none focus:ring-inset"
                />
              ) : (
                <div ref={outputScrollRef} className="relative min-h-0 flex-1 overflow-y-auto py-1">
                  <div
                    ref={outputListRef}
                    className="relative"
                    style={virtualized ? { height: outputVirtualizer.getTotalSize() } : undefined}
                  >
                    {virtualized
                      ? outputVirtualizer.getVirtualItems().map((item) => (
                          <div
                            key={item.key}
                            ref={outputVirtualizer.measureElement}
                            data-index={item.index}
                            className="absolute top-0 left-0 w-full"
                            style={{ transform: `translateY(${item.start - outputMargin}px)` }}
                          >
                            {renderOutputRow(outputModel.rows[item.index])}
                          </div>
                        ))
                      : outputModel.rows.map((row) => (
                          <div
                            key={row.key}
                            ref={registerOutputBlock(row.kind === "text" ? -1 : row.block)}
                          >
                            {renderOutputRow(row)}
                          </div>
                        ))}
                  </div>
                </div>
              )}
            </div>
          </Panel>
        </Group>
      )}
    </div>
  );
}
