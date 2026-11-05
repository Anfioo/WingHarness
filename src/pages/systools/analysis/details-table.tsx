import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ArrowDown, ArrowUp, ChevronsUpDown, FolderOpen, ShieldAlert, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  fileExtension,
  type AnalysisDirectoryListing,
  type AnalysisSelectionSummary,
  type AnalysisSortDirection,
  type AnalysisSortKey,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes, formatCount, formatModifiedDate } from "@/lib/systools/format";
import { cn } from "@/lib/utils";
import { SelectionCheckbox } from "../components/common/selection-checkbox";
import { FileEntryContextMenu } from "../components/file-entry-context-menu";
import { AnalysisEntryIcon } from "./entry-icon";

const ROW_HEIGHT = 36;

const GRID_COLUMNS = "grid-cols-[20px_minmax(0,1.7fr)_minmax(0,1.1fr)_76px_56px_92px_104px_56px]";

type DetailsTableProps = {
  listing: AnalysisDirectoryListing;
  entries: DirectoryEntryInfo[];
  sortKey: AnalysisSortKey;
  sortDirection: AnalysisSortDirection;
  selectedPaths: ReadonlySet<string>;
  selection: AnalysisSelectionSummary;
  allSelected: boolean;
  partiallySelected: boolean;
  disabled: boolean;
  onSort: (key: AnalysisSortKey) => void;
  onToggle: (path: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onClearSelection: () => void;
  onActivate: (entry: DirectoryEntryInfo) => void;
  onOpen: (entry: DirectoryEntryInfo) => void;
  onReveal: (entry: DirectoryEntryInfo) => void;
  onDelete: (entry: DirectoryEntryInfo) => void;
  onDeleteSelected: () => void;
};

type SortHeaderProps = {
  label: string;
  sortKey: AnalysisSortKey;
  activeKey: AnalysisSortKey;
  direction: AnalysisSortDirection;
  align?: "left" | "right";
  onSort: (key: AnalysisSortKey) => void;
};

function SortHeader({
  label,
  sortKey,
  activeKey,
  direction,
  align = "left",
  onSort,
}: SortHeaderProps) {
  const active = activeKey === sortKey;
  const Icon = active ? (direction === "asc" ? ArrowUp : ArrowDown) : ChevronsUpDown;
  return (
    <button
      type="button"
      className={cn(
        "hover:text-foreground flex min-w-0 items-center gap-0.5",
        align === "right" && "justify-end"
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className="truncate">{label}</span>
      <Icon className={cn("size-3 shrink-0", !active && "opacity-40")} aria-hidden="true" />
    </button>
  );
}

/** Virtualized detail table for the current folder, with batch selection. */
export function DetailsTable({
  listing,
  entries,
  sortKey,
  sortDirection,
  selectedPaths,
  selection,
  allSelected,
  partiallySelected,
  disabled,
  onSort,
  onToggle,
  onToggleAll,
  onClearSelection,
  onActivate,
  onOpen,
  onReveal,
  onDelete,
  onDeleteSelected,
}: DetailsTableProps) {
  const { t, language } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => entries[index].path,
    overscan: 10,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [listing.path, sortKey, sortDirection]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="analysis-details-table">
      {selection.count > 0 ? (
        <div className="bg-muted/40 flex shrink-0 items-center gap-2 border-b px-3 py-1 text-[11px]">
          <span className="min-w-0 flex-1 truncate">
            {t("systools.analysis.selection.summary", {
              count: selection.count,
              size: formatBytes(selection.bytes, language),
            })}
            {selection.protectedCount > 0 ? (
              <span className="text-muted-foreground">
                {" · "}
                {t("systools.analysis.selection.protected", {
                  count: selection.protectedCount,
                })}
              </span>
            ) : null}
          </span>
          <Button variant="ghost" size="xs" onClick={onClearSelection} disabled={disabled}>
            {t("systools.analysis.selection.clear")}
          </Button>
          <Button variant="destructive" size="xs" onClick={onDeleteSelected} disabled={disabled}>
            <Trash2 className="size-3" />
            {t("systools.analysis.deleteSelected")}
          </Button>
        </div>
      ) : null}

      <div
        className={cn(
          "text-muted-foreground grid h-7 shrink-0 items-center gap-2 border-b px-2 text-[11px]",
          GRID_COLUMNS
        )}
      >
        <SelectionCheckbox
          checked={allSelected}
          indeterminate={partiallySelected}
          onCheckedChange={(checked) => onToggleAll(checked === true)}
          aria-label={t("systools.analysis.selection.selectAll")}
          disabled={disabled || entries.length === 0}
        />
        <SortHeader
          label={t("systools.analysis.columns.name")}
          sortKey="name"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
        />
        <span className="truncate">{t("systools.analysis.columns.path")}</span>
        <SortHeader
          label={t("systools.analysis.columns.size")}
          sortKey="bytes"
          activeKey={sortKey}
          direction={sortDirection}
          align="right"
          onSort={onSort}
        />
        <SortHeader
          label={t("systools.analysis.columns.files")}
          sortKey="fileCount"
          activeKey={sortKey}
          direction={sortDirection}
          align="right"
          onSort={onSort}
        />
        <SortHeader
          label={t("systools.analysis.columns.typeModified")}
          sortKey="modified"
          activeKey={sortKey}
          direction={sortDirection}
          onSort={onSort}
        />
        <span className="truncate">{t("systools.analysis.columns.protection")}</span>
        <span className="sr-only">{t("systools.analysis.columns.actions")}</span>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1 py-0.5">
        {entries.length === 0 ? (
          <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
            {t("systools.analysis.emptyFolder")}
          </div>
        ) : (
          <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = entries[item.index];
              const selected = selectedPaths.has(entry.path);
              const active = selectedPaths.size > 0;
              return (
                <div
                  key={item.key}
                  className="absolute top-0 left-0 w-full"
                  style={{ transform: `translateY(${item.start}px)` }}
                >
                  <FileEntryContextMenu
                    entryKey={entry.path}
                    openDisabled={disabled}
                    revealDisabled={disabled}
                    deleteDisabled={disabled || Boolean(entry.deletionProtection)}
                    onOpen={() => onOpen(entry)}
                    onReveal={() => onReveal(entry)}
                    onDelete={() => onDelete(entry)}
                  >
                    <div
                      className={cn(
                        "group hover:bg-muted/50 grid items-center gap-2 rounded-md px-1",
                        GRID_COLUMNS,
                        selected && "bg-primary/5"
                      )}
                      style={{ height: ROW_HEIGHT }}
                    >
                      <SelectionCheckbox
                        checked={selected}
                        onCheckedChange={(checked) => onToggle(entry.path, checked === true)}
                        aria-label={entry.name}
                        disabled={disabled}
                      />

                      <div className="flex min-w-0 items-center gap-1.5">
                        <AnalysisEntryIcon entry={entry} />
                        <button
                          type="button"
                          className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
                          title={entry.path}
                          onClick={() => onActivate(entry)}
                          disabled={disabled}
                        >
                          {entry.name}
                        </button>
                      </div>

                      <span
                        className="text-muted-foreground min-w-0 truncate text-[11px]"
                        title={entry.path}
                      >
                        {entry.path}
                      </span>

                      <span className="text-right text-xs font-medium tabular-nums">
                        {formatBytes(entry.bytes, language)}
                      </span>

                      <span className="text-muted-foreground text-right text-[11px] tabular-nums">
                        {entry.isDirectory ? formatCount(entry.fileCount, language) : "-"}
                      </span>

                      <div className="flex min-w-0 flex-col leading-tight">
                        <span className="truncate text-[11px]">
                          {entry.isDirectory
                            ? t("systools.analysis.fileType.folder")
                            : fileExtension(entry.name).toLocaleUpperCase() ||
                              t("systools.analysis.fileType.file")}
                        </span>
                        <span className="text-muted-foreground truncate text-[10px] tabular-nums">
                          {entry.isDirectory
                            ? "-"
                            : formatModifiedDate(entry.modifiedAtMs, language)}
                        </span>
                      </div>

                      <span className="min-w-0 truncate">
                        {entry.deletionProtection ? (
                          <Badge variant="outline" className="gap-1 text-[10px] font-normal">
                            <ShieldAlert className="size-3" aria-hidden="true" />
                            {t(
                              entry.deletionProtection === "systemManagedFile"
                                ? "systools.analysis.protection.systemManagedFile"
                                : "systools.analysis.protection.protectedPath"
                            )}
                          </Badge>
                        ) : (
                          <span className="text-muted-foreground text-[11px]">-</span>
                        )}
                      </span>

                      <div
                        className={cn(
                          "flex items-center justify-end gap-0.5 transition-opacity",
                          active
                            ? "opacity-100"
                            : "opacity-0 group-focus-within:opacity-100 group-hover:opacity-100"
                        )}
                      >
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("systools.analysis.reveal")}
                          title={t("systools.analysis.reveal")}
                          onClick={() => onReveal(entry)}
                          disabled={disabled}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-destructive hover:text-destructive"
                          aria-label={t("systools.analysis.delete.action")}
                          title={t("systools.analysis.delete.action")}
                          onClick={() => onDelete(entry)}
                          disabled={disabled}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>
                  </FileEntryContextMenu>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
