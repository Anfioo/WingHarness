// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import type { ArchiveEntry } from '../worker/worker-types';

export type ArchiveNode = {
  id: string;
  name: string;
  entry?: ArchiveEntry;
  children?: ArchiveNode[];
};
export function archiveTree(entries: ArchiveEntry[]): ArchiveNode[] {
  const root: ArchiveNode = { id: '', name: '', children: [] };
  const folders = new Map<string, ArchiveNode>([['', root]]);
  for (const entry of entries) {
    const parts = entry.name.split('/').filter(Boolean);
    let parent = root;
    let path = '';
    for (let i = 0; i < parts.length; i++) {
      path += parts[i] + '/';
      if (i < parts.length - 1 || entry.directory) {
        let folder = folders.get(path);
        if (!folder) {
          folder = { id: path, name: parts[i], children: [] };
          folders.set(path, folder);
          parent.children!.push(folder);
        }
        parent = folder;
      } else
        parent.children!.push({ id: `file:${entry.index}:${entry.name}`, name: parts[i], entry });
    }
  }
  const collator = new Intl.Collator('zh-CN', { numeric: true });
  for (const folder of folders.values())
    folder.children!.sort(
      (a, b) => Number(!!b.children) - Number(!!a.children) || collator.compare(a.name, b.name),
    );
  return root.children!;
}
