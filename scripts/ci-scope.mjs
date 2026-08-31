#!/usr/bin/env node
import {execFileSync} from 'node:child_process'
import {appendFileSync} from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {fileURLToPath} from 'node:url'
import {repositoryRoot} from './cross-platform.mjs'

const ZERO_SHA = '0'.repeat(40)
const SHA = /^[0-9a-f]{40}$/u
const allNative = () => ({ubuntu: true, macos: true, windows: true, dependencies: false})

function isDependencyInput(relative) {
  return relative === 'pnpm-lock.yaml' ||
    relative === 'pnpm-workspace.yaml' ||
    relative === 'package.json' ||
    relative.endsWith('/package.json')
}

function isUniversalInput(relative) {
  return relative.startsWith('.github/workflows/') ||
    relative === 'scripts/ci-scope.mjs' ||
    relative === 'scripts/ci-scope.test.mjs' ||
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'tsconfig.base.json',
      'eslint.config.js',
      'commitlint.config.js',
      '.gitleaks.toml',
    ].includes(relative)
}

function isMacBoundary(relative) {
  return relative.startsWith('apps/cli/src/') &&
    /(?:codex-wake|claude-wake|hook|hooks)/u.test(relative)
}

function isWindowsBoundary(relative) {
  return relative.startsWith('apps/cli/') ||
    relative.startsWith('packages/protocol/') ||
    /(?:packed|published-windows|cross-platform|chmod-cli-bin)/u.test(relative)
}

export function classifyPaths(paths, {allRisk = false} = {}) {
  if (allRisk || !Array.isArray(paths) || paths.length === 0) return allNative()
  if (paths.some(relative => typeof relative !== 'string' || relative.length === 0)) {
    return allNative()
  }

  const dependencies = paths.some(isDependencyInput)
  if (paths.some(isUniversalInput)) return {...allNative(), dependencies}

  const result = {ubuntu: false, macos: false, windows: false, dependencies}
  for (const relative of paths) {
    if (
      relative.startsWith('docs/') ||
      relative === 'README.md' ||
      relative === 'CONTRIBUTING.md' ||
      relative === 'SECURITY.md' ||
      relative === 'LICENSE' ||
      relative === 'NOTICE' ||
      relative === 'AGENTS.md' ||
      relative === 'CLAUDE.md' ||
      relative.endsWith('/README.md') ||
      relative.endsWith('/CHANGELOG.md')
    ) {
      continue
    }

    result.ubuntu = true
    if (isWindowsBoundary(relative)) result.windows = true
    if (isMacBoundary(relative)) result.macos = true
  }
  return result
}

export function classifyChange({eventName, base, head, repo = repositoryRoot}) {
  if (eventName === 'workflow_dispatch') return allNative()
  if (!['pull_request', 'push'].includes(eventName)) return allNative()
  if (!SHA.test(base ?? '') || base === ZERO_SHA || !SHA.test(head ?? '')) return allNative()

  try {
    const output = execFileSync(
      'git',
      ['diff', '--name-only', '--diff-filter=ACDMRTUXB', '-z', base, head],
      {cwd: repo, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']},
    )
    return classifyPaths(output.split('\0').filter(Boolean))
  } catch {
    return allNative()
  }
}

function argument(name) {
  const index = process.argv.indexOf(name)
  return index === -1 ? undefined : process.argv[index + 1]
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = classifyChange({
    eventName: argument('--event'),
    base: argument('--base'),
    head: argument('--head'),
    repo: argument('--repo') ?? repositoryRoot,
  })
  const output = argument('--output')
  if (output) {
    appendFileSync(
      output,
      `${Object.entries(result).map(([key, value]) => `${key}=${value}`).join('\n')}\n`,
    )
  }
  console.log(JSON.stringify(result))
}
