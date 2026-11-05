const { test } = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const ts = require('typescript')
const vm = require('node:vm')

// The ported virtual-window math lives in src/lib/svn-core/virtual-window.ts.
const ROOT = path.resolve(__dirname, '..')
const context = { exports: {} }
vm.runInNewContext(
  ts.transpileModule(fs.readFileSync(path.join(ROOT, 'src/lib/svn-core/virtual-window.ts'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText,
  context,
)
const { getVirtualWindow } = context.exports

test('large lists mount only the visible range plus bounded overscan', () => {
  for (const count of [1000, 50000, 100000]) {
    for (const scrollTop of [0, 48000, count * 48]) {
      const range = getVirtualWindow(count, 48, scrollTop, 480)
      assert.ok(range.end - range.start <= 22)
      assert.ok(range.start >= 0 && range.end <= count)
      assert.equal(range.height, count * 48)
      assert.ok(range.start * 48 <= range.top)
      assert.ok(range.end * 48 >= range.top + 480)
    }
  }
})

test('shrinking data and resizing clamp the window without leaving a blank viewport', () => {
  const range = getVirtualWindow(3, 48, 900000, 480)
  assert.equal(range.top, 0)
  assert.equal(range.start, 0)
  assert.equal(range.end, 3)
  assert.equal(getVirtualWindow(0, 48, 100, 480).height, 0)
  assert.equal(getVirtualWindow(100, 48, 4700, 960).top, 3840)
})