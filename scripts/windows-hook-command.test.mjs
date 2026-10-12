import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { buildHookConfig } from '../apps/cli/dist/install-hooks.js'

for (const shell of ['powershell', 'cmd']) {
  test(`Windows Codex hook preserves argv and UTF-8 stdin through ${shell}`, { skip: process.platform !== 'win32' }, () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hook-shell-'))
    try {
      const script = path.join(root, "spaces & dollar$ paren( quote' café.cjs")
      writeFileSync(script, `let input = ''; process.stdin.setEncoding('utf8');
process.stdin.on('data', bytes => input += bytes);
process.stdin.on('end', () => { process.stdout.write(JSON.stringify({ argv: process.argv.slice(2), input })); process.exit(JSON.parse(input).exit); });`)
      const command = buildHookConfig({ adapterPath: script, harness: 'codex', platform: 'win32', nodePath: process.execPath }).SessionStart[0].hooks[0].command
      for (const exit of [0, 7]) {
        const input = JSON.stringify({ text: 'héllø 東京', exit })
        const program = shell === 'cmd' ? 'cmd.exe' : 'powershell.exe'
        const args = shell === 'cmd' ? ['/d', '/s', '/c', `"${command}"`] : ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command]
        const result = spawnSync(program, args, { input, encoding: 'utf8', timeout: 15_000, windowsHide: true, windowsVerbatimArguments: shell === 'cmd' })
        assert.ifError(result.error)
        assert.equal(result.status === 0, exit === 0, result.stderr)
        const actual = JSON.parse(result.stdout)
        assert.deepEqual(actual.argv.slice(0, 7), ['hook', 'session-start', '--owner', 'notifai', '--harness', 'codex', '--integration-revision'])
        assert.match(actual.argv[7], /^[a-f0-9]{64}$/)
        assert.equal(actual.argv.length, 8)
        assert.equal(actual.input, input)
      }
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
}
