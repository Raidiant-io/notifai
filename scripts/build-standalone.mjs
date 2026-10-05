#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { commandInvocation, repositoryRoot } from './cross-platform.mjs'

const { values } = parseArgs({ options: {
  bun: { type: 'string', default: 'bun' },
  target: { type: 'string', default: `bun-${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}` },
  out: { type: 'string' },
  development: { type: 'boolean', default: false },
} })
const runtime = '1.4.2'
const targets = new Set(['bun-darwin-arm64', 'bun-darwin-x64',
  'bun-windows-x64', 'bun-windows-arm64', 'bun-linux-x64', 'bun-linux-arm64'])
if (!targets.has(values.target)) throw new Error(`Unsupported target: ${values.target}`)
if (!values.out) throw new Error('--out is required')
const run = (command, args) => execFileSync(command, args, {
  cwd: repositoryRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
})
if (run(values.bun, ['--version']).trim() !== runtime) throw new Error(`Build requires Bun ${runtime}`)
const sourceDirty = run('git', ['status', '--porcelain']).trim() !== ''
if (!values.development && sourceDirty) {
  throw new Error('Release builds require clean source; use --development only for local proof')
}
// The CLI imports built protocol exports and embeds the generated skill bundle.
// Regenerate both so a stale local dist directory cannot become release input.
for (const name of ['@raidiant/notifai-protocol', '@raidiant/notifai']) {
  const command = commandInvocation('pnpm', ['--filter', name, 'build'])
  execFileSync(command.file, command.args, { cwd: repositoryRoot, stdio: 'inherit', ...command.options })
}
const hash = createHash('sha256')
for (const file of run('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).split('\0').filter(Boolean).sort()) {
  hash.update(file).update('\0').update(readFileSync(path.join(repositoryRoot, file))).update('\0')
}
const identity = {
  version: JSON.parse(readFileSync(path.join(repositoryRoot, 'apps/cli/package.json'), 'utf8')).version,
  sourceRevision: run('git', ['rev-parse', 'HEAD']).trim(),
  sourceDirty,
  sourceDigest: hash.digest('hex'),
  target: values.target,
  runtime: `bun-${runtime}`,
}
const output = path.resolve(values.out)
mkdirSync(path.dirname(output), { recursive: true })
run(values.bun, ['build', '--compile', `--target=${values.target}`,
  '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
  '--no-compile-autoload-package-json', '--no-compile-autoload-tsconfig',
  '--asset=apps/cli/dist/skill-source',
  '--define', `NOTIFAI_COMPILED_BUILD=${JSON.stringify(identity)}`,
  'apps/cli/src/main.ts', '--outfile', output])
writeFileSync(`${output}.build.json`, `${JSON.stringify(identity, null, 2)}\n`)
process.stdout.write(`${output}\n`)
