// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { expect, it } from 'vitest';
import { archiveTree } from '../archive-tree';
import type { ArchiveEntry } from '../../worker/worker-types';
const entry = (name: string, index: number, directory = false): ArchiveEntry => ({
  name,
  index,
  directory,
  size: 1,
  compressed: 1,
});
it('merges implicit and explicit directories and preserves extraction entries', () => {
  const file = entry('docs/chapters/one.txt', 0);
  const tree = archiveTree([file, entry('docs/', 1, true), entry('empty/', 2, true)]);
  expect(tree.map((node) => node.name)).toEqual(['docs', 'empty']);
  expect(tree[0].children![0].children![0].entry).toBe(file);
  expect(tree[1].children).toEqual([]);
});
it('keeps duplicates and special names without treating paths as object keys', () => {
  const tree = archiveTree([
    entry('__proto__/a.txt', 0),
    entry('__proto__/a.txt', 1),
    entry('10.txt', 2),
    entry('2.txt', 3),
  ]);
  expect(tree.map((node) => node.name)).toEqual(['__proto__', '2.txt', '10.txt']);
  expect(new Set(tree[0].children!.map((node) => node.id)).size).toBe(2);
});
it('indexes large directories without expanding their contents into the root', () => {
  const tree = archiveTree(Array.from({ length: 10000 }, (_, i) => entry(`docs/${i}.txt`, i)));
  expect(tree).toHaveLength(1);
  expect(tree[0].children).toHaveLength(10000);
});
