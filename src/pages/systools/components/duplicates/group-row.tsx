import { Check, ChevronDown, Copy, File, Folder, FolderOpen, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { formatBytes, formatModifiedDate } from "@/lib/systools/format";
import type { DuplicateFileEntry, DuplicateGroup } from "@/lib/systools/duplicates";
import { cn } from "@/lib/utils";
import { FileEntryContextMenu } from "../file-entry-context-menu";
import { SelectionCheckbox } from "../common/selection-checkbox";

export const DUPLICATE_GROUP_ROW_HEIGHT = 54;
export const DUPLICATE_ENTRY_ROW_HEIGHT = 34;

export type DuplicateListRow =
  | { kind: "group"; key: string; height: number; group: DuplicateGroup }
  | {
      kind: "entry";
      key: string;
      height: number;
      group: DuplicateGroup;
      entry: DuplicateFileEntry;
    };

/** Flattens groups and their expanded entries into fixed-height virtual rows. */
export function buildDuplicateRows(
  groups: readonly DuplicateGroup[],
  expanded: ReadonlySet<string>
): DuplicateListRow[] {
  const rows: DuplicateListRow[] = [];
  for (const group of groups) {
    rows.push({
      kind: "group",
      key: `group:${group.id}`,
      height: DUPLICATE_GROUP_ROW_HEIGHT,
      group,
    });
    if (!expanded.has(group.id)) continue;
    for (const entry of group.entries) {
      rows.push({
        kind: "entry",
        key: `entry:${group.id}:${entry.path}`,
        height: DUPLICATE_ENTRY_ROW_HEIGHT,
        group,
        entry,
      });
    }
  }
  return rows;
}

type DuplicateGroupRowProps = {
  group: DuplicateGroup;
  label: string;
  expanded: boolean;
  /** Copies the current rule would mark for deletion in this group. */
  suggestedCount: number;
  /** The suggested copies are all selected. */
  applied: boolean;
  disabled: boolean;
  onToggleExpanded: () => void;
  onToggleSelection: () => void;
};

/** One duplicate group header: kind, size, copies, and reclaimable space. */
export function DuplicateGroupRow({
  group,
  label,
  expanded,
  suggestedCount,
  applied,
  disabled,
  onToggleExpanded,
  onToggleSelection,
}: DuplicateGroupRowProps) {
  const { t, language } = useAppTranslation();
  const isDirectory = group.kind === "directory";
  const summary = isDirectory
    ? t("systools.duplicates.directoryGroupSummary", {
        count: group.entries.length,
        files: group.fileCountPerEntry,
        reclaimable: formatBytes(group.reclaimableBytes, language),
      })
    : t("systools.duplicates.groupSummary", {
        count: group.entries.length,
        size: formatBytes(group.bytesPerFile, language),
        reclaimable: formatBytes(group.reclaimableBytes, language),
      });

  const actionDisabled = disabled || suggestedCount === 0;
  const actionLabel =
    suggestedCount === 0
      ? t("systools.duplicates.group.protected")
      : applied
        ? t("systools.duplicates.group.selected", { count: suggestedCount })
        : t("systools.duplicates.group.select", { count: suggestedCount });
  const actionHint =
    suggestedCount === 0
      ? t("systools.duplicates.group.protectedHint")
      : applied
        ? t("systools.duplicates.group.clearHint")
        : t("systools.duplicates.group.selectHint");

  return (
    <div
      role="button"
      tabIndex={0}
      aria-expanded={expanded}
      onClick={onToggleExpanded}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onToggleExpanded();
        }
      }}
      className="hover:bg-muted/40 focus-visible:bg-muted/40 flex h-full w-full cursor-pointer items-center gap-2 rounded-md px-2 transition-colors outline-none"
    >
      <span className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-md">
        {isDirectory ? <Folder className="size-4" /> : <File className="size-4" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-xs font-medium" title={label}>
            {label || group.hash.slice(0, 8)}
          </span>
          <Badge variant="outline" className="shrink-0 text-[10px] leading-4">
            {t(`systools.duplicates.group.kinds.${group.kind}`)}
          </Badge>
        </div>
        <div className="text-muted-foreground truncate text-[11px]">{summary}</div>
      </div>

      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="shrink-0"
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <Button
              variant="ghost"
              size="xs"
              disabled={actionDisabled}
              aria-label={`${actionLabel}. ${actionHint}`}
              onClick={(event) => {
                event.stopPropagation();
                onToggleSelection();
              }}
              className={cn("text-muted-foreground", applied && "text-primary")}
            >
              {suggestedCount === 0 ? (
                <Lock className="size-3.5" />
              ) : applied ? (
                <Check className="size-3.5" />
              ) : (
                <Copy className="size-3.5" />
              )}
              <span className="hidden sm:inline">{actionLabel}</span>
            </Button>
          </span>
        </TooltipTrigger>
        <TooltipContent>{actionHint}</TooltipContent>
      </Tooltip>

      <ChevronDown
        className={cn(
          "text-muted-foreground size-4 shrink-0 transition-transform",
          expanded && "rotate-180"
        )}
      />
    </div>
  );
}

type DuplicateEntryRowProps = {
  entry: DuplicateFileEntry;
  selected: boolean;
  disabled: boolean;
  /** Blocks row actions while a scan or delete runs. */
  actionsDisabled: boolean;
  /** Human-readable reason shown when the copy cannot be selected. */
  disabledReason: string | null;
  onToggle: () => void;
  onOpen: () => void;
  onReveal: () => void;
  onDelete: () => void;
};

/** One copy inside a group. Protected copies can never be selected or deleted. */
export function DuplicateEntryRow({
  entry,
  selected,
  disabled,
  actionsDisabled,
  disabledReason,
  onToggle,
  onOpen,
  onReveal,
  onDelete,
}: DuplicateEntryRowProps) {
  const { t, language } = useAppTranslation();
  const modified = formatModifiedDate(entry.modifiedAtMs, language);
  const isProtected = entry.deletePolicy === "protected";

  return (
    <FileEntryContextMenu
      entryKey={entry.path}
      openDisabled={actionsDisabled}
      deleteDisabled={actionsDisabled || isProtected}
      onOpen={onOpen}
      onReveal={onReveal}
      onDelete={onDelete}
    >
      <div
        className={cn(
          "hover:bg-muted/30 grid h-full grid-cols-[16px_minmax(0,1fr)_auto_24px] items-center gap-2 rounded-md pr-1 pl-9 transition-colors",
          selected && "bg-accent/40 hover:bg-accent/50"
        )}
      >
        <span
          className="flex items-center justify-center"
          onClick={(event) => event.stopPropagation()}
        >
          {disabledReason ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <span
                  tabIndex={0}
                  className="focus-visible:ring-ring/50 inline-flex rounded-sm focus-visible:ring-[3px]"
                >
                  <SelectionCheckbox
                    checked={selected}
                    disabled={disabled}
                    aria-label={entry.path}
                    onCheckedChange={() => onToggle()}
                  />
                </span>
              </TooltipTrigger>
              <TooltipContent>{disabledReason}</TooltipContent>
            </Tooltip>
          ) : (
            <SelectionCheckbox
              checked={selected}
              disabled={disabled}
              aria-label={entry.path}
              onCheckedChange={() => onToggle()}
            />
          )}
        </span>

        <div className="flex min-w-0 items-center gap-1.5">
          {isProtected && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Lock className="text-muted-foreground size-3 shrink-0" />
              </TooltipTrigger>
              <TooltipContent>{t("systools.duplicates.entry.protected")}</TooltipContent>
            </Tooltip>
          )}
          <span className="truncate text-xs" title={entry.path}>
            {entry.path}
          </span>
        </div>

        <span
          className="text-muted-foreground hidden w-[104px] shrink-0 text-right text-[10px] tabular-nums sm:block"
          title={modified}
        >
          {modified}
        </span>

        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={t("systools.duplicates.entry.reveal")}
              onClick={(event) => {
                event.stopPropagation();
                onReveal();
              }}
            >
              <FolderOpen className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent>{t("systools.duplicates.entry.reveal")}</TooltipContent>
        </Tooltip>
      </div>
    </FileEntryContextMenu>
  );
}
