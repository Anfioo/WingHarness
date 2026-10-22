import { toast } from "sonner";
import type { FileSystem } from "codelet/workbench";
import { notesDelete, notesList, notesMkdir, notesWrite } from "@/commands";

/** How long an edit settles before it is written to disk. */
const DEBOUNCE_MS = 500;

/** Reads every note from disk into the workbench's filesystem. */
export async function loadWorkspace(fs: FileSystem): Promise<void> {
  const tree = await notesList();
  for (const directory of tree.directories) {
    if (!fs.exists(directory)) fs.createDirectory(directory);
  }
  for (const file of tree.files) {
    fs.write(file.path, file.content);
  }
}

/**
 * Keeps disk and the in-memory filesystem in step.
 *
 * The workbench writes through to `fs` on every keystroke, so the listener
 * debounces and then reconciles the whole tree: whatever the in-memory side
 * holds is what disk should hold. A whole-tree pass rather than a per-path one
 * because a directory rename fires one event for the two names and none for
 * the files that moved with it.
 *
 * Returns the unsubscribe.
 */
export function startSync(fs: FileSystem): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running = false;
  let again = false;

  const reconcile = async () => {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      await reconcileOnce(fs);
    } catch (error) {
      console.error("notes sync:", error);
      toast.error("笔记保存失败，请检查数据目录是否可写。");
    } finally {
      running = false;
      if (again) {
        again = false;
        void reconcile();
      }
    }
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void reconcile(), DEBOUNCE_MS);
  };

  const unsubscribe = fs.onDidChange(schedule);
  return () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}

async function reconcileOnce(fs: FileSystem) {
  const disk = await notesList();
  const diskFiles = new Map(disk.files.map((file) => [file.path, file.content]));
  const diskDirs = new Set(disk.directories);
  const memoryFiles = new Map(fs.files().map((path) => [path, fs.read(path)]));
  const memoryDirs = directoriesOf(fs);

  for (const [path, content] of memoryFiles) {
    if (diskFiles.get(path) !== content) await notesWrite(path, content);
  }
  for (const path of memoryDirs) {
    if (!diskDirs.has(path)) await notesMkdir(path);
  }

  // Files first, then directories — removing a directory on disk takes
  // everything under it, which would race a file still queued for deletion.
  for (const path of diskFiles.keys()) {
    if (!memoryFiles.has(path)) await notesDelete(path);
  }
  // Deepest first, so a parent is not removed before the children it holds.
  for (const path of [...diskDirs].sort().reverse()) {
    if (!memoryDirs.has(path)) await notesDelete(path);
  }
}

/** Every directory in the tree, as the leading-slash paths `notes_list` returns. */
function directoriesOf(fs: FileSystem): Set<string> {
  const dirs = new Set<string>();
  const visit = (path: string) => {
    for (const entry of fs.readDirectory(path)) {
      if (entry.type === "directory") {
        dirs.add(entry.path);
        visit(entry.path);
      }
    }
  };
  visit("/");
  return dirs;
}
