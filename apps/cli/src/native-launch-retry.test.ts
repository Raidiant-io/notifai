import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'vitest'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })))

function fixture(source: string, args: string[] = []) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-forward-')); roots.push(root)
  const child = path.join(root, 'child.mjs'), parent = path.join(root, 'parent.mjs')
  writeFileSync(child, source)
  writeFileSync(parent, `import { NativeSelectionChanged, retryNativeSelection } from ${JSON.stringify(new URL('../dist/native-launch-retry.js', import.meta.url).href)};
process.exitCode = await retryNativeSelection(new NativeSelectionChanged(process.execPath, 0),
  ${JSON.stringify([child, ...args])}, { cwd: process.cwd(), env: process.env, invokingNpmAdapterArtifact: 'consumed-adapter-locator' });
`)
  return { root, run: (input = '') => spawnSync(process.execPath, [parent], { cwd: root, encoding: 'utf8',
    input, timeout: 10_000, env: { ...process.env, NOTIFAI_HOOK_SOURCE_PID: 'original-harness' } }) }
}

it('forwards untouched stdin, argument boundaries, ancestry, adapter locator and failure status exactly once', () => {
  const args = ['space inside', '雪', '--json', '"quoted"', '']
  const f = fixture(String.raw`import { appendFileSync, readFileSync } from 'node:fs';
appendFileSync('effects', 'once\n');
process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input: readFileSync(0, 'utf8'),
  source: process.env.NOTIFAI_HOOK_SOURCE_PID, retry: process.env.NOTIFAI_NATIVE_RETRY,
  adapter: process.env.NOTIFAI_NPM_ADAPTER_ARTIFACT, cwd: process.cwd() }));
process.stderr.write('one failure'); process.exitCode = 7;
`, args)
  const input = '{"hook":"payload"}\nsecond line\n', result = f.run(input)
  expect(result.error).toBeUndefined()
  expect(result.status).toBe(7)
  expect(result.stderr).toBe('one failure')
  expect(JSON.parse(result.stdout)).toEqual({ args, input, source: 'original-harness', retry: '1',
    adapter: 'consumed-adapter-locator', cwd: realpathSync(f.root) })
  expect(readFileSync(path.join(f.root, 'effects'), 'utf8')).toBe('once\n')
})

it.skipIf(process.platform === 'win32')('preserves POSIX signal termination across the forwarded child', () => {
  const result = fixture("process.kill(process.pid, 'SIGTERM');").run()
  expect(result.error).toBeUndefined()
  expect(result.status).toBeNull()
  expect(result.signal).toBe('SIGTERM')
})
