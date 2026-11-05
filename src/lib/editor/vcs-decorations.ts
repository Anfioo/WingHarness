import {
  defineExtension,
  EventEmitter,
  FileDecoration,
  ThemeColor,
  type Extension,
  type FileDecorationProvider,
  type Uri,
} from "codelet/extensions";
import type { FileStatus, FileStatusKind } from "@/lib/git-core/types";

/**
 * Git colouring for the project file tree, in the shape IDEA and openidea draw it:
 * one kind per file, a badge beside the name, and the colour inherited by the
 * folders that hold it.
 *
 * The workbench has no notion of a change list — it only knows how to ask a
 * `FileDecorationProvider` about a URI — so everything the tree shows has to fit
 * what a decoration carries: a letter, a tooltip, a theme colour, and whether the
 * colour climbs to ancestors. Ignored files are the one kind that does not climb.
 */

export type VcsKind =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "ignored";

/**
 * What a single file is, from its staged and unstaged halves.
 *
 * A file added to the index stays "added" while it has further edits, the way
 * openidea's change list keeps it green; a conflicted file outranks everything
 * else, because resolving it is the only thing that matters about it.
 */
export function effectiveKind(file: Pick<FileStatus, "staged" | "unstaged">): VcsKind | null {
  const { staged, unstaged } = file;
  if (staged === "conflicted" || unstaged === "conflicted") return "conflicted";
  if (unstaged === "untracked") return staged ? kindOf(staged) : "untracked";
  if (staged === "new") return unstaged === "deleted" ? null : "added";
  if (unstaged === "deleted" || staged === "deleted") return "deleted";
  if (staged === "renamed") return "renamed";
  if (staged || unstaged) return "modified";
  return null;
}

function kindOf(kind: FileStatusKind): VcsKind {
  if (kind === "new") return "added";
  if (kind === "untracked") return "untracked";
  // `typechange` (a symlink swapped for a file) has no badge of its own.
  if (kind === "typechange") return "modified";
  return kind;
}

/** Folder colour precedence: earlier kinds win when a folder holds several. */
const FOLDER_PRECEDENCE: VcsKind[] = [
  "conflicted",
  "modified",
  "renamed",
  "added",
  "deleted",
  "untracked",
];

interface KindStyle {
  badge: string;
  /** An id codelet's own palette knows; anything else paints nothing. */
  color: string;
  propagate: boolean;
}

const STYLES: Record<VcsKind, KindStyle> = {
  modified: {
    badge: "M",
    color: "gitDecoration.modifiedResourceForeground",
    propagate: true,
  },
  added: {
    badge: "A",
    color: "gitDecoration.addedResourceForeground",
    propagate: true,
  },
  deleted: {
    badge: "D",
    color: "gitDecoration.deletedResourceForeground",
    propagate: true,
  },
  renamed: {
    badge: "R",
    color: "gitDecoration.renamedResourceForeground",
    propagate: true,
  },
  untracked: {
    badge: "U",
    color: "gitDecoration.untrackedResourceForeground",
    propagate: true,
  },
  conflicted: {
    badge: "!",
    color: "gitDecoration.conflictingResourceForeground",
    propagate: true,
  },
  ignored: {
    badge: "",
    color: "gitDecoration.ignoredResourceForeground",
    propagate: false,
  },
};

/** Repository-relative path for a workbench URI: `/src/a.ts` → `src/a.ts`. */
function relativePath(uri: Uri): string {
  const path = uri.path.startsWith("/") ? uri.path.slice(1) : uri.path;
  return path.endsWith("/") ? path.slice(0, -1) : path;
}

/**
 * One entry per path, ordered so the first propagating one a folder meets is the
 * most significant — the provider's ancestor walk takes the first colour it finds.
 */
export function vcsKinds(
  status: readonly FileStatus[],
  ignored: readonly string[]
): Map<string, VcsKind> {
  const entries: Array<[string, VcsKind]> = [];
  const seen = new Set<string>();

  for (const file of status) {
    const kind = effectiveKind(file);
    if (!kind || seen.has(file.path)) continue;
    seen.add(file.path);
    entries.push([file.path, kind]);
  }
  for (const path of ignored) {
    const relative = path.replace(/\/+$/, "");
    if (!relative || seen.has(relative)) continue;
    seen.add(relative);
    entries.push([relative, "ignored"]);
  }

  const rank = (kind: VcsKind) => {
    const index = FOLDER_PRECEDENCE.indexOf(kind);
    return index < 0 ? FOLDER_PRECEDENCE.length : index;
  };
  entries.sort((a, b) => rank(a[1]) - rank(b[1]));
  return new Map(entries);
}

export interface VcsDecorationHandle {
  /** Goes into the workbench's extension list. */
  extension: Extension;
  /** Replaces the status behind every decoration and redraws the tree. */
  setData: (kinds: Map<string, VcsKind>) => void;
  /** Redraws with the same data — for a language change, which rewrites tooltips. */
  invalidate: () => void;
}

/**
 * @param label the localized name of a kind, asked on every request so a language
 *   switch only needs `invalidate()`, not a new workbench.
 */
export function createVcsDecorationExtension(options: {
  label: (kind: VcsKind) => string;
}): VcsDecorationHandle {
  let kinds = new Map<string, VcsKind>();
  const changes = new EventEmitter<undefined | Uri | Uri[]>();

  const kindOfPath = (path: string): VcsKind | undefined => {
    const direct = kinds.get(path);
    if (direct) return direct;
    // Ignored directories are reported whole, so their contents never appear in
    // the status; they take the colour from the ignored ancestor instead.
    let slash = path.lastIndexOf("/");
    while (slash > 0) {
      const parent = path.slice(0, slash);
      if (kinds.get(parent) === "ignored") return "ignored";
      slash = parent.lastIndexOf("/");
    }
    return undefined;
  };

  const extension = defineExtension({
    manifest: { name: "app-vcs-decorations" },
    activate(context, vscode) {
      const provider: FileDecorationProvider = {
        onDidChangeFileDecorations: changes.event,
        provideFileDecoration(uri) {
          const path = relativePath(uri);
          if (!path) return undefined;
          const kind = kindOfPath(path);
          if (!kind) return undefined;
          const style = STYLES[kind];
          const decoration = new FileDecoration(
            style.badge || undefined,
            options.label(kind),
            new ThemeColor(style.color)
          );
          if (style.propagate) decoration.propagate = true;
          return decoration;
        },
      };
      context.subscriptions.push(vscode.window.registerFileDecorationProvider(provider));
    },
  });

  return {
    extension,
    setData(next) {
      kinds = next;
      changes.fire(undefined);
    },
    invalidate() {
      changes.fire(undefined);
    },
  };
}
