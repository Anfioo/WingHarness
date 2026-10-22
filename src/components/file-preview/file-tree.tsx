import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, FileIcon, Folder, FolderOpen, Loader2 } from "lucide-react";
import { projectTree, type RemoteEntry } from "@/commands";
import { formatBytes } from "@/lib/preview/lib/format";
import { cn } from "@/lib/utils";

/**
 * A read-only tree of the git-svn working copy.
 *
 * The working copy can hold `.git`, `node_modules` and build output, so it is
 * never read up front: each directory level is fetched when it is first
 * expanded, through the same `project_tree` command the project editor uses.
 * `.git` is filtered out by the backend, so nothing here has to know about it.
 *
 * This is deliberately not the codelet tree the notes and project pages mount.
 * Those are editors; this page only ever reads, and a plain recursive list is
 * all "pick a file to preview" needs.
 */
type FileTreeProps = {
  /** `/`-rooted path of the file currently open, or null. */
  selectedPath: string | null;
  onSelectFile: (entry: RemoteEntry) => void;
  /** Reported once when the tree cannot be read at all. */
  onError: (message: string) => void;
  labels: { loading: string; empty: string; failed: string };
};

export function FileTree({ selectedPath, onSelectFile, onError, labels }: FileTreeProps) {
  const [root, setRoot] = useState<RemoteEntry | null>(null);
  const [childrenByPath, setChildrenByPath] = useState<Record<string, RemoteEntry[]>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<ReadonlySet<string>>(new Set());
  const [failed, setFailed] = useState(false);

  // The callbacks are usually inline arrows; keeping them in refs means the
  // initial load runs once instead of on every parent render.
  const onErrorRef = useRef(onError);
  onErrorRef.current = onError;
  const onSelectRef = useRef(onSelectFile);
  onSelectRef.current = onSelectFile;

  useEffect(() => {
    let cancelled = false;
    projectTree("/", { depth: 1 })
      .then((result) => {
        if (cancelled) return;
        setRoot(result.entry);
        setChildrenByPath({ "/": result.entry.children ?? [] });
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setFailed(true);
        onErrorRef.current(error instanceof Error ? error.message : String(error));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const loadChildren = useCallback(async (path: string) => {
    setLoading((previous) => new Set(previous).add(path));
    try {
      const result = await projectTree(path, { depth: 1 });
      setChildrenByPath((previous) => ({ ...previous, [path]: result.entry.children ?? [] }));
    } catch (error) {
      onErrorRef.current(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
    }
  }, []);

  const toggleDirectory = useCallback(
    (path: string) => {
      setExpanded((previous) => {
        const next = new Set(previous);
        if (next.has(path)) {
          next.delete(path);
        } else {
          next.add(path);
        }
        return next;
      });
      setChildrenByPath((previous) => {
        if (previous[path]) return previous;
        void loadChildren(path);
        return previous;
      });
    },
    [loadChildren]
  );

  if (failed) {
    return <p className="text-muted-foreground p-3 text-xs">{labels.failed}</p>;
  }

  if (!root) {
    return (
      <p className="text-muted-foreground flex items-center gap-2 p-3 text-xs">
        <Loader2 className="size-3.5 animate-spin" />
        {labels.loading}
      </p>
    );
  }

  const entries = childrenByPath["/"] ?? [];
  if (entries.length === 0) {
    return <p className="text-muted-foreground p-3 text-xs">{labels.empty}</p>;
  }

  const renderEntries = (items: RemoteEntry[], depth: number) =>
    items.map((entry) => {
      const isDirectory = entry.type === "directory";
      const isExpanded = expanded.has(entry.path);
      const isSelected = entry.path === selectedPath;
      const isLoading = loading.has(entry.path);

      return (
        <div key={entry.path}>
          <button
            type="button"
            onClick={() => (isDirectory ? toggleDirectory(entry.path) : onSelectRef.current(entry))}
            style={{ paddingLeft: `${8 + depth * 14}px` }}
            className={cn(
              "hover:bg-accent flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px]",
              isSelected && "bg-accent font-medium"
            )}
            title={entry.path}
          >
            {isDirectory ? (
              <>
                <ChevronRight
                  className={cn(
                    "text-muted-foreground size-3.5 shrink-0 transition-transform",
                    isExpanded && "rotate-90"
                  )}
                />
                {isExpanded ? (
                  <FolderOpen className="text-muted-foreground size-3.5 shrink-0" />
                ) : (
                  <Folder className="text-muted-foreground size-3.5 shrink-0" />
                )}
              </>
            ) : (
              <>
                <span className="size-3.5 shrink-0" />
                <FileIcon className="text-muted-foreground size-3.5 shrink-0" />
              </>
            )}
            <span className="min-w-0 flex-1 truncate">{entry.name}</span>
            {isLoading ? (
              <Loader2 className="text-muted-foreground size-3 shrink-0 animate-spin" />
            ) : (
              entry.size !== undefined && (
                <span className="text-muted-foreground shrink-0 text-[10px] tabular-nums">
                  {formatBytes(entry.size)}
                </span>
              )
            )}
          </button>
          {isDirectory &&
            isExpanded &&
            childrenByPath[entry.path] &&
            renderEntries(childrenByPath[entry.path] ?? [], depth + 1)}
        </div>
      );
    });

  return <div className="py-1">{renderEntries(entries, 0)}</div>;
}
