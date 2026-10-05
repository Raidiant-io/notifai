#!/usr/bin/env node
// A small generated subset, always compiled from the canonical client modules.
import { chmodSync, copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { repositoryRoot } from './cross-platform.mjs'

const root = path.join(repositoryRoot, 'packages/installer'), output = path.join(root, 'dist')
rmSync(output, { recursive: true, force: true })
mkdirSync(path.join(output, 'shared'), { recursive: true })
mkdirSync(path.join(output, 'data'))
for (const name of ['main.mjs', 'bootstrap.mjs', 'platform.mjs']) copyFileSync(path.join(root, 'src', name), path.join(output, name))
for (const name of ['release-distribution.ts', 'release-archive.ts', 'release-path.ts', 'release-trust.ts', 'version.js', 'atomic-file.ts']) {
  const source = readFileSync(path.join(repositoryRoot, 'apps/cli/src', name), 'utf8')
  const result = ts.transpileModule(source, { fileName: name, reportDiagnostics: true,
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext, sourceMap: false } })
  if (result.diagnostics?.some(item => item.category === ts.DiagnosticCategory.Error)) throw new Error(`Installer module cannot compile: ${name}`)
  writeFileSync(path.join(output, 'shared', name.replace(/\.ts$/, '.js')), result.outputText)
}
copyFileSync(path.join(repositoryRoot, 'scripts/install.ps1'), path.join(output, 'data/install.ps1'))
chmodSync(path.join(output, 'main.mjs'), 0o755)
