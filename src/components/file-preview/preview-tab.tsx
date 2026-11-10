import { useMemo } from "react";
import { absolutePath } from "@/components/file-preview/absolute-path";
import { PreviewHost } from "@/components/space-preview/host";

/**
 * A file's preview inside its editor tab.
 *
 * The tab itself is codelet's — its title and close button belong to the tab
 * strip — so the host is drawn embedded, without a close button of its own.
 * The file is shown by the same `PreviewHost` as the File Preview page and the
 * standalone window: the tree's `/`-rooted path is joined to the project root
 * and handed over as-is.
 */
export function PreviewTab({ path, name, root }: { path: string; name: string; root: string }) {
  const target = useMemo(() => ({ path: absolutePath(root, path), name }), [name, path, root]);

  return <PreviewHost mode="embedded" target={target} className="h-full" />;
}
