import type { DiffTabTarget } from "@/lib/editor/editor-tabs";

/**
 * The editor tabs the Git views on the project page can open.
 *
 * The panels belong to the workbench the page mounts, so the views below it are
 * handed these callbacks instead of reaching for a module-level handle.
 */
export interface ProjectTabOpeners {
  openDiff: (target: DiffTabTarget) => void;
  /** `right` null compares against the working tree. */
  openCompare: (left: string, right: string | null, path?: string) => void;
  openRevisionFile: (oid: string, path: string) => void;
  openRevisionTree: (oid: string) => void;
  openFileHistory: (path: string, fromOid?: string) => void;
  /**
   * Opens a working-copy file in the editor. Resolves to false when the
   * workbench has no editor to hand it to.
   */
  openFile: (path: string) => Promise<boolean>;
}
