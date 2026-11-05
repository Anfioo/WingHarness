import { useEffect, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { File, FolderOpen, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  LARGE_FILE_ROW_HEIGHT,
  type LargeFileEntry,
  type LargeFileSelectionSummary,
} from "@/lib/systools/large-files";
import { formatBytes, formatModifiedDate } from "@/lib/systools/format";
import { cn } from "@/lib/utils";
import { FileEntryContextMenu } from "../file-entry-context-menu";
import { SelectionCheckbox } from "../common/selection-checkbox";

type LargeFileListProps = {
  entries: LargeFileEntry[];
  selectedPaths: ReadonlySet<string>;
  selection: LargeFileSelectionSummary;
  /** Blocks row actions while a scan, filter, or delete runs. */
  disabled: boolean;
  /** Changes whenever the threshold or sort changes so the list scrolls back up. */
  resetKey: string;
  language?: string;
  onToggle: (path: string, selected: boolean) => void;
  onToggleAll: (selected: boolean) => void;
  onOpen: (entry: LargeFileEntry) => void;
  onReveal: (entry: LargeFileEntry) => void;
  onDelete: (entry: LargeFileEntry) => void;
};

const GRID_COLUMNS = "grid-cols-[20px_minmax(0,1.5fr)_minmax(0,1fr)_88px_84px]";

/** Virtualized large-file table; rows keep a fixed height so scrolling stays cheap. */
export function LargeFileList({
  entries,
  selectedPaths,
  selection,
  disabled,
  resetKey,
  language,
  onToggle,
  onToggleAll,
  onOpen,
  onReveal,
  onDelete,
}: LargeFileListProps) {
  const { t } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => LARGE_FILE_ROW_HEIGHT,
    getItemKey: (index) => entries[index].path,
    overscan: 10,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [resetKey]);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        className={cn(
          "text-muted-foreground grid h-7 shrink-0 items-center gap-2 border-b px-3 text-[11px]",
          GRID_COLUMNS
        )}
      >
        <SelectionCheckbox
          checked={selection.allSelected}
          indeterminate={selection.partiallySelected}
          onCheckedChange={(checked) => onToggleAll(checked === true)}
          aria-label={t("systools.largeFiles.list.selectAll")}
          disabled={disabled || entries.length === 0}
        />
        <span className="truncate">{t("systools.largeFiles.list.name")}</span>
        <span className="truncate">{t("systools.largeFiles.list.location")}</span>
        <span className="text-right">{t("systools.largeFiles.list.size")}</span>
        <span className="text-right">{t("systools.largeFiles.list.modified")}</span>
      </div>

      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-auto px-1"
        aria-busy={disabled}
        data-slot="large-file-scroll"
      >
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            const selected = selectedPaths.has(entry.path);
            return (
              <div
                key={item.key}
                className="absolute top-0 left-0 w-full"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <FileEntryContextMenu
                  entryKey={entry.path}
                  openDisabled={disabled}
                  deleteDisabled={disabled}
                  onOpen={() => onOpen(entry)}
                  onReveal={() => onReveal(entry)}
                  onDelete={() => onDelete(entry)}
                >
                  <div
                    className={cn(
                      "group hover:bg-muted/50 grid items-center gap-2 rounded-md px-2",
                      GRID_COLUMNS,
                      selected && "bg-primary/5"
                    )}
                    style={{ height: LARGE_FILE_ROW_HEIGHT }}
                  >
                    <SelectionCheckbox
                      checked={selected}
                      onCheckedChange={(checked) => onToggle(entry.path, checked === true)}
                      aria-label={entry.name}
                      disabled={disabled}
                    />

                    <div className="flex min-w-0 items-center gap-1.5">
                      <File
                        className="text-muted-foreground size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      <button
                        type="button"
                        className="min-w-0 flex-1 truncate text-left text-xs font-medium hover:underline"
                        title={entry.path}
                        onClick={() => onToggle(entry.path, !selected)}
                      >
                        {entry.name}
                      </button>
                      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          aria-label={t("systools.largeFiles.list.reveal")}
                          title={t("systools.largeFiles.list.reveal")}
                          onClick={() => onReveal(entry)}
                          disabled={disabled}
                        >
                          <FolderOpen className="size-3.5" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          className="text-destructive hover:text-destructive"
                          aria-label={t("systools.largeFiles.list.delete")}
                          title={t("systools.largeFiles.list.delete")}
                          onClick={() => onDelete(entry)}
                          disabled={disabled}
                        >
                          <Trash2 className="size-3.5" />
                        </Button>
                      </div>
                    </div>

                    <button
                      type="button"
                      className="text-muted-foreground hover:text-foreground min-w-0 truncate text-left text-[11px]"
                      title={entry.parentPath}
                      onClick={() => onReveal(entry)}
                    >
                      {entry.parentPath}
                    </button>

                    <span className="text-right text-xs font-medium tabular-nums">
                      {formatBytes(entry.bytes, language)}
                    </span>

                    <span
                      className="text-muted-foreground truncate text-right text-[11px] tabular-nums"
                      title={formatModifiedDate(entry.modifiedAtMs, language)}
                    >
                      {formatModifiedDate(entry.modifiedAtMs, language)}
                    </span>
                  </div>
                </FileEntryContextMenu>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
