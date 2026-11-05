// One pane of the dual-pane view: path bar, toolbar, table, context menu and
// the small create/rename dialogs. All engine calls are delegated upward.

import { useEffect, useMemo, useState, type DragEvent, type ReactNode } from "react";
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  File,
  FileText,
  Folder,
  FolderPlus,
  Link2,
  Loader2,
  RefreshCw,
  Trash2,
  Upload,
} from "lucide-react";
import type { SftpEntry } from "@/commands/services/servers/types";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { errorText, formatBytes, formatPermissions } from "@/lib/servers/format";
import { cn } from "@/lib/utils";
import { PathBar } from "./path-bar";
import {
  basename,
  canGoUp,
  isTextFile,
  isValidEntryName,
  parentPath,
  parseDragPayload,
} from "./paths";
import type { DirectoryPane } from "./use-directory";
import { SFTP_DRAG_MIME, type DragPayload, type Side, type SortKey, type SortState } from "./types";

export type FilePaneProps = {
  side: Side;
  pane: DirectoryPane;
  showHidden: boolean;
  initializing: boolean;
  initError: string | null;
  onRetryInit: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onCreateFolder: (name: string) => Promise<void>;
  onRename: (entry: SftpEntry, name: string) => Promise<void>;
  onDelete: (entries: SftpEntry[]) => void;
  onOpenEntry: (entry: SftpEntry) => void;
  onUpload: (entries: SftpEntry[]) => void;
  onDownload: (entries: SftpEntry[]) => void;
  onDropTransfer: (payload: DragPayload, targetDir: string) => void;
  onDragStart: (payload: DragPayload) => void;
  onDragEnd: () => void;
  dragSource: Side | null;
};

type SortHeaderProps = {
  label: string;
  sortKey: SortKey;
  sort: SortState;
  align?: "start" | "end";
  onSort: (key: SortKey) => void;
};

function SortHeader({ label, sortKey, sort, align = "start", onSort }: SortHeaderProps) {
  const active = sort.key === sortKey;
  return (
    <button
      type="button"
      className={cn(
        "flex min-w-0 items-center gap-1 text-left",
        align === "end" && "justify-end",
        active ? "text-foreground" : "hover:text-foreground"
      )}
      onClick={() => onSort(sortKey)}
    >
      <span className="truncate">{label}</span>
      {active &&
        (sort.direction === "asc" ? (
          <ArrowUp className="size-3 shrink-0" />
        ) : (
          <ArrowDown className="size-3 shrink-0" />
        ))}
    </button>
  );
}

function PaneNotice({ children }: { children: ReactNode }) {
  return (
    <div className="text-muted-foreground flex h-full min-h-24 flex-col items-center justify-center gap-2 p-6 text-center text-xs">
      {children}
    </div>
  );
}

/** Folders first, then the requested column, matching no engine order in particular. */
function formatTimestamp(seconds: number | null, formatter: Intl.DateTimeFormat): string {
  if (seconds === null || !Number.isFinite(seconds) || seconds <= 0) return "—";
  return formatter.format(new Date(seconds * 1000));
}

export function FilePane({
  side,
  pane,
  showHidden,
  initializing,
  initError,
  onRetryInit,
  onNavigate,
  onRefresh,
  onToggleHidden,
  onCreateFolder,
  onRename,
  onDelete,
  onOpenEntry,
  onUpload,
  onDownload,
  onDropTransfer,
  onDragStart,
  onDragEnd,
  dragSource,
}: FilePaneProps) {
  const { t, language } = useAppTranslation();

  const [menuTarget, setMenuTarget] = useState<SftpEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  const [folderOpen, setFolderOpen] = useState(false);
  const [folderName, setFolderName] = useState("");
  const [folderError, setFolderError] = useState<string | null>(null);
  const [folderBusy, setFolderBusy] = useState(false);

  const [renameTarget, setRenameTarget] = useState<SftpEntry | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  const [renameBusy, setRenameBusy] = useState(false);

  const acceptsDrop = dragSource !== null && dragSource !== side;
  const remote = side === "remote";

  const columns = useMemo(
    () => (remote ? "minmax(0,1fr) 88px 148px 104px" : "minmax(0,1fr) 88px 148px"),
    [remote]
  );

  const dateFormatter = useMemo(
    () =>
      new Intl.DateTimeFormat(language, {
        dateStyle: "short",
        timeStyle: "short",
      }),
    [language]
  );

  const selectedEntries = useMemo(
    () => pane.entries.filter((entry) => pane.selection.has(entry.path)),
    [pane.entries, pane.selection]
  );

  const menuEntries = useMemo(() => {
    if (!menuTarget) return [];
    if (pane.selection.has(menuTarget.path)) return selectedEntries;
    return [menuTarget];
  }, [menuTarget, pane.selection, selectedEntries]);

  useEffect(() => {
    if (dragSource === null) setDropTarget(null);
  }, [dragSource]);

  const openEntry = (entry: SftpEntry) => {
    if (entry.kind === "dir") onNavigate(entry.path);
    else onOpenEntry(entry);
  };

  const openFolderDialog = () => {
    setFolderName("");
    setFolderError(null);
    setFolderOpen(true);
  };

  const submitFolder = async () => {
    const name = folderName.trim();
    if (!isValidEntryName(side, name)) {
      setFolderError(
        t("servers.sftp.invalidName", {
          defaultValue: "Enter a valid name without path separators.",
        })
      );
      return;
    }
    setFolderBusy(true);
    setFolderError(null);
    try {
      await onCreateFolder(name);
      setFolderOpen(false);
    } catch (error) {
      setFolderError(errorText(error));
    } finally {
      setFolderBusy(false);
    }
  };

  const openRenameDialog = (entry: SftpEntry) => {
    setRenameTarget(entry);
    setRenameDraft(entry.name);
    setRenameError(null);
  };

  const submitRename = async () => {
    if (!renameTarget) return;
    const name = renameDraft.trim();
    if (!isValidEntryName(side, name)) {
      setRenameError(
        t("servers.sftp.invalidName", {
          defaultValue: "Enter a valid name without path separators.",
        })
      );
      return;
    }
    if (name === renameTarget.name) {
      setRenameTarget(null);
      return;
    }
    setRenameBusy(true);
    setRenameError(null);
    try {
      await onRename(renameTarget, name);
      setRenameTarget(null);
    } catch (error) {
      setRenameError(errorText(error));
    } finally {
      setRenameBusy(false);
    }
  };

  const handleRowDragStart = (event: DragEvent<HTMLDivElement>, entry: SftpEntry) => {
    if (!pane.selection.has(entry.path)) pane.selectOnly(entry);
    const paths = pane.selection.has(entry.path)
      ? pane.entries.filter((item) => pane.selection.has(item.path)).map((item) => item.path)
      : [entry.path];
    const payload: DragPayload = { side, paths };
    event.dataTransfer.setData(SFTP_DRAG_MIME, JSON.stringify(payload));
    event.dataTransfer.effectAllowed = "copy";
    onDragStart(payload);
  };

  const handlePaneDragOver = (event: DragEvent<HTMLElement>) => {
    if (!acceptsDrop) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setDropTarget(pane.path);
  };

  const handlePaneDragLeave = (event: DragEvent<HTMLElement>) => {
    const next = event.relatedTarget as Node | null;
    if (!next || !event.currentTarget.contains(next)) setDropTarget(null);
  };

  const handlePaneDrop = (event: DragEvent<HTMLElement>) => {
    if (!acceptsDrop) return;
    event.preventDefault();
    const payload = parseDragPayload(event.dataTransfer.getData(SFTP_DRAG_MIME));
    const target = dropTarget ?? pane.path;
    setDropTarget(null);
    if (!payload || payload.side === side) return;
    onDropTransfer(payload, target);
  };

  const iconFor = (entry: SftpEntry) => {
    if (entry.kind === "dir") return <Folder className="text-primary size-3.5 shrink-0" />;
    if (entry.isSymlink) return <Link2 className="text-muted-foreground size-3.5 shrink-0" />;
    if (isTextFile(entry.name)) {
      return <FileText className="text-muted-foreground size-3.5 shrink-0" />;
    }
    return <File className="text-muted-foreground size-3.5 shrink-0" />;
  };

  const body = (() => {
    if (initError) {
      return (
        <PaneNotice>
          <AlertCircle className="text-destructive size-5" />
          <p className="max-w-72 break-words">{initError}</p>
          <Button size="xs" variant="outline" onClick={onRetryInit}>
            {t("servers.sftp.retry", { defaultValue: "Retry" })}
          </Button>
        </PaneNotice>
      );
    }

    if (initializing && !pane.path) {
      return (
        <PaneNotice>
          <Loader2 className="size-5 animate-spin" />
        </PaneNotice>
      );
    }

    if (pane.tooManyLimit !== null) {
      return (
        <PaneNotice>
          <Folder className="size-5" />
          <p>
            {t("servers.sftp.tooMany", {
              limit: pane.tooManyLimit,
              defaultValue: "This folder has more than {{limit}} entries.",
            })}
          </p>
          <p>
            {t("servers.sftp.tooManyHint", {
              defaultValue: "Type a more specific path in the path bar to open a subfolder.",
            })}
          </p>
        </PaneNotice>
      );
    }

    if (pane.error) {
      return (
        <PaneNotice>
          <AlertCircle className="text-destructive size-5" />
          <p className="max-w-72 break-words">{pane.error}</p>
          <Button size="xs" variant="outline" onClick={onRefresh}>
            {t("servers.sftp.retry", { defaultValue: "Retry" })}
          </Button>
        </PaneNotice>
      );
    }

    if (pane.loading && pane.entries.length === 0) {
      return (
        <PaneNotice>
          <Loader2 className="size-5 animate-spin" />
        </PaneNotice>
      );
    }

    if (pane.entries.length === 0) {
      return (
        <PaneNotice>
          <Folder className="size-5" />
          <p>{t("servers.sftp.emptyFolder", { defaultValue: "This folder is empty." })}</p>
        </PaneNotice>
      );
    }

    return (
      <div className="min-h-0 flex-1 overflow-auto">
        <div
          className="bg-muted/80 text-muted-foreground border-border sticky top-0 z-10 grid items-center gap-2 border-b px-2 py-1.5 text-xs font-medium"
          style={{ gridTemplateColumns: columns }}
        >
          <SortHeader
            label={t("servers.sftp.column.name", { defaultValue: "Name" })}
            sortKey="name"
            sort={pane.sort}
            onSort={pane.setSort}
          />
          <SortHeader
            label={t("servers.sftp.column.size", { defaultValue: "Size" })}
            sortKey="size"
            sort={pane.sort}
            align="end"
            onSort={pane.setSort}
          />
          <SortHeader
            label={t("servers.sftp.column.modified", { defaultValue: "Modified" })}
            sortKey="modifiedAt"
            sort={pane.sort}
            onSort={pane.setSort}
          />
          {remote && (
            <span className="truncate">
              {t("servers.sftp.column.permissions", { defaultValue: "Permissions" })}
            </span>
          )}
        </div>

        {pane.entries.map((entry) => {
          const selected = pane.selection.has(entry.path);
          const rowDrop = dropTarget === entry.path && entry.kind === "dir";
          return (
            <div
              key={entry.path}
              data-sftp-entry
              draggable
              title={entry.path}
              className={cn(
                "border-border/60 grid h-7 cursor-default items-center gap-2 border-b px-2 text-xs last:border-b-0",
                selected ? "bg-primary/10" : "hover:bg-accent/60",
                rowDrop && "ring-primary/60 ring-1 ring-inset"
              )}
              style={{ gridTemplateColumns: columns }}
              onClick={(event) =>
                pane.selectRow(entry, {
                  ctrl: event.ctrlKey || event.metaKey,
                  shift: event.shiftKey,
                })
              }
              onDoubleClick={() => openEntry(entry)}
              onContextMenu={() => {
                if (!pane.selection.has(entry.path)) pane.selectOnly(entry);
                setMenuTarget(entry);
              }}
              onDragStart={(event) => handleRowDragStart(event, entry)}
              onDragEnd={onDragEnd}
              onDragOver={(event) => {
                if (!acceptsDrop) return;
                event.preventDefault();
                event.stopPropagation();
                event.dataTransfer.dropEffect = "copy";
                setDropTarget(entry.kind === "dir" ? entry.path : pane.path);
              }}
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {iconFor(entry)}
                <span className="truncate">{entry.name}</span>
              </div>
              <span className="text-muted-foreground text-right tabular-nums">
                {entry.kind === "dir" ? "—" : formatBytes(entry.size, language)}
              </span>
              <span className="text-muted-foreground truncate tabular-nums">
                {formatTimestamp(entry.modifiedAt, dateFormatter)}
              </span>
              {remote && (
                <span className="text-muted-foreground truncate font-mono">
                  {formatPermissions(entry.permissions)}
                </span>
              )}
            </div>
          );
        })}
      </div>
    );
  })();

  return (
    <section
      className={cn(
        "bg-background flex h-full min-h-0 flex-col gap-1.5 p-2",
        acceptsDrop && "ring-primary/20 ring-1 ring-inset"
      )}
      onDragOver={handlePaneDragOver}
      onDragLeave={handlePaneDragLeave}
      onDrop={handlePaneDrop}
    >
      <div className="flex items-center gap-1.5">
        <span className="bg-muted text-muted-foreground shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium tracking-wide uppercase">
          {t(remote ? "servers.sftp.remote" : "servers.sftp.local")}
        </span>
        <PathBar side={side} path={pane.path} onNavigate={onNavigate} />
      </div>

      <div className="flex items-center gap-0.5">
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.refresh")}
          aria-label={t("servers.sftp.refresh")}
          onClick={onRefresh}
        >
          <RefreshCw className={pane.loading ? "animate-spin" : undefined} />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.up", { defaultValue: "Parent folder" })}
          aria-label={t("servers.sftp.up", { defaultValue: "Parent folder" })}
          disabled={!canGoUp(side, pane.path)}
          onClick={() => onNavigate(parentPath(side, pane.path))}
        >
          <ArrowUp />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.newFolder")}
          aria-label={t("servers.sftp.newFolder")}
          disabled={!pane.path}
          onClick={openFolderDialog}
        >
          <FolderPlus />
        </Button>

        <span className="bg-border mx-1 h-4 w-px" />

        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.upload")}
          aria-label={t("servers.sftp.upload")}
          disabled={side !== "local" || selectedEntries.length === 0}
          onClick={() => onUpload(selectedEntries)}
        >
          <Upload />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.download")}
          aria-label={t("servers.sftp.download")}
          disabled={side !== "remote" || selectedEntries.length === 0}
          onClick={() => onDownload(selectedEntries)}
        >
          <Download />
        </Button>
        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={t("servers.sftp.delete")}
          aria-label={t("servers.sftp.delete")}
          disabled={selectedEntries.length === 0}
          onClick={() => onDelete(selectedEntries)}
        >
          <Trash2 />
        </Button>

        <span className="flex-1" />

        <span className="text-muted-foreground text-[11px] tabular-nums">
          {pane.selection.size > 0
            ? t("servers.sftp.selectedCount", {
                count: pane.selection.size,
                defaultValue: "{{count}} selected",
              })
            : t("servers.sftp.itemCount", {
                count: pane.entries.length,
                defaultValue: "{{count}} items",
              })}
        </span>

        <Button
          type="button"
          size="icon-xs"
          variant="ghost"
          title={showHidden ? t("servers.sftp.hidden.hide") : t("servers.sftp.hidden.show")}
          aria-label={showHidden ? t("servers.sftp.hidden.hide") : t("servers.sftp.hidden.show")}
          aria-pressed={showHidden}
          onClick={onToggleHidden}
        >
          {showHidden ? <EyeOff /> : <Eye />}
        </Button>
      </div>

      <div className="border-border bg-background flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border">
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div
              className="flex min-h-0 flex-1 flex-col"
              onContextMenu={(event) => {
                const element = event.target as HTMLElement | null;
                if (!element?.closest("[data-sftp-entry]")) setMenuTarget(null);
              }}
            >
              {body}
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent
            className="w-48"
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              setMenuTarget(null);
            }}
          >
            <ContextMenuItem
              disabled={menuEntries.length === 0}
              onSelect={() => {
                const entry = menuTarget ?? menuEntries[0];
                if (entry) openEntry(entry);
              }}
            >
              {t("servers.action.open")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={menuEntries.length === 0}
              onSelect={() => {
                if (remote) onDownload(menuEntries);
                else onUpload(menuEntries);
              }}
            >
              {remote ? t("servers.sftp.download") : t("servers.sftp.upload")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={menuEntries.length !== 1}
              onSelect={() => {
                const entry = menuTarget ?? menuEntries[0];
                if (entry) openRenameDialog(entry);
              }}
            >
              {t("servers.sftp.rename")}
            </ContextMenuItem>
            <ContextMenuItem
              disabled={menuEntries.length === 0}
              variant="destructive"
              onSelect={() => onDelete(menuEntries)}
            >
              {t("servers.sftp.delete")}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={onRefresh}>{t("servers.sftp.refresh")}</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>
      </div>

      <Dialog open={folderOpen} onOpenChange={(open) => !folderBusy && setFolderOpen(open)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("servers.sftp.newFolder")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={folderName}
            spellCheck={false}
            placeholder={t("servers.sftp.folderName", { defaultValue: "Folder name" })}
            onChange={(event) => setFolderName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitFolder();
              }
            }}
          />
          {folderError && (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-1.5 text-xs break-words">
              {folderError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={folderBusy} onClick={() => setFolderOpen(false)}>
              {t("servers.form.cancel")}
            </Button>
            <Button disabled={folderBusy} onClick={() => void submitFolder()}>
              {folderBusy ? <Loader2 className="animate-spin" /> : <FolderPlus />}
              {t("servers.sftp.create", { defaultValue: "Create" })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={renameTarget !== null}
        onOpenChange={(open) => !renameBusy && !open && setRenameTarget(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t("servers.sftp.rename")}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={renameDraft}
            spellCheck={false}
            aria-label={t("servers.sftp.rename")}
            onChange={(event) => setRenameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                void submitRename();
              }
            }}
          />
          {renameTarget && (
            <p className="text-muted-foreground truncate font-mono text-xs">
              {basename(renameTarget.path)}
            </p>
          )}
          {renameError && (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-1.5 text-xs break-words">
              {renameError}
            </p>
          )}
          <DialogFooter>
            <Button variant="ghost" disabled={renameBusy} onClick={() => setRenameTarget(null)}>
              {t("servers.form.cancel")}
            </Button>
            <Button disabled={renameBusy} onClick={() => void submitRename()}>
              {renameBusy ? <Loader2 className="animate-spin" /> : null}
              {t("servers.sftp.rename")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}
