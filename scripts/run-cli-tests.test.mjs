import assert from 'node:assert/strict'
import {copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {spawnSync} from 'node:child_process'
import test from 'node:test'

test('CLI test runner resolves Vitest from the CLI package that owns it', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'notifai-cli-test-runner-'))
  const scripts = path.join(fixture, 'scripts')
  const cli = path.join(fixture, 'apps', 'cli')
  const vitest = path.join(cli, 'node_modules', 'vitest')
  try {
    mkdirSync(scripts, {recursive: true})
    mkdirSync(vitest, {recursive: true})
    copyFileSync('scripts/run-cli-tests.mjs', path.join(scripts, 'run-cli-tests.mjs'))
    writeFileSync(path.join(cli, 'package.json'), '{"type":"module"}\n')
    writeFileSync(
      path.join(vitest, 'package.json'),
      '{"name":"vitest","type":"module","exports":{"./vitest.mjs":"./vitest.mjs"}}\n',
    )
    writeFileSync(path.join(vitest, 'vitest.mjs'), 'process.exitCode = 0\n')

    const result = spawnSync(process.execPath, [path.join(scripts, 'run-cli-tests.mjs')], {
      cwd: fixture,
      encoding: 'utf8',
    })
    assert.equal(result.status, 0, result.stderr)
  } finally {
    rmSync(fixture, {recursive: true, force: true})
  }
})
