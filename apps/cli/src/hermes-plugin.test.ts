import { existsSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll,expect,it } from 'vitest'
import { hermesPluginDir,installHermesPlugin,uninstallHermesPlugin } from './hermes-plugin.js'
import type { IntegrationPublication } from './native-installation.js'

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))

it.skipIf(process.platform === 'win32')('uses one scoped host operation for setup, enable and removal, retaining interrupted source', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-host-contract-')); roots.push(root)
  const bin = path.join(root, 'bin'); mkdirSync(bin)
  // This host fixture tests the CLI boundary, not Hermes activation semantics.
  const host = path.join(bin, 'hermes')
  writeFileSync(host, `#!${process.execPath}
const fs = require('node:fs'), path = require('node:path'), url = require('node:url');
const args = process.argv.slice(2), target = path.join(process.env.HERMES_HOME, 'plugins', 'notifai');
if (args[0] === '--version') console.log('Hermes Agent v0.21.5');
else if (args[1] === 'list') { if (fs.existsSync(target)) console.log('enabled local 1.0.0 notifai'); }
else if (args[1] === 'install') {
  if (process.env.NOTIFAI_TEST_HOST_FAIL) process.exit(1);
  if (args.includes('--force')) process.exit(2);
  fs.mkdirSync(target, { recursive: true });
  for (const name of ['__init__.py', 'plugin.yaml']) fs.copyFileSync(path.join(url.fileURLToPath(args[2]), name), path.join(target, name));
} else if (args[1] === 'remove') fs.rmSync(target, { recursive: true, force: true });
`, { mode: 0o700 })
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }
  const operations: string[] = [], sources: string[] = []
  const publish: IntegrationPublication = action => action()
  publish.host = (input, action) => {
    operations.push(input.operation)
    if (input.source) sources.push(input.source)
    return action()
  }
  const installed = installHermesPlugin('/stable/adapter', env, undefined, publish)
  expect(operations).toEqual(['install'])
  expect(existsSync(sources[0]!)).toBe(false)
  const manifest = readFileSync(path.join(installed, 'plugin.yaml'), 'utf8')
  installHermesPlugin('/new/adapter', env, undefined, publish)
  expect(operations).toEqual(['install', 'enable'])
  expect(readFileSync(path.join(installed, 'plugin.yaml'), 'utf8')).toBe(manifest)
  expect(uninstallHermesPlugin(env, publish)).toBe(true)
  expect(operations).toEqual(['install', 'enable', 'remove'])
  expect(() => installHermesPlugin('/stable/adapter', { ...env, NOTIFAI_TEST_HOST_FAIL: '1' }, undefined, publish)).toThrow(/Hermes/)
  const retained = sources.at(-1)!; roots.push(retained)
  expect(existsSync(path.join(retained, '__init__.py'))).toBe(true)
})

it('leaves a foreign Hermes plugin with the same name untouched', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-foreign-'))
  roots.push(root)
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes') }
  const dir = hermesPluginDir(env)
  mkdirSync(dir, { recursive: true })
  const source = '# foreign plugin\n'
  writeFileSync(path.join(dir, '__init__.py'), source)
  writeFileSync(path.join(dir, 'plugin.yaml'), 'name: notifai\n')

  expect(() => installHermesPlugin('/unused/adapter', env)).toThrow(/foreign/)
  expect(() => uninstallHermesPlugin(env)).toThrow(/foreign/)
  expect(readFileSync(path.join(dir, '__init__.py'), 'utf8')).toBe(source)
})




// A copy of Hermes's render loop (hermes_cli/plugins.py,
// PluginManager.render_system_prompt_sections, unchanged in what it decides
// from v0.20.6 through v0.22.4): sections in id order, the section count
// checked before a section is rendered, then each at most its max_chars and
// all within one shared 8,000-character budget. It is a copy, so it proves
// the plugin's side only. Prompt freezing and history are not modelled,
// because the plugin depends on neither.

// Stands in for the Notifai CLI: two sections when the plugin asks for them,
// or one context as an earlier CLI prints whatever the plugin asks.
