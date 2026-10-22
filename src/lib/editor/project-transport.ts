import type { Transport } from "codelet/extensions/remote";
import {
  projectDelete,
  projectInfo,
  projectMkdir,
  projectMove,
  projectRead,
  projectTree,
  projectWrite,
} from "@/commands";

/**
 * Backs codelet's `remote` extension with the app's own commands instead of a
 * host over HTTP.
 *
 * The extension is written against this interface — `info`, `tree`, `read` and
 * the four mutations — and never learns where the bytes come from. The Rust
 * side owns the working-copy root and confines every path to it, so nothing
 * here builds or checks a path.
 *
 * `remote` takes a factory rather than a transport, so this is that: the URL it
 * is handed is unused, there being no host to reach.
 */
export function createProjectTransport(): (url: string) => Transport {
  return () => ({
    name: "project",

    info: () => projectInfo(),

    tree: (path, query) =>
      projectTree(path, {
        depth: query?.depth,
        content: query?.content,
      }),

    read: (path) => projectRead(path),

    write: (path, body, etag) => {
      // Binary preview is off, so a binary file is held as an address and never
      // written back. Text is the only thing that reaches here.
      if (typeof body !== "string") {
        throw new Error("二进制文件不支持写入。");
      }
      return projectWrite(path, body, etag);
    },

    mkdir: (path) => projectMkdir(path),

    move: (from, to) => projectMove(from, to),

    delete: (path) => projectDelete(path),

    /**
     * Binary preview is off, so nothing resolves this to real bytes. The
     * extension writes whatever this returns as the binary file's content, so
     * it is a short note the reader sees instead of an image rather than a
     * path that would mean nothing as text.
     */
    source: (path) => `[二进制文件，暂不支持预览]\n${path}\n`,

    /**
     * No change feed. A working copy changes under `git svn`, and the toolbar's
     * Sync command refreshes the tree on demand — a watch would be a second
     * thing to keep alive for little the reader cannot already ask for. The
     * unsubscribe it returns is a no-op.
     */
    watch: () => () => {},
  });
}
