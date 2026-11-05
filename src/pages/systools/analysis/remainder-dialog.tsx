import { useCallback, useEffect, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { ChevronRight, FolderOpen, Loader2, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAppTranslation } from "@/hooks/use-app-translation";
import {
  ANALYSIS_REMAINDER_SCHEMA_VERSION,
  analysisErrorKey,
  listAnalysisRemainder,
  releaseAnalysisRemainder,
  type AnalysisRemainderPage,
  type AnalysisRemainderSelection,
  type DirectoryEntryInfo,
} from "@/lib/systools/storage";
import { formatBytes } from "@/lib/systools/format";
import { AnalysisEntryIcon } from "./entry-icon";

const ROW_HEIGHT = 30;

type RemainderDialogProps = {
  open: boolean;
  scanId: number | null;
  selection: AnalysisRemainderSelection | null;
  onOpenChange: (open: boolean) => void;
  onNavigate: (path: string) => void;
  onReveal: (path: string) => void;
};

/** Pages through direct children the bounded result projection omitted. */
export function RemainderDialog({
  open,
  scanId,
  selection,
  onOpenChange,
  onNavigate,
  onReveal,
}: RemainderDialogProps) {
  const { t, language } = useAppTranslation();
  const [page, setPage] = useState<AnalysisRemainderPage | null>(null);
  const [entries, setEntries] = useState<DirectoryEntryInfo[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [errorKey, setErrorKey] = useState<string | null>(null);

  const snapshotRef = useRef<number | null>(null);
  const requestRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const releaseSnapshot = useCallback(() => {
    const snapshotId = snapshotRef.current;
    snapshotRef.current = null;
    if (snapshotId !== null) {
      void releaseAnalysisRemainder(snapshotId).catch(() => undefined);
    }
  }, []);

  const loadPage = useCallback(
    async (offset: number) => {
      if (scanId === null || !selection) return;
      const generation = requestRef.current + 1;
      requestRef.current = generation;
      if (offset === 0) {
        setLoading(true);
        setErrorKey(null);
      } else {
        setLoadingMore(true);
      }

      try {
        const result = await listAnalysisRemainder({
          schemaVersion: ANALYSIS_REMAINDER_SCHEMA_VERSION,
          scanId,
          parentPath: selection.parentPath,
          visiblePaths: selection.visiblePaths,
          expectedBytes: selection.bytes,
          offset,
          snapshotId: offset === 0 ? null : snapshotRef.current,
        });
        if (generation !== requestRef.current) return;
        snapshotRef.current = result.snapshotId;
        setPage(result);
        setEntries((current) => (offset === 0 ? result.entries : [...current, ...result.entries]));
        setNextOffset(result.nextOffset);
        if (offset === 0) scrollRef.current?.scrollTo({ top: 0 });
      } catch (error) {
        if (generation !== requestRef.current) return;
        setErrorKey(analysisErrorKey(error));
      } finally {
        if (generation === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [scanId, selection]
  );

  useEffect(() => {
    if (!open) return;
    releaseSnapshot();
    setPage(null);
    setEntries([]);
    setNextOffset(null);
    void loadPage(0);
  }, [open, loadPage, releaseSnapshot]);

  useEffect(() => {
    if (open) return;
    requestRef.current += 1;
    releaseSnapshot();
    setPage(null);
    setEntries([]);
    setNextOffset(null);
    setErrorKey(null);
    setLoading(false);
    setLoadingMore(false);
  }, [open, releaseSnapshot]);

  useEffect(() => () => releaseSnapshot(), [releaseSnapshot]);

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    getItemKey: (index) => entries[index].path,
    overscan: 8,
  });

  const closeDialog = () => {
    releaseSnapshot();
    requestRef.current += 1;
    onOpenChange(false);
  };

  const activate = (entry: DirectoryEntryInfo) => {
    if (entry.isDirectory) {
      closeDialog();
      onNavigate(entry.path);
    } else {
      onReveal(entry.path);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) onOpenChange(true);
        else closeDialog();
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("systools.analysis.remainder.title")}</DialogTitle>
          <DialogDescription>
            {t("systools.analysis.remainder.description", {
              path: selection?.parentPath ?? page?.parentPath ?? "",
            })}
          </DialogDescription>
        </DialogHeader>

        <div className="text-muted-foreground flex items-center justify-between gap-2 text-[11px]">
          <span className="min-w-0 truncate tabular-nums">
            {t("systools.analysis.remainder.total", {
              count: page?.totalCount ?? 0,
              size: formatBytes(page?.totalBytes ?? selection?.bytes ?? 0, language),
            })}
          </span>
          {nextOffset !== null ? (
            <span className="shrink-0 tabular-nums">
              {t("systools.analysis.remainder.loaded", {
                count: entries.length,
              })}
            </span>
          ) : null}
        </div>

        <div ref={scrollRef} className="h-64 overflow-auto rounded-md border" aria-busy={loading}>
          {loading ? (
            <div className="text-muted-foreground flex h-full items-center justify-center gap-2 text-xs">
              <Loader2 className="size-4 animate-spin" />
              {t("systools.analysis.remainder.loading")}
            </div>
          ) : errorKey ? (
            <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
              <p className="text-muted-foreground text-xs">{t(errorKey)}</p>
              <Button variant="outline" size="xs" onClick={() => void loadPage(0)}>
                <RotateCw className="size-3" />
                {t("systools.analysis.remainder.retry")}
              </Button>
            </div>
          ) : entries.length === 0 ? (
            <div className="text-muted-foreground flex h-full items-center justify-center px-4 text-center text-xs">
              {t("systools.analysis.remainder.empty")}
            </div>
          ) : (
            <div className="relative" style={{ height: virtualizer.getTotalSize() }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index];
                return (
                  <div
                    key={item.key}
                    className="absolute top-0 left-0 w-full"
                    style={{ transform: `translateY(${item.start}px)` }}
                  >
                    <button
                      type="button"
                      className="hover:bg-muted/60 flex w-full items-center gap-1.5 px-2 text-left"
                      style={{ height: ROW_HEIGHT }}
                      title={entry.path}
                      onClick={() => activate(entry)}
                    >
                      <AnalysisEntryIcon entry={entry} />
                      <span className="min-w-0 flex-1 truncate text-xs">{entry.name}</span>
                      <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                        {entry.isDirectory
                          ? t("systools.analysis.folderFileSummary", {
                              count: entry.fileCount,
                            })
                          : null}
                      </span>
                      <span className="w-16 shrink-0 text-right text-[11px] font-medium tabular-nums">
                        {formatBytes(entry.bytes, language)}
                      </span>
                      {entry.isDirectory ? (
                        <ChevronRight className="text-muted-foreground size-3 shrink-0" />
                      ) : (
                        <FolderOpen className="text-muted-foreground size-3 shrink-0" />
                      )}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>
            {t("systools.analysis.close")}
          </Button>
          {nextOffset !== null ? (
            <Button onClick={() => void loadPage(nextOffset)} disabled={loadingMore || loading}>
              {loadingMore ? <Loader2 className="size-4 animate-spin" /> : null}
              {t("systools.analysis.remainder.loadMore")}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
