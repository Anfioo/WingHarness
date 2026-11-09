// Ported from SpacePreview (MIT). See src-tauri/space-preview-core/UPSTREAM.md.
/* eslint-disable no-useless-escape -- The fixture is a JSON string containing escapes. */
import { expect, it } from 'vitest';
import { codeFolds } from '../code-folds';
it('folds nested JSON without treating string braces as structure', () => {
  expect([...codeFolds('{\n "a": [\n "}\\\"[",\n 1\n ]\n}', 'json')]).toEqual([
    [1, 4],
    [0, 5],
  ]);
});
it('ignores XML comments, CDATA and quoted angle brackets', () => {
  expect([
    ...codeFolds(
      '<root>\n<!-- <fake> -->\n<child x=">">\na\n</child>\n<![CDATA[<fake>]]>\n<empty/>\n</root>',
      'xml',
    ),
  ]).toEqual([
    [2, 4],
    [0, 7],
  ]);
});
it('does not fold one-line or unsupported text', () => {
  expect(codeFolds('{"a":1}', 'json').size).toBe(0);
  expect(codeFolds('{\nx\n}', 'sql').size).toBe(0);
});
