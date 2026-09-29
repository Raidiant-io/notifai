import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'vitest'
import { hermesPluginDir, installHermesPlugin, preflightHermesPlugin, uninstallHermesPlugin } from './hermes-plugin.js'

const roots: string[] = []
afterAll(() => roots.forEach(root => rmSync(root, { recursive: true, force: true })))

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

it.skipIf(process.platform === 'win32')('refuses a discovered foreign entry point before installing', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-entrypoint-'))
  roots.push(root)
  const bin = path.join(root, 'bin')
  mkdirSync(bin)
  const hermes = path.join(bin, 'hermes')
  writeFileSync(hermes, '#!/bin/sh\nif [ "$1" = "--version" ]; then echo "Hermes Agent v0.21.5"; else echo "not enabled  entrypoint 1.0.0    notifai"; fi\n')
  chmodSync(hermes, 0o755)
  const env = { HOME: root, HERMES_HOME: path.join(root, 'hermes'), PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` }

  expect(() => preflightHermesPlugin(env)).toThrow(/foreign plugin/)
  expect(() => installHermesPlugin('/unused/adapter', env)).toThrow(/foreign plugin/)
})
