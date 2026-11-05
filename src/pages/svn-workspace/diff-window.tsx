import { TitleBar } from "@/components/title-bar";
import { WindowFrame } from "@/components/window-frame";
import { DiffPanel } from "@/features/svn-workspace/diff";
import { useSvnWorkspaceStore, type SvnDiffTarget } from "@/features/svn-workspace/store";

/** A query revision; blank or unparseable both mean "not given". */
function revisionFrom(search: URLSearchParams, key: string): number | undefined {
  const raw = search.get(key);
  if (raw === null || raw.trim() === "") return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

/** The working copy and the diff target this window was opened for, from its URL. */
function targetFromUrl(search: URLSearchParams) {
  const workspacePath = search.get("path")?.trim() ?? "";
  const target: SvnDiffTarget = {
    path: search.get("target") ?? "",
    oldRevision: revisionFrom(search, "old"),
    newRevision: revisionFrom(search, "new"),
  };
  return { workspacePath, target };
}

/** The changed file's name, without the peg revision `svn` pinned it to. */
function fileName(path: string) {
  const parts = path.replace(/@\d+$/, "").replace(/\\/g, "/").replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

const { workspacePath, target } = targetFromUrl(new URLSearchParams(window.location.search));

// This window is its own WebView with its own store, so the working copy and the
// diff target are seeded from the URL rather than handed over in memory the way
// the log panel hands them to the sidebar's diff panel. Nothing else runs in this
// window, so the rest of the store keeps its defaults.
if (workspacePath && target.path) {
  useSvnWorkspaceStore.setState({ workspacePath, diffTarget: target });
}

/**
 * One changed file's diff, in a window of its own — the sidebar's diff panel
 * (`DiffPanel`) with a frame around it, so opening a diff from the log leaves
 * the log window, its page and its filters untouched. Opening it from anywhere
 * else is `openSvnDiffWindow`'s job; this page only renders what the URL names.
 */
export default function SvnDiffWindow() {
  return (
    <WindowFrame
      titleBar={<TitleBar title={target.path ? fileName(target.path) : undefined} showPin />}
      contentClassName="flex flex-1 flex-col overflow-hidden"
    >
      <DiffPanel />
    </WindowFrame>
  );
}
