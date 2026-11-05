const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

// Newly written for the port's rebuilt change panel: the pure selection model in
// src/features/svn-workspace/changes/model.ts. Its only value import is
// `buildChangeTree` from "@/lib/svn-core/change-tree", so the harness needs a
// tiny loader that resolves the "@/" alias the way tsconfig.json does. A modern
// target is required: the default (ES3) downlevels `[...set]` to a helper that
// reads `length` and silently produces an empty array for a Set.
const ROOT = path.resolve(__dirname, '..')
const COMPILER = { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
const cache = new Map()

function loadModule(absPath) {
  if (cache.has(absPath)) return cache.get(absPath)
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), { compilerOptions: COMPILER }).outputText
  const context = { exports: {} }
  cache.set(absPath, context.exports)
  context.require = (spec) => {
    let resolved
    if (spec.startsWith('@/')) resolved = path.join(ROOT, 'src', spec.slice(2))
    else if (spec.startsWith('.')) resolved = path.resolve(path.dirname(absPath), spec)
    else return {}
    if (!path.extname(resolved)) resolved += '.ts'
    return loadModule(resolved)
  }
  vm.runInNewContext(output, context)
  return context.exports
}

// Values produced inside the vm context carry that realm's Array prototype, which
// deepStrictEqual rejects; round-trip through JSON to compare in the host realm.
const host = (value) => JSON.parse(JSON.stringify(value))

const model = loadModule(path.join(ROOT, 'src/features/svn-workspace/changes/model.ts'))
const {
  CHANGE_FILTERS,
  matchesFilter,
  countFilter,
  searchEntries,
  flattenRows,
  filePathsBetween,
  applyToggle,
  allSelected,
  unionPaths,
} = model

const entry = (p, statusCode, propStatus = 'none') => ({
  path: p,
  status: statusCode,
  statusCode,
  propStatus,
  locked: false,
  history: false,
  switched: false,
})

// A small tree: src/{sub/c.ts, a.ts, b.ts} plus a root-level README.md.
const entries = [
  entry('src/a.ts', 'modified'),
  entry('src/b.ts', 'added'),
  entry('src/sub/c.ts', 'deleted'),
  entry('README.md', 'modified'),
]

test('the filter list is the fixed set of chips the panel renders', () => {
  assert.deepEqual(host(CHANGE_FILTERS), [
    'all',
    'modified',
    'added',
    'deleted',
    'unversioned',
    'conflicted',
    'missing',
  ])
})

test('matchesFilter groups the reference "Changes" set and honors property status', () => {
  assert.equal(matchesFilter(entry('a', 'normal'), 'all'), true)
  // modified is the "Changes" grouping: modified/added/deleted/replaced.
  for (const code of ['modified', 'added', 'deleted', 'replaced']) {
    assert.equal(matchesFilter(entry('a', code), 'modified'), true, code)
  }
  // A directory property change counts as modified even when the node text is not.
  assert.equal(matchesFilter(entry('d', 'normal', 'modified'), 'modified'), true)
  assert.equal(matchesFilter(entry('a', 'normal'), 'modified'), false)
  // Specific filters match only their own code.
  assert.equal(matchesFilter(entry('a', 'added'), 'added'), true)
  assert.equal(matchesFilter(entry('a', 'modified'), 'added'), false)
  assert.equal(matchesFilter(entry('a', 'deleted'), 'deleted'), true)
  assert.equal(matchesFilter(entry('a', 'unversioned'), 'unversioned'), true)
  assert.equal(matchesFilter(entry('a', 'missing'), 'missing'), true)
  // Conflicted matches either the text status or a property conflict.
  assert.equal(matchesFilter(entry('a', 'conflicted'), 'conflicted'), true)
  assert.equal(matchesFilter(entry('a', 'normal', 'conflicted'), 'conflicted'), true)
  assert.equal(matchesFilter(entry('a', 'modified'), 'conflicted'), false)
})

test('countFilter tallies the entries each chip would show', () => {
  const list = [
    entry('a', 'modified'),
    entry('b', 'modified'),
    entry('c', 'unversioned'),
    entry('d', 'missing'),
  ]
  assert.equal(countFilter(list, 'all'), 4)
  assert.equal(countFilter(list, 'modified'), 2)
  assert.equal(countFilter(list, 'unversioned'), 1)
  assert.equal(countFilter(list, 'conflicted'), 0)
})

test('searchEntries is a case-insensitive substring filter and blank query is identity', () => {
  assert.equal(searchEntries(entries, ''), entries)
  assert.equal(searchEntries(entries, '   '), entries)
  assert.deepEqual(
    host(searchEntries(entries, 'SRC').map((e) => e.path)),
    ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'],
  )
  assert.deepEqual(host(searchEntries(entries, 'readme').map((e) => e.path)), ['README.md'])
})

test('flattenRows marks directories and files and hides children of collapsed directories', () => {
  const rows = flattenRows(entries, new Set(), false)
  assert.deepEqual(
    host(rows.map((row) => [row.kind, row.path, row.depth])),
    [
      ['dir', 'src', 0],
      ['dir', 'src/sub', 1],
      ['file', 'src/sub/c.ts', 2],
      ['file', 'src/a.ts', 1],
      ['file', 'src/b.ts', 1],
      ['file', 'README.md', 0],
    ],
  )
  // A collapsed directory drops its whole subtree.
  assert.deepEqual(
    host(flattenRows(entries, new Set(['src']), false).map((row) => row.path)),
    ['src', 'README.md'],
  )
  // While searching, collapse is ignored so a match is never hidden.
  assert.equal(flattenRows(entries, new Set(['src']), true).length, rows.length)
})

test('directory-cascade toggling selects and clears every descendant target', () => {
  const rows = flattenRows(entries, new Set(), false)
  const directory = rows[0]
  assert.equal(directory.kind, 'dir')

  const selected = applyToggle([], directory.targets, true)
  assert.deepEqual(host([...selected].sort()), ['src/a.ts', 'src/b.ts', 'src/sub/c.ts'])
  assert.equal(allSelected(new Set(selected), directory.targets), true)

  // Unchecking the directory removes exactly those targets, keeping other picks.
  const withExtra = [...selected, 'README.md']
  const cleared = applyToggle(withExtra, directory.targets, false)
  assert.deepEqual(host(cleared), ['README.md'])
  assert.equal(allSelected(new Set(cleared), directory.targets), false)
  // An empty target list is never "all selected".
  assert.equal(allSelected(new Set(), []), false)
})

test('filePathsBetween is the inclusive shift range of files only, clamped to the rows', () => {
  const rows = flattenRows(entries, new Set(), false)
  // Rows 0..3 are src(dir), src/sub(dir), src/sub/c.ts, src/a.ts.
  assert.deepEqual(host(filePathsBetween(rows, 0, 3)), ['src/sub/c.ts', 'src/a.ts'])
  // Reversed anchors give the same range; directories in range are skipped.
  assert.deepEqual(host(filePathsBetween(rows, 3, 0)), ['src/sub/c.ts', 'src/a.ts'])
  // Out-of-range indices clamp instead of throwing.
  assert.deepEqual(host(filePathsBetween(rows, -5, 1)), [])
  assert.equal(host(filePathsBetween(rows, 0, 999)).at(-1), 'README.md')
})

test('unionPaths is an order-stable union used by select-all-visible', () => {
  assert.deepEqual(host(unionPaths(['src/a.ts'], ['src/a.ts', 'README.md'])), ['src/a.ts', 'README.md'])
  assert.deepEqual(host(unionPaths([], [])), [])
})

test('the "selected but filtered out" count counts hidden picks, mirroring the panel', () => {
  const list = [entry('a.ts', 'modified'), entry('b.ts', 'unversioned'), entry('c.ts', 'unversioned')]
  // The panel computes visible picks as matchesFilter -> searchEntries, then
  // counts selected paths that are not visible.
  const visiblePaths = new Set(
    searchEntries(
      list.filter((e) => matchesFilter(e, 'modified')),
      '',
    ).map((e) => e.path),
  )
  const selection = ['a.ts', 'b.ts', 'c.ts']
  const hiddenCount = selection.reduce((count, p) => count + (visiblePaths.has(p) ? 0 : 1), 0)
  assert.deepEqual([...visiblePaths], ['a.ts'])
  assert.equal(hiddenCount, 2)
  // Narrowing the search hides the already-selected match too.
  const searchedPaths = new Set(
    searchEntries(
      list.filter((e) => matchesFilter(e, 'all')),
      'b',
    ).map((e) => e.path),
  )
  assert.equal(selection.reduce((c, p) => c + (searchedPaths.has(p) ? 0 : 1), 0), 2)
})