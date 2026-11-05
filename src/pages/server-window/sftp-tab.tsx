// XFTP tab: local/remote panes, drag transfer, conflict handling and queue.
//
// The window mounts this component per server tab. `active` lets the window
// keep the tab mounted while the remote side only loads on first activation.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { Loader2, Trash2 } from "lucide-react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { toast } from "sonner";
import { openPath } from "@/commands/services/git";
import {
  serverLocalDelete,
  serverLocalHome,
  serverLocalList,
  serverLocalMkdir,
  serverLocalRename,
  serverPrefsGet,
  serverPrefsSet,
  serverSftpDelete,
  serverSftpHome,
  serverSftpList,
  serverSftpMkdir,
  serverSftpReadText,
  serverSftpRename,
  serverTransferCancel,
  serverTransferList,
  serverTransferPause,
  serverTransferResume,
  serverTransferStart,
} from "@/commands/services/servers";
import type {
  ServerPrefs,
  ServerTransferDoneEvent,
  ServerTransferProgressEvent,
  SftpEntry,
  TransferDirection,
  TransferSnapshot,
  TransferState,
} from "@/commands/services/servers/types";
import { ConflictDialog } from "@/components/servers/sftp/conflict-dialog";
import { FilePane } from "@/components/servers/sftp/file-pane";
import { basename, isValidEntryName, isTextFile, joinPath } from "@/components/servers/sftp/paths";
import { TextPreviewDialog } from "@/components/servers/sftp/text-preview-dialog";
import { TransferQueue } from "@/components/servers/sftp/transfer-queue";
import type {
  ConflictChoice,
  ConflictItem,
  DragPayload,
  Side,
} from "@/components/servers/sftp/types";
import { useDirectory } from "@/components/servers/sftp/use-directory";
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
import { errorText, serverErrorCodeKey } from "@/lib/servers/format";

const FINISHED_STATES: ReadonlySet<TransferState> = new Set(["done", "failed", "cancelled"]);

const DEFAULT_PREFS: ServerPrefs = {
  localPanePath: null,
  showHiddenLocal: false,
  showHiddenRemote: false,
  conflictPolicy: "ask",
  maxConcurrentTransfers: 3,
};

export type SftpTabProps = {
  profileId: string;
  /** Load the remote side only once the XFTP segmentation is shown. */
  active?: boolean;
};

type ConflictRequest = {
  items: ConflictItem[];
  defaultChoice: ConflictChoice;
  resolve: (decisions: Map<string, ConflictChoice> | null) => void;
};

type DeleteRequest = { side: Side; entries: SftpEntry[] };

type PreviewState = {
  open: boolean;
  path: string;
  content: string | null;
  loading: boolean;
  error: string | null;
};

const CLOSED_PREVIEW: PreviewState = {
  open: false,
  path: "",
  content: null,
  loading: false,
  error: null,
};

export function SftpTab({ profileId, active = true }: SftpTabProps) {
  const { t } = useAppTranslation();

  const [prefs, setPrefs] = useState<ServerPrefs | null>(null);
  const prefsRef = useRef<ServerPrefs | null>(null);
  const showHiddenRef = useRef({ local: false, remote: false });

  const [localInitializing, setLocalInitializing] = useState(true);
  const [remoteInitializing, setRemoteInitializing] = useState(true);
  const [localInitError, setLocalInitError] = useState<string | null>(null);
  const [remoteInitError, setRemoteInitError] = useState<string | null>(null);
  const initializedRef = useRef(false);

  const [dragSource, setDragSource] = useState<Side | null>(null);
  const [queueOpen, setQueueOpen] = useState(false);
  const [tasks, setTasks] = useState<TransferSnapshot[]>([]);
  const tasksRef = useRef<Record<string, TransferSnapshot>>({});
  const [conflictRequest, setConflictRequest] = useState<ConflictRequest | null>(null);
  const [deleteRequest, setDeleteRequest] = useState<DeleteRequest | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [preview, setPreview] = useState<PreviewState>(CLOSED_PREVIEW);
  const previewTokenRef = useRef(0);

  const localLoader = useCallback(
    (path: string) => serverLocalList(path, showHiddenRef.current.local),
    []
  );
  const remoteLoader = useCallback(
    async (path: string) => {
      const entries = await serverSftpList(profileId, path);
      // The remote listing has no hidden filter; the leading dot is the only
      // portable signal SFTP exposes.
      return showHiddenRef.current.remote
        ? entries
        : entries.filter((entry) => !entry.name.startsWith("."));
    },
    [profileId]
  );

  const localPane = useDirectory(localLoader);
  const remotePane = useDirectory(remoteLoader);
  const { navigate: navigateLocalPane, reload: reloadLocalPane } = localPane;
  const { navigate: navigateRemotePane, reload: reloadRemotePane } = remotePane;
  const localPath = localPane.path;
  const remotePath = remotePane.path;

  const describeError = useCallback(
    (error: unknown) => {
      const key = serverErrorCodeKey(error);
      return key ? t(key, { defaultValue: errorText(error) }) : errorText(error);
    },
    [t]
  );

  const applyPrefs = useCallback((next: ServerPrefs) => {
    prefsRef.current = next;
    showHiddenRef.current = { local: next.showHiddenLocal, remote: next.showHiddenRemote };
    setPrefs(next);
  }, []);

  const updatePrefs = useCallback(
    (patch: Partial<ServerPrefs>) => {
      const next = { ...(prefsRef.current ?? DEFAULT_PREFS), ...patch };
      prefsRef.current = next;
      showHiddenRef.current = { local: next.showHiddenLocal, remote: next.showHiddenRemote };
      setPrefs(next);
      void serverPrefsSet(next).catch((error: unknown) => {
        toast.error(describeError(error));
      });
    },
    [describeError]
  );

  const navigateLocal = useCallback(
    (path: string) => {
      navigateLocalPane(path);
      if (path && path !== prefsRef.current?.localPanePath) {
        updatePrefs({ localPanePath: path });
      }
    },
    [navigateLocalPane, updatePrefs]
  );

  const initialize = useCallback(async () => {
    setLocalInitializing(true);
    setRemoteInitializing(true);

    const [prefsResult, localHome, remoteHome] = await Promise.allSettled([
      serverPrefsGet(),
      serverLocalHome(),
      serverSftpHome(profileId),
    ]);

    if (prefsResult.status === "fulfilled") applyPrefs(prefsResult.value);

    if (localHome.status === "fulfilled") {
      const saved = prefsResult.status === "fulfilled" ? prefsResult.value.localPanePath : null;
      navigateLocal(saved?.trim() ? saved : localHome.value);
    } else {
      setLocalInitError(describeError(localHome.reason));
    }
    setLocalInitializing(false);

    if (remoteHome.status === "fulfilled") {
      navigateRemotePane(remoteHome.value);
    } else {
      setRemoteInitError(describeError(remoteHome.reason));
    }
    setRemoteInitializing(false);
  }, [applyPrefs, describeError, navigateLocal, navigateRemotePane, profileId]);

  useEffect(() => {
    if (!active || initializedRef.current) return;
    initializedRef.current = true;
    void initialize();
  }, [active, initialize]);

  const retryLocal = useCallback(async () => {
    setLocalInitError(null);
    setLocalInitializing(true);
    try {
      const home = await serverLocalHome();
      const saved = prefsRef.current?.localPanePath;
      navigateLocal(saved?.trim() ? saved : home);
    } catch (error) {
      setLocalInitError(describeError(error));
    } finally {
      setLocalInitializing(false);
    }
  }, [describeError, navigateLocal]);

  const retryRemote = useCallback(async () => {
    setRemoteInitError(null);
    setRemoteInitializing(true);
    try {
      navigateRemotePane(await serverSftpHome(profileId));
    } catch (error) {
      setRemoteInitError(describeError(error));
    } finally {
      setRemoteInitializing(false);
    }
  }, [describeError, navigateRemotePane, profileId]);

  const toggleLocalHidden = useCallback(() => {
    updatePrefs({ showHiddenLocal: !showHiddenRef.current.local });
    reloadLocalPane();
  }, [reloadLocalPane, updatePrefs]);

  const toggleRemoteHidden = useCallback(() => {
    updatePrefs({ showHiddenRemote: !showHiddenRef.current.remote });
    reloadRemotePane();
  }, [reloadRemotePane, updatePrefs]);

  // Transfer queue state is keyed so progress events patch one row at a time.
  const commitTasks = useCallback((next: Record<string, TransferSnapshot>) => {
    tasksRef.current = next;
    setTasks(Object.values(next));
  }, []);

  const refreshTransfers = useCallback(async () => {
    try {
      const list = await serverTransferList();
      const next: Record<string, TransferSnapshot> = {};
      for (const task of list) next[task.transferId] = task;
      commitTasks(next);
    } catch {
      // The queue backend may still be a stub; running transfers then only
      // show what the progress events carry.
    }
  }, [commitTasks]);

  const reloadRef = useRef({ local: reloadLocalPane, remote: reloadRemotePane });
  reloadRef.current = { local: reloadLocalPane, remote: reloadRemotePane };

  const reloadTimerRef = useRef<number | null>(null);
  const schedulePaneReload = useCallback(() => {
    if (reloadTimerRef.current !== null) return;
    reloadTimerRef.current = window.setTimeout(() => {
      reloadTimerRef.current = null;
      reloadRef.current.local();
      reloadRef.current.remote();
    }, 300);
  }, []);

  const refreshTimerRef = useRef<number | null>(null);
  const scheduleRefresh = useCallback(() => {
    if (refreshTimerRef.current !== null) return;
    refreshTimerRef.current = window.setTimeout(() => {
      refreshTimerRef.current = null;
      void refreshTransfers();
    }, 400);
  }, [refreshTransfers]);

  useEffect(() => {
    let disposed = false;
    let unlistenProgress: UnlistenFn | null = null;
    let unlistenDone: UnlistenFn | null = null;

    const setup = async () => {
      unlistenProgress = await listen<ServerTransferProgressEvent>(
        "server:transfer-progress",
        (event) => {
          const payload = event.payload;
          const existing = tasksRef.current[payload.transferId];
          if (!existing) {
            scheduleRefresh();
            return;
          }
          commitTasks({
            ...tasksRef.current,
            [payload.transferId]: {
              ...existing,
              transferred: payload.transferred,
              total: payload.total,
              bytesPerSec: payload.bytesPerSec,
              state: payload.state,
            },
          });
        }
      );
      if (disposed) {
        unlistenProgress();
        return;
      }

      unlistenDone = await listen<ServerTransferDoneEvent>("server:transfer-done", (event) => {
        const payload = event.payload;
        const existing = tasksRef.current[payload.transferId];
        if (existing) {
          commitTasks({
            ...tasksRef.current,
            [payload.transferId]: {
              ...existing,
              state: payload.state,
              error: payload.error ?? existing.error,
              bytesPerSec: 0,
            },
          });
        } else {
          scheduleRefresh();
        }
        schedulePaneReload();
      });
      if (disposed) {
        unlistenDone();
        return;
      }

      void refreshTransfers();
    };

    void setup();

    return () => {
      disposed = true;
      unlistenProgress?.();
      unlistenDone?.();
    };
  }, [commitTasks, refreshTransfers, schedulePaneReload, scheduleRefresh]);

  useEffect(
    () => () => {
      if (reloadTimerRef.current !== null) window.clearTimeout(reloadTimerRef.current);
      if (refreshTimerRef.current !== null) window.clearTimeout(refreshTimerRef.current);
    },
    []
  );

  const defaultConflictChoice = useCallback((): ConflictChoice => {
    const policy = prefsRef.current?.conflictPolicy;
    return policy === "skip" || policy === "rename" || policy === "overwrite"
      ? policy
      : "overwrite";
  }, []);

  const askConflicts = useCallback(
    (sources: string[]) =>
      new Promise<Map<string, ConflictChoice> | null>((resolve) => {
        setConflictRequest({
          items: sources.map((source) => ({ source, name: basename(source) })),
          defaultChoice: defaultConflictChoice(),
          resolve,
        });
      }),
    [defaultConflictChoice]
  );

  const resolveConflicts = useCallback(
    (decisions: Map<string, ConflictChoice>) => {
      conflictRequest?.resolve(decisions);
      setConflictRequest(null);
    },
    [conflictRequest]
  );

  const cancelConflicts = useCallback(() => {
    conflictRequest?.resolve(null);
    setConflictRequest(null);
  }, [conflictRequest]);

  const findConflicts = useCallback(
    async (direction: TransferDirection, sources: string[], targetDir: string) => {
      const names = new Set<string>();
      if (direction === "upload") {
        for (const entry of await serverSftpList(profileId, targetDir)) names.add(entry.name);
      } else {
        for (const entry of await serverLocalList(targetDir, true)) names.add(entry.name);
      }
      return sources.filter((source) => names.has(basename(source)));
    },
    [profileId]
  );

  const startTransfer = useCallback(
    async (direction: TransferDirection, sources: string[], targetDir: string) => {
      if (!sources.length || !targetDir) return;
      try {
        const conflicts = await findConflicts(direction, sources, targetDir);
        let decisions: Map<string, ConflictChoice> | null = null;
        if (conflicts.length > 0) {
          decisions = await askConflicts(conflicts);
          if (!decisions) return;
        }

        // `server_transfer_start` takes one policy per call, so group sources
        // by the choice the user made for each conflicting item.
        const groups = new Map<ConflictChoice, string[]>();
        for (const source of sources) {
          const choice = decisions?.get(source) ?? "overwrite";
          const group = groups.get(choice);
          if (group) group.push(source);
          else groups.set(choice, [source]);
        }

        setQueueOpen(true);
        for (const [policy, group] of groups) {
          await serverTransferStart(profileId, direction, group, targetDir, policy);
        }
        await refreshTransfers();
        schedulePaneReload();
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [askConflicts, describeError, findConflicts, profileId, refreshTransfers, schedulePaneReload]
  );

  const patchTask = useCallback(
    (transferId: string, patch: Partial<TransferSnapshot>) => {
      const existing = tasksRef.current[transferId];
      if (!existing) return;
      commitTasks({ ...tasksRef.current, [transferId]: { ...existing, ...patch } });
    },
    [commitTasks]
  );

  const pauseTransfer = useCallback(
    async (transferId: string) => {
      patchTask(transferId, { state: "paused", bytesPerSec: 0 });
      try {
        await serverTransferPause(transferId);
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [describeError, patchTask]
  );

  const resumeTransfer = useCallback(
    async (transferId: string) => {
      patchTask(transferId, { state: "running" });
      try {
        await serverTransferResume(transferId);
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [describeError, patchTask]
  );

  const cancelTransfer = useCallback(
    async (transferId: string) => {
      try {
        await serverTransferCancel(transferId);
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [describeError]
  );

  const clearFinishedTransfers = useCallback(() => {
    const next: Record<string, TransferSnapshot> = {};
    for (const [id, task] of Object.entries(tasksRef.current)) {
      if (!FINISHED_STATES.has(task.state)) next[id] = task;
    }
    commitTasks(next);
  }, [commitTasks]);

  const profileTasks = useMemo(
    () => tasks.filter((task) => task.profileId === profileId),
    [tasks, profileId]
  );

  const handleDragStart = useCallback((payload: DragPayload) => setDragSource(payload.side), []);
  const handleDragEnd = useCallback(() => setDragSource(null), []);
  const handleDropTransfer = useCallback(
    (payload: DragPayload, targetDir: string) => {
      const direction: TransferDirection = payload.side === "local" ? "upload" : "download";
      void startTransfer(direction, payload.paths, targetDir);
    },
    [startTransfer]
  );

  const uploadEntries = useCallback(
    (entries: SftpEntry[]) => {
      if (!entries.length) return;
      if (!remotePath) {
        toast.error(
          t("servers.sftp.remoteNotReady", { defaultValue: "The remote folder is not ready yet." })
        );
        return;
      }
      void startTransfer(
        "upload",
        entries.map((entry) => entry.path),
        remotePath
      );
    },
    [remotePath, startTransfer, t]
  );

  const downloadEntries = useCallback(
    (entries: SftpEntry[]) => {
      if (!entries.length) return;
      if (!localPath) {
        toast.error(
          t("servers.sftp.localNotReady", { defaultValue: "The local folder is not ready yet." })
        );
        return;
      }
      void startTransfer(
        "download",
        entries.map((entry) => entry.path),
        localPath
      );
    },
    [localPath, startTransfer, t]
  );

  const openLocalEntry = useCallback(
    async (entry: SftpEntry) => {
      try {
        await openPath(entry.path);
      } catch (error) {
        toast.error(describeError(error));
      }
    },
    [describeError]
  );

  const openRemoteEntry = useCallback(
    async (entry: SftpEntry) => {
      if (!isTextFile(entry.name)) {
        toast.info(
          t("servers.sftp.previewUnsupported", {
            defaultValue: "This file type cannot be previewed here.",
          })
        );
        return;
      }

      const token = previewTokenRef.current + 1;
      previewTokenRef.current = token;
      setPreview({ open: true, path: entry.path, content: null, loading: true, error: null });
      try {
        const content = await serverSftpReadText(profileId, entry.path);
        if (previewTokenRef.current !== token) return;
        setPreview((previous) => ({ ...previous, content, loading: false }));
      } catch (error) {
        if (previewTokenRef.current !== token) return;
        setPreview((previous) => ({ ...previous, loading: false, error: describeError(error) }));
      }
    },
    [describeError, profileId, t]
  );

  const createLocalFolder = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!isValidEntryName("local", trimmed)) {
        throw new Error(
          t("servers.sftp.invalidName", {
            defaultValue: "Enter a valid name without path separators.",
          })
        );
      }
      await serverLocalMkdir(joinPath("local", localPath, trimmed));
      reloadLocalPane();
    },
    [localPath, reloadLocalPane, t]
  );

  const createRemoteFolder = useCallback(
    async (name: string) => {
      const trimmed = name.trim();
      if (!isValidEntryName("remote", trimmed)) {
        throw new Error(
          t("servers.sftp.invalidName", {
            defaultValue: "Enter a valid name without path separators.",
          })
        );
      }
      await serverSftpMkdir(profileId, joinPath("remote", remotePath, trimmed));
      reloadRemotePane();
    },
    [profileId, reloadRemotePane, remotePath, t]
  );

  const renameLocalEntry = useCallback(
    async (entry: SftpEntry, name: string) => {
      await serverLocalRename(entry.path, joinPath("local", localPath, name.trim()));
      reloadLocalPane();
    },
    [localPath, reloadLocalPane]
  );

  const renameRemoteEntry = useCallback(
    async (entry: SftpEntry, name: string) => {
      await serverSftpRename(profileId, entry.path, joinPath("remote", remotePath, name.trim()));
      reloadRemotePane();
    },
    [profileId, reloadRemotePane, remotePath]
  );

  const requestDelete = useCallback((side: Side, entries: SftpEntry[]) => {
    if (!entries.length) return;
    setDeleteError(null);
    setDeleteRequest({ side, entries });
  }, []);

  const confirmDelete = useCallback(async () => {
    if (!deleteRequest || deleting) return;
    setDeleting(true);
    setDeleteError(null);

    const failures: string[] = [];
    const remaining: SftpEntry[] = [];
    for (const entry of deleteRequest.entries) {
      try {
        if (deleteRequest.side === "local") {
          await serverLocalDelete(entry.path, entry.kind === "dir");
        } else {
          await serverSftpDelete(profileId, entry.path, entry.kind === "dir");
        }
      } catch (error) {
        failures.push(`${entry.name}: ${describeError(error)}`);
        remaining.push(entry);
      }
    }

    setDeleting(false);
    if (deleteRequest.side === "local") reloadLocalPane();
    else reloadRemotePane();

    if (failures.length > 0) {
      setDeleteError(failures.join("\n"));
      setDeleteRequest({ side: deleteRequest.side, entries: remaining });
    } else {
      setDeleteRequest(null);
    }
  }, [deleteRequest, deleting, describeError, profileId, reloadLocalPane, reloadRemotePane]);

  const closePreview = useCallback((open: boolean) => {
    if (open) return;
    previewTokenRef.current += 1;
    setPreview((previous) => ({ ...previous, open: false }));
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2 p-2">
      <div className="min-h-0 flex-1">
        <Group orientation="horizontal" className="h-full">
          <Panel id="sftp-local" defaultSize="50" minSize={320} className="h-full overflow-hidden">
            <FilePane
              side="local"
              pane={localPane}
              showHidden={prefs?.showHiddenLocal ?? false}
              initializing={localInitializing}
              initError={localInitError}
              onRetryInit={() => void retryLocal()}
              onNavigate={navigateLocal}
              onRefresh={reloadLocalPane}
              onToggleHidden={toggleLocalHidden}
              onCreateFolder={createLocalFolder}
              onRename={renameLocalEntry}
              onDelete={(entries) => requestDelete("local", entries)}
              onOpenEntry={(entry) => void openLocalEntry(entry)}
              onUpload={uploadEntries}
              onDownload={downloadEntries}
              onDropTransfer={handleDropTransfer}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              dragSource={dragSource}
            />
          </Panel>
          <Separator className="bg-border w-1 cursor-col-resize" />
          <Panel id="sftp-remote" defaultSize="50" minSize={320} className="h-full overflow-hidden">
            <FilePane
              side="remote"
              pane={remotePane}
              showHidden={prefs?.showHiddenRemote ?? false}
              initializing={remoteInitializing}
              initError={remoteInitError}
              onRetryInit={() => void retryRemote()}
              onNavigate={navigateRemotePane}
              onRefresh={reloadRemotePane}
              onToggleHidden={toggleRemoteHidden}
              onCreateFolder={createRemoteFolder}
              onRename={renameRemoteEntry}
              onDelete={(entries) => requestDelete("remote", entries)}
              onOpenEntry={(entry) => void openRemoteEntry(entry)}
              onUpload={uploadEntries}
              onDownload={downloadEntries}
              onDropTransfer={handleDropTransfer}
              onDragStart={handleDragStart}
              onDragEnd={handleDragEnd}
              dragSource={dragSource}
            />
          </Panel>
        </Group>
      </div>

      <TransferQueue
        tasks={profileTasks}
        open={queueOpen}
        onOpenChange={setQueueOpen}
        onPause={(transferId) => void pauseTransfer(transferId)}
        onResume={(transferId) => void resumeTransfer(transferId)}
        onCancel={(transferId) => void cancelTransfer(transferId)}
        onClearFinished={clearFinishedTransfers}
      />

      <ConflictDialog
        open={conflictRequest !== null}
        items={conflictRequest?.items ?? []}
        defaultChoice={conflictRequest?.defaultChoice ?? "overwrite"}
        onCancel={cancelConflicts}
        onConfirm={resolveConflicts}
      />

      <Dialog
        open={deleteRequest !== null}
        onOpenChange={(open) => {
          if (!open && !deleting) {
            setDeleteRequest(null);
            setDeleteError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>
              {t("servers.sftp.deleteTitle", { defaultValue: "Delete items?" })}
            </DialogTitle>
            <DialogDescription>
              {t("servers.sftp.deleteDescription", {
                count: deleteRequest?.entries.length ?? 0,
                defaultValue: "Delete {{count}} item(s)? Folders are removed recursively.",
              })}
            </DialogDescription>
          </DialogHeader>
          {deleteError && (
            <p className="border-destructive/30 bg-destructive/5 text-destructive rounded-md border px-2.5 py-1.5 text-xs break-words whitespace-pre-line">
              {deleteError}
            </p>
          )}
          <DialogFooter>
            <Button
              variant="ghost"
              disabled={deleting}
              onClick={() => {
                setDeleteRequest(null);
                setDeleteError(null);
              }}
            >
              {t("servers.form.cancel")}
            </Button>
            <Button variant="destructive" disabled={deleting} onClick={() => void confirmDelete()}>
              {deleting ? <Loader2 className="animate-spin" /> : <Trash2 />}
              {t("servers.sftp.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <TextPreviewDialog
        open={preview.open}
        path={preview.path}
        content={preview.content}
        loading={preview.loading}
        error={preview.error}
        onOpenChange={closePreview}
      />
    </div>
  );
}

export default SftpTab;
