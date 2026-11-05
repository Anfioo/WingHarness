import type { BranchInfo } from "@/lib/git-core";

/** One level of a branch tree: folders below it, and a branch when the path ends here. */
export interface BranchTreeNode {
  key: string;
  path: string;
  branch?: BranchInfo;
  children: BranchTreeNode[];
}

/** Folds `feat/x` under a `feat` folder, folders first, then branches by name. */
export function buildBranchTree(branches: BranchInfo[]): BranchTreeNode[] {
  const root: BranchTreeNode = { key: "", path: "", children: [] };
  const folders = new Map<string, BranchTreeNode>([["", root]]);
  for (const branch of branches) {
    const segments = branch.name.split("/");
    let parentPath = "";
    for (let i = 0; i < segments.length - 1; i++) {
      const folderPath = parentPath ? `${parentPath}/${segments[i]}` : segments[i];
      if (!folders.has(folderPath)) {
        const node: BranchTreeNode = { key: segments[i], path: folderPath, children: [] };
        folders.get(parentPath)?.children.push(node);
        folders.set(folderPath, node);
      }
      parentPath = folderPath;
    }
    folders.get(parentPath)?.children.push({
      key: segments[segments.length - 1],
      path: branch.name,
      branch,
      children: [],
    });
  }
  const sortNodes = (nodes: BranchTreeNode[]) => {
    nodes.sort((a, b) => (a.branch ? 1 : 0) - (b.branch ? 1 : 0) || a.key.localeCompare(b.key));
    nodes.forEach((n) => sortNodes(n.children));
  };
  sortNodes(root.children);
  return root.children;
}

export function leafCount(node: BranchTreeNode): number {
  return node.branch ? 1 : node.children.reduce((sum, child) => sum + leafCount(child), 0);
}

/** Every folder path above a branch, so the tree can reveal it. */
export function ancestorFolders(branchName: string): string[] {
  const segments = branchName.split("/");
  segments.pop();
  const paths: string[] = [];
  let acc = "";
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment;
    paths.push(acc);
  }
  return paths;
}
