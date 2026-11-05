import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, ListTree } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  entryChartColor,
  samePath,
  sortAnalysisEntries,
  type AnalysisDirectoryListing,
  type AnalysisRemainderSelection,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes, formatCount, formatShare } from "@/lib/systools/format";
import { cn } from "@/lib/utils";
import { FileEntryContextMenu } from "../components/file-entry-context-menu";
import { listingRemainderSelection } from "./layout";
import { AnalysisEntryIcon } from "./entry-icon";

const ROW_HEIGHT = 30;

type FolderPaneProps = {
  listing: AnalysisDirectoryListing;
  selectedPath: string | null;
  disabled: boolean;
  onActivate: (entry: DirectoryEntryInfo) => void;
  onShowRemainder: (selection: AnalysisRemainderSelection) => void;
  onOpen: (entry: DirectoryEntryInfo) => void;
  onReveal: (entry: DirectoryEntryInfo) => void;
  onDelete: (entry: DirectoryEntryInfo) => void;
};

/** Ranked direct children of the browsed folder with proportional size bars. */
export function FolderPane({
  listing,
  selectedPath,
  disabled,
  onActivate,
  onShowRemainder,
  onOpen,
  onReveal,
  onDelete,
}: FolderPaneProps) {
  const { t, language } = useAppTranslation();
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const entries = useMemo(() => sortAnalysisEntries(listing.entries, "bytes", "desc"), [listing]);
  const remainder = useMemo(() => listingRemainderSelection(listing), [listing]);
  const totalBytes = Math.max(1, listing.bytes);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => entries[index].path,
    overscan: 8,
  });

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: 0 });
  }, [listing.path]);

  return (
    <div className="flex h-full min-h-0 flex-col" data-slot="analysis-folder-pane">
      <div className="text-muted-foreground flex shrink-0 items-center gap-1.5 border-b px-3 py-1.5 text-[11px]">
        <ListTree className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          {t("systools.analysis.folderSpaceSummary", {
            size: formatBytes(listing.bytes, language),
            count: listing.totalEntryCount,
          })}
        </span>
        {remainder ? (
          <Button
            variant="ghost"
            size="xs"
            className="h-6 shrink-0 px-1.5 text-[11px]"
            onClick={() => onShowRemainder(remainder)}
          >
            {t("systools.analysis.other")}
            <ChevronRight className="size-3" />
          </Button>
        ) : null}
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto px-1 py-0.5">
        <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            const selected = Boolean(selectedPath && samePath(entry.path, selectedPath));
            const share = Math.min(1, entry.bytes / totalBytes);
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
                  <button
                    type="button"
                    className={cn(
                      "hover:bg-muted/60 relative flex w-full items-center gap-1.5 overflow-hidden rounded-md px-2 text-left",
                      selected && "bg-primary/10"
                    )}
                    style={{ height: ROW_HEIGHT }}
                    title={entry.path}
                    onClick={() => onActivate(entry)}
                    disabled={disabled}
                  >
                    <span
                      aria-hidden="true"
                      className="absolute bottom-0 left-0 h-[2px] rounded-full"
                      style={{
                        width: `${share * 100}%`,
                        backgroundColor: entryChartColor(entry),
                        opacity: 0.55,
                      }}
                    />
                    <AnalysisEntryIcon entry={entry} />
                    <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
                    <span className="text-muted-foreground text-[10px] tabular-nums">
                      {formatShare(entry.bytes, listing.bytes, language)}
                    </span>
                    <span className="w-16 shrink-0 text-right text-[11px] font-medium tabular-nums">
                      {formatBytes(entry.bytes, language)}
                    </span>
                    {entry.isDirectory ? (
                      <ChevronRight
                        className="text-muted-foreground size-3 shrink-0"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="w-3 shrink-0" />
                    )}
                  </button>
                </FileEntryContextMenu>
              </div>
            );
          })}
        </div>
      </div>

      {listing.truncated ? (
        <button
          type="button"
          className="text-muted-foreground hover:text-foreground shrink-0 border-t px-3 py-1.5 text-[11px]"
          onClick={() => {
            if (remainder) onShowRemainder(remainder);
          }}
          disabled={!remainder || disabled}
        >
          {t("systools.analysis.folderTruncated", {
            visible: formatCount(listing.entries.length, language),
            total: formatCount(listing.totalEntryCount, language),
          })}
        </button>
      ) : null}
    </div>
  );
}
