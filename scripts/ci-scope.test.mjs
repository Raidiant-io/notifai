import assert from 'node:assert/strict'
import test from 'node:test'
import {classifyChange, classifyPaths} from './ci-scope.mjs'

const all = {ubuntu: true, macos: true, windows: true, dependencies: false}
const none = {ubuntu: false, macos: false, windows: false, dependencies: false}

test('public change classes retain distinct Ubuntu, Windows, macOS, and dependency evidence', () => {
  const cases = [
    ['docs', ['docs/RELEASING.md'], none],
    ['protocol', ['packages/protocol/src/api.ts'], {...none, ubuntu: true, windows: true}],
    ['CLI', ['apps/cli/src/main.ts'], {...none, ubuntu: true, windows: true}],
    ['macOS wake', ['apps/cli/src/codex-wake.ts'], {...none, ubuntu: true, macos: true, windows: true}],
    ['guidance', ['skills/notifai/SKILL.md'], {...none, ubuntu: true}],
    ['packaging', ['scripts/verify-packed-install.mjs'], {...none, ubuntu: true, windows: true}],
    ['unknown', ['future/input.bin'], {...none, ubuntu: true}],
    ['workflow', ['.github/workflows/ci.yml'], all],
    ['classifier', ['scripts/ci-scope.test.mjs'], all],
    ['toolchain and dependencies', ['pnpm-lock.yaml'], {...all, dependencies: true}],
  ]

  for (const [name, paths, expected] of cases) {
    assert.deepEqual(classifyPaths(paths), expected, name)
  }
})

test('manual, empty, zero-SHA, malformed, and unavailable diffs select all intended gates', () => {
  assert.deepEqual(classifyChange({eventName: 'workflow_dispatch'}), all)
  assert.deepEqual(classifyPaths([]), all)
  assert.deepEqual(classifyChange({eventName: 'push', base: '0'.repeat(40), head: 'a'.repeat(40)}), all)
  assert.deepEqual(classifyChange({eventName: 'pull_request', base: 'bad', head: 'a'.repeat(40)}), all)
  assert.deepEqual(classifyChange({eventName: 'pull_request', base: 'a'.repeat(40), head: 'b'.repeat(40)}), all)
})
