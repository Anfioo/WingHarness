// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
import { expect, it } from 'vitest';
import { htmlResources, localResource } from '../html-resources';
it('allows sibling and nested assets but rejects paths outside the directory', () => {
  expect(localResource('../img/a.png', 'css/main.css')).toBe('img/a.png');
  for (const path of [
    '../secret.css',
    '%2e%2e/secret.css',
    '/etc/passwd',
    'https://a/x.css',
    'file:///x.css',
    '\\server\\x.css',
  ])
    expect(localResource(path)).toBeNull();
});
it('inlines imported CSS and assets relative to the stylesheet once', async () => {
  const calls: string[] = [];
  const files: Record<string, string> = {
    'css/main.css': '@import "nested.css"; body{background:url(../img/a.png)}',
    'css/nested.css': 'p{color:red}',
    'img/a.png': 'image',
  };
  const resources = htmlResources(async (path) => {
    calls.push(path);
    return new TextEncoder().encode(files[path]);
  }, new AbortController().signal);
  const css = await resources.stylesheet('css/main.css');
  expect(css).toContain('p{color:red}');
  expect(css).toContain('data:image/png;base64,');
  await resources.stylesheet('css/main.css');
  expect(calls).toEqual(['css/main.css', 'css/nested.css', 'img/a.png']);
});
it('stops import cycles and does not read network resources', async () => {
  const calls: string[] = [];
  const resources = htmlResources(async (path) => {
    calls.push(path);
    return new TextEncoder().encode(
      '@import "a.css";body{background:url(https://example.com/x.png)}',
    );
  }, new AbortController().signal);
  expect(await resources.stylesheet('a.css')).toContain('url("")');
  expect(calls).toEqual(['a.css']);
});
it('does not start resource work after cancellation', async () => {
  const controller = new AbortController();
  controller.abort();
  let reads = 0;
  const resources = htmlResources(async () => {
    reads++;
    return new Uint8Array();
  }, controller.signal);
  await resources.stylesheet('a.css');
  expect(reads).toBe(0);
});
