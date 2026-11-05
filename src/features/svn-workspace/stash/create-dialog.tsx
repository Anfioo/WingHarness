import { useEffect, useRef, useState } from "react";
import { Archive, File as FileIcon, Folder } from "lucide-react";
import { toast } from "sonner";
import { deleteUnversioned, readUnversionedFiles, svnApplyPatch, svnDiff } from "@/commands";
import i18n from "@/i18n";
import { buildPatch, createStashId, parseUnifiedDiff } from "@/lib/svn-core";
import type { StashEntry, StashFile, StashUnversionedEntry } from "@/lib/svn-core/types";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { StatusBadge } from "@/components/svn-workspace/status-badge";
import { useSvnWorkspaceStore } from "@/features/svn-workspace/store";
import { useSvnWorkspace } from "@/features/svn-workspace/use-workspace";
import { useAppTranslation } from "@/hooks/use-app-translation";
import { cn } from "@/lib/utils";
import {
  decodePreview,
  formatContentSize,
  isDescendant,
  lineClass,
  stashableFiles,
  unversionedRoots,
} from "./model";
import { useStashStore } from "./store";

/** A checkbox on a native input, with an optional indeterminate dash. */
function Checkbox({
  checked,
  indeterminate,
  onChange,
  label,
}: {
  checked: boolean;
  indeterminate?: boolean;
  onChange: (checked: boolean) => void;
  label: string;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = Boolean(indeterminate) && !checked;
  }, [indeterminate, checked]);
  return (
    <input
      ref={ref}
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => onChange(event.target.checked)}
      onClick={(event) => event.stopPropagation()}
      className="accent-primary size-3.5 shrink-0"
    />
  );
}

function defaultStashName(): string {
  return `WIP on ${new Date().toLocaleString()}`;
}

/**
 * The "create a stash" dialog: it diffs the working copy's stashable files,
 * lets the user pick hunks and unversioned files, then stores the patch and
 * reverts those paths.
 *
 * The reference assembled the same flow in `StashView.vue`. The one deliberate
 * change: before every mutation it checks the command's `success` flag and
 * raises the engine's own error, so a patch that does not apply cleanly is
 * reported rather than silently ignored.
 */
export function StashCreateDialog({
  open,
  onOpenChange,
  workspacePath,
  statusIsStale,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspacePath: string;
  statusIsStale: boolean;
}) {
  const { t } = useAppTranslation();
  const addEntry = useStashStore((state) => state.addEntry);
  const { refreshStatusAfterMutation } = useSvnWorkspace();

  const [loadingDiffs, setLoadingDiffs] = useState(false);
  const [creating, setCreating] = useState(false);
  const [diffFiles, setDiffFiles] = useState<StashFile[]>([]);
  const [unversionedPreview, setUnversionedPreview] = useState<StashUnversionedEntry[]>([]);
  const [selectedHunks, setSelectedHunks] = useState<Set<string>>(new Set());
  const [selectedUnversioned, setSelectedUnversioned] = useState<Set<string>>(new Set());
  const [stashName, setStashName] = useState("");

  const openedRef = useRef(false);

  // Load once per open: read the status list straight from the store so a
  // background refresh does not reset the user's selection mid-dialog.
  useEffect(() => {
    if (!open) {
      openedRef.current = false;
      return;
    }
    if (openedRef.current) return;
    openedRef.current = true;

    const statusList = useSvnWorkspaceStore.getState().statusList;
    const unversioned = unversionedRoots(statusList);
    const changed = stashableFiles(statusList);
    let cancelled = false;

    setLoadingDiffs(true);
    setStashName(defaultStashName());
    setSelectedHunks(new Set());
    setSelectedUnversioned(new Set());
    setUnversionedPreview([]);
    setDiffFiles([]);

    void Promise.all([
      Promise.all(
        changed.map(async (file) => {
          const result = await svnDiff(workspacePath, file.path);
          return parseUnifiedDiff(file.path, result.diff);
        })
      ),
      unversioned.length
        ? readUnversionedFiles(
            workspacePath,
            unversioned.map((file) => file.path)
          )
        : Promise.resolve([] as StashUnversionedEntry[]),
    ])
      .then(([parsed, preview]) => {
        if (cancelled) return;
        const files = parsed.filter((file): file is StashFile => file !== null);
        setDiffFiles(files);
        setUnversionedPreview(preview);
        setSelectedHunks(new Set(files.flatMap((file) => file.hunks.map((hunk) => hunk.id))));
        setSelectedUnversioned(new Set(unversioned.map((file) => file.path)));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setDiffFiles([]);
        toast.error(`${i18n.t("svnWorkspace.stash.createFailed")}: ${String(error)}`);
      })
      .finally(() => {
        if (!cancelled) setLoadingDiffs(false);
      });

    return () => {
      cancelled = true;
    };
  }, [open, workspacePath]);

  const toggleHunk = (id: string, checked: boolean) => {
    setSelectedHunks((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const toggleFile = (file: StashFile, checked: boolean) => {
    setSelectedHunks((prev) => {
      const next = new Set(prev);
      for (const hunk of file.hunks) {
        if (checked) next.add(hunk.id);
        else next.delete(hunk.id);
      }
      return next;
    });
  };

  const toggleUnversioned = (path: string, checked: boolean) => {
    setSelectedUnversioned((prev) => {
      const next = new Set(prev);
      if (checked) next.add(path);
      else next.delete(path);
      return next;
    });
  };

  const selectAll = () => {
    setSelectedHunks(new Set(diffFiles.flatMap((file) => file.hunks.map((hunk) => hunk.id))));
    setSelectedUnversioned(new Set(unversionedPreview.map((entry) => entry.path)));
  };

  const clearSelection = () => {
    setSelectedHunks(new Set());
    setSelectedUnversioned(new Set());
  };

  const selectedItemCount = selectedHunks.size + selectedUnversioned.size;

  const createStash = async () => {
    if (statusIsStale || selectedItemCount === 0) return;
    const patch = buildPatch(diffFiles, selectedHunks);
    if (!patch && selectedUnversioned.size === 0) {
      toast.warning(t("svnWorkspace.stash.noSelection"));
      return;
    }

    setCreating(true);
    let captured: StashUnversionedEntry[];
    try {
      captured = selectedUnversioned.size
        ? await readUnversionedFiles(workspacePath, [...selectedUnversioned])
        : [];
    } catch (error) {
      toast.error(`${t("svnWorkspace.stash.createFailed")}: ${String(error)}`);
      setCreating(false);
      return;
    }

    const selectedPaths = diffFiles
      .filter((file) => file.hunks.some((hunk) => selectedHunks.has(hunk.id)))
      .map((file) => file.path);
    const entry: StashEntry = {
      id: createStashId(),
      name: stashName.trim() || t("svnWorkspace.stash.defaultName"),
      workspacePath,
      createdAt: new Date().toISOString(),
      patch,
      files: [...new Set([...selectedPaths, ...selectedUnversioned])],
      hunkCount: selectedHunks.size,
      unversionedFiles: captured,
    };

    try {
      // Store the only durable copy before removing changes from the working copy.
      await addEntry(entry);
    } catch (error) {
      toast.error(`${t("svnWorkspace.stash.createFailed")}: ${String(error)}`);
      setCreating(false);
      return;
    }

    try {
      if (patch) {
        const result = await svnApplyPatch(workspacePath, patch, true);
        if (!result.success) throw new Error(result.error || result.output);
      }
      if (selectedUnversioned.size) {
        const result = await deleteUnversioned(workspacePath, [...selectedUnversioned]);
        if (!result.success) throw new Error(result.error || result.output);
      }
      onOpenChange(false);
      await refreshStatusAfterMutation();
      toast.success(t("svnWorkspace.stash.created"));
    } catch (error) {
      // The patch is already stored, so retain it and keep the source changes.
      onOpenChange(false);
      await refreshStatusAfterMutation();
      toast.warning(`${t("svnWorkspace.stash.savedButNotHidden")}: ${String(error)}`);
    } finally {
      setCreating(false);
    }
  };

  const previewEntries = (root: string) =>
    unversionedPreview.filter((entry) => entry.path === root || isDescendant(entry.path, root));

  const empty = diffFiles.length === 0 && unversionedPreview.length === 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t("svnWorkspace.stash.createTitle")}</DialogTitle>
          <DialogDescription>{t("svnWorkspace.stash.selectHunksHint")}</DialogDescription>
        </DialogHeader>

        <div className="flex items-center justify-between gap-3">
          <span className="text-sm font-medium">{t("svnWorkspace.stash.selectHunks")}</span>
          <div className="flex items-center gap-2">
            <span className="text-primary text-xs font-semibold">
              {t("svnWorkspace.stash.selectedItems", { count: selectedItemCount })}
            </span>
            <Button variant="ghost" size="xs" onClick={selectAll}>
              {t("svnWorkspace.stash.selectAll")}
            </Button>
            <Button variant="ghost" size="xs" onClick={clearSelection}>
              {t("svnWorkspace.stash.clearSelection")}
            </Button>
          </div>
        </div>

        <div className="max-h-[52vh] min-h-32 overflow-auto pr-1">
          {loadingDiffs ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center gap-2 text-sm">
              {t("svnWorkspace.stash.loadingDiffs")}
            </div>
          ) : empty ? (
            <div className="text-muted-foreground flex h-32 items-center justify-center text-sm">
              {t("svnWorkspace.stash.noDiffs")}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {unversionedPreview.length > 0 ? (
                <section className="border-border overflow-hidden rounded-md border">
                  <div className="border-border bg-muted/50 flex items-center justify-between gap-3 border-b px-3 py-2">
                    <div>
                      <strong className="block text-sm">
                        {t("svnWorkspace.stash.unversionedTitle")}
                      </strong>
                      <span className="text-muted-foreground text-xs">
                        {t("svnWorkspace.stash.unversionedHint")}
                      </span>
                    </div>
                    <span className="text-muted-foreground shrink-0 text-xs">
                      {t("svnWorkspace.stash.files", {
                        count: unversionedRootsFromPreview(unversionedPreview).length,
                      })}
                    </span>
                  </div>
                  {unversionedRootsFromPreview(unversionedPreview).map((root) => {
                    const selected = selectedUnversioned.has(root.path);
                    return (
                      <div
                        key={root.path}
                        role="button"
                        tabIndex={0}
                        onClick={() => toggleUnversioned(root.path, !selected)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter" || event.key === " ") {
                            event.preventDefault();
                            toggleUnversioned(root.path, !selected);
                          }
                        }}
                        className={cn(
                          "border-border cursor-pointer border-t transition-colors",
                          selected ? "bg-primary/10" : "hover:bg-muted/50"
                        )}
                      >
                        <div className="flex items-center gap-2.5 px-3 py-2.5">
                          <Checkbox
                            checked={selected}
                            onChange={(checked) => toggleUnversioned(root.path, checked)}
                            label={root.path}
                          />
                          {root.kind === "directory" ? (
                            <Folder className="text-muted-foreground size-3.5" />
                          ) : (
                            <FileIcon className="text-muted-foreground size-3.5" />
                          )}
                          <span className="min-w-0 flex-1 truncate font-mono text-xs">
                            {root.path}
                          </span>
                          <StatusBadge code="unversioned" />
                        </div>
                        <div
                          className="border-border bg-background cursor-default border-t"
                          onClick={(event) => event.stopPropagation()}
                        >
                          {previewEntries(root.path).map((entry) => {
                            if (entry.kind === "directory") {
                              return (
                                <div
                                  key={entry.path}
                                  className="text-muted-foreground px-3 py-1.5 font-mono text-xs"
                                >
                                  {entry.path}/ · {t("svnWorkspace.stash.directory")}
                                </div>
                              );
                            }
                            const decoded = decodePreview(entry);
                            return (
                              <div key={entry.path}>
                                {previewEntries(root.path).length > 1 ? (
                                  <div className="border-border/60 bg-muted/30 text-muted-foreground border-t px-3 py-1 font-mono text-xs">
                                    {entry.path}
                                  </div>
                                ) : null}
                                {decoded !== null ? (
                                  <pre className="max-h-60 overflow-auto px-3 py-2 font-mono text-xs leading-relaxed">
                                    {decoded.split("\n").map((line, index) => (
                                      <span key={index} className="text-success block">
                                        + {line}
                                      </span>
                                    ))}
                                  </pre>
                                ) : (
                                  <div className="text-muted-foreground px-3 py-1.5 font-mono text-xs">
                                    {t("svnWorkspace.stash.binaryFile")} ·{" "}
                                    {formatContentSize(entry.contentBase64)}
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                  })}
                </section>
              ) : null}

              {diffFiles.map((file) => {
                const allSelected = file.hunks.every((hunk) => selectedHunks.has(hunk.id));
                const someSelected = file.hunks.some((hunk) => selectedHunks.has(hunk.id));
                return (
                  <section
                    key={file.path}
                    className="border-border overflow-hidden rounded-md border"
                  >
                    <div
                      role="button"
                      tabIndex={0}
                      onClick={() => toggleFile(file, !allSelected)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggleFile(file, !allSelected);
                        }
                      }}
                      className={cn(
                        "flex cursor-pointer items-center gap-2.5 px-3 py-2.5 transition-colors",
                        someSelected ? "bg-primary/5" : "hover:bg-muted/50"
                      )}
                    >
                      <Checkbox
                        checked={allSelected}
                        indeterminate={someSelected && !allSelected}
                        onChange={(checked) => toggleFile(file, checked)}
                        label={file.path}
                      />
                      <span className="min-w-0 flex-1 font-mono text-xs break-words">
                        {file.path}
                      </span>
                      <span className="text-muted-foreground shrink-0 text-xs">
                        {t("svnWorkspace.stash.hunks", { count: file.hunks.length })}
                      </span>
                    </div>
                    {file.hunks.map((hunk) => {
                      const hunkSelected = selectedHunks.has(hunk.id);
                      return (
                        <div
                          key={hunk.id}
                          role="button"
                          tabIndex={0}
                          onClick={() => toggleHunk(hunk.id, !hunkSelected)}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              toggleHunk(hunk.id, !hunkSelected);
                            }
                          }}
                          className={cn(
                            "border-border cursor-pointer border-t transition-colors",
                            hunkSelected
                              ? "bg-primary/10 shadow-[inset_3px_0_0_var(--color-primary)]"
                              : "hover:bg-muted/40"
                          )}
                        >
                          <div className="flex items-center justify-between gap-2 px-3 py-1.5">
                            <div className="flex min-w-0 items-center gap-2">
                              <Checkbox
                                checked={hunkSelected}
                                onChange={(checked) => toggleHunk(hunk.id, checked)}
                                label={hunk.header}
                              />
                              <code className="min-w-0 font-mono text-xs break-words">
                                {hunk.header}
                              </code>
                            </div>
                            <span className="shrink-0 font-mono text-xs">
                              <span className="text-success">+{hunk.added}</span>{" "}
                              <span className="text-destructive">-{hunk.removed}</span>
                            </span>
                          </div>
                          <pre className="overflow-auto px-3 pb-2 pl-9 font-mono text-xs leading-relaxed">
                            {hunk.lines.map((line, index) => (
                              <span key={index} className={cn("block", lineClass(line))}>
                                {line}
                              </span>
                            ))}
                          </pre>
                        </div>
                      );
                    })}
                  </section>
                );
              })}
            </div>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor="svn-stash-name" className="text-xs font-semibold">
            {t("svnWorkspace.stash.name")}
          </label>
          <Input
            id="svn-stash-name"
            value={stashName}
            onChange={(event) => setStashName(event.target.value)}
            placeholder={t("svnWorkspace.stash.namePlaceholder")}
            maxLength={120}
          />
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={creating}>
            {t("svnWorkspace.common.cancel")}
          </Button>
          <Button
            onClick={() => void createStash()}
            disabled={selectedItemCount === 0 || statusIsStale || creating || loadingDiffs}
          >
            <Archive className="size-3.5" />
            {t("svnWorkspace.stash.saveAndHide")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** The preview entries that are roots (no ancestor also present). */
function unversionedRootsFromPreview(preview: StashUnversionedEntry[]): StashUnversionedEntry[] {
  return preview.filter(
    (entry) => !preview.some((other) => other !== entry && isDescendant(entry.path, other.path))
  );
}
