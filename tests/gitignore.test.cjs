const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

// The ported gitignore logic lives in src/lib/svn-core/gitignore.ts. Its only
// import is `import type { SvnStatus }`, which transpileModule elides.
const ROOT = path.resolve(__dirname, '..')
const context = { exports: {} }
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src/lib/svn-core/gitignore.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  context,
)
const { filterByGitignore, parseGitignore } = context.exports

test('gitignore hides matching tracked and unversioned paths', () => {
  const patterns = parseGitignore('*.log\n!keep.log')
  // The wire shape is camelCase here (statusCode), not the reference's status_code.
  const statuses = [
    { path: 'existing.log', status: 'modified', statusCode: 'modified', propStatus: 'none' },
    { path: 'new.log', status: 'unversioned', statusCode: 'unversioned', propStatus: 'none' },
    { path: 'keep.log', status: 'modified', statusCode: 'modified', propStatus: 'none' },
    { path: 'source.ts', status: 'modified', statusCode: 'modified', propStatus: 'none' },
  ]
  const visible = filterByGitignore(statuses, patterns)
  assert.deepEqual(Array.from(visible, (status) => status.path), ['keep.log', 'source.ts'])
  assert.equal(filterByGitignore(statuses, []).length, statuses.length)
})

test('last matching rule wins for files and directory ancestors', () => {
  const { isIgnored, createGitignoreMatcher } = context.exports
  const patterns = parseGitignore('build/\n!build/keep.ts\n*.tmp\n!keep.tmp\nkeep.tmp')
  for (const match of [(p) => isIgnored(p, patterns), createGitignoreMatcher(patterns, 2)]) {
    assert.equal(match('build/output.ts'), true)
    assert.equal(match('build/keep.ts'), false)
    assert.equal(match('other/source.ts'), false)
    assert.equal(match('keep.tmp'), true)
    assert.equal(match('build\\output.ts'), true)
    // Repeat after cache eviction to check that the answer is unchanged.
    assert.equal(match('build/keep.ts'), false)
  }
})

test('cached decisions avoid repeated regex work and rule changes use a new matcher', () => {
  const { createGitignoreMatcher } = context.exports
  let calls = 0
  const patterns = [
    { negation: false, dirOnly: false, regex: { test: () => { calls++; return true } } },
  ]
  const match = createGitignoreMatcher(patterns)
  assert.equal(match('a.ts'), true)
  assert.equal(match('a.ts'), true)
  assert.equal(calls, 1)
  assert.equal(createGitignoreMatcher(parseGitignore('!a.ts'))('a.ts'), false)
})