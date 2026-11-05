const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const ts = require('typescript')

// The ported workspace snapshot logic lives in src/lib/svn-core/workspace-snapshot.ts.
// The storage key and wire shape are the port's own: camelCase fields, and the
// `svn-workspace-snapshots-v1` key rather than the reference's `orcasvn-...`.
const ROOT = path.resolve(__dirname, '..')
const KEY = 'svn-workspace-snapshots-v1'
const info = {
  path: '.',
  url: 'file:///repo',
  repositoryRoot: 'file:///repo',
  revision: 12,
  nodeKind: 'dir',
  schedule: 'normal',
}
const file = {
  path: 'changed.ts',
  status: 'modified',
  statusCode: 'modified',
  propStatus: 'none',
  locked: false,
  history: false,
  switched: false,
}

function harness() {
  const storage = new Map()
  const localStorage = {
    getItem: (key) => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
  }
  const context = { exports: {}, localStorage }
  const code = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'src/lib/svn-core/workspace-snapshot.ts'), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS } },
  ).outputText
  vm.runInNewContext(code, context)
  return { ...context.exports, storage, localStorage }
}

test('snapshot persists only the matching workspace/filter settings, including empty change lists', () => {
  const h = harness()
  h.cacheWorkspaceSnapshot('/a', [file], info, false)
  assert.equal(h.getWorkspaceSnapshot('/a', false).statusList[0].path, file.path)
  assert.equal(h.getWorkspaceSnapshot('/a', true), null)
  assert.equal(h.getWorkspaceSnapshot('/b', false), null)
  h.cacheWorkspaceSnapshot('/a', [], info, false)
  assert.equal(h.getWorkspaceSnapshot('/a', false).statusList.length, 0)
})

test('expired, malformed or partial status snapshots are ignored', () => {
  const h = harness()
  for (const value of [
    'bad json',
    '{}',
    JSON.stringify([{ path: '/a', savedAt: 0, gitignoreEnabled: false, statusList: [file], svnInfo: info }]),
    JSON.stringify([{ path: '/a', savedAt: Date.now(), gitignoreEnabled: false, statusList: [{ path: 'bad' }], svnInfo: info }]),
  ]) {
    h.storage.set(KEY, value)
    assert.equal(h.getWorkspaceSnapshot('/a', false), null)
  }
})

test('large change lists remove old snapshots and bounded eviction keeps recent workspaces', () => {
  const h = harness()
  h.cacheWorkspaceSnapshot('/a', [file], info, false)
  h.cacheWorkspaceSnapshot('/a', Array(1001).fill(file), info, false)
  assert.equal(h.getWorkspaceSnapshot('/a', false), null)
  for (let i = 0; i < 6; i++) h.cacheWorkspaceSnapshot('/' + i, [file], info, false)
  assert.equal(h.getWorkspaceSnapshot('/0', false), null)
  assert.equal(h.getWorkspaceSnapshot('/5', false).statusList.length, 1)
  h.invalidateWorkspaceSnapshot('/5')
  assert.equal(h.getWorkspaceSnapshot('/5', false), null)
})

test('oversized paths and storage failures cannot block workspace scans', () => {
  const h = harness()
  h.cacheWorkspaceSnapshot('/a', [{ ...file, path: 'x'.repeat(1024 * 1024) }], info, false)
  assert.equal(h.getWorkspaceSnapshot('/a', false), null)
  h.localStorage.setItem = () => {
    throw new Error('quota exceeded')
  }
  assert.doesNotThrow(() => h.cacheWorkspaceSnapshot('/a', [file], info, false))
  assert.doesNotThrow(() => h.invalidateWorkspaceSnapshot('/a'))
})