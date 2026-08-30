import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { scanPackedTarballs } from './check-packed-boundary.mjs'

function fixtureTarball(root, name, files) {
  const staging = path.join(root, `${name}-staging`, 'package')
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(staging, relative)
    mkdirSync(path.dirname(absolute), { recursive: true })
    writeFileSync(absolute, content)
  }
  const tarball = path.join(root, `${name}.tgz`)
  execFileSync('tar', ['-czf', tarball, 'package'], { cwd: path.dirname(staging) })
  return tarball
}

function withFixture(run) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-packed-boundary-test-'))
  try {
    run(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

test('accepts a package whose generated map stays relative and source-free', () => {
  withFixture((root) => {
    const tarball = fixtureTarball(root, 'clean', {
      'package.json': '{"name":"control","version":"1.0.0"}\n',
      'dist/main.js': 'export const control = true\n',
      'dist/main.js.map': JSON.stringify({ version: 3, sources: ['../src/main.ts'], names: [], mappings: '' }),
    })
    const result = scanPackedTarballs({ tarballs: [tarball] })
    assert.deepEqual(result.failures, [])
    assert.equal(result.sourceMaps, 1)
  })
})

test('catches a boundary canary that exists only in generated packed output', () => {
  withFixture((root) => {
    const tarball = fixtureTarball(root, 'generated-canary', {
      'package.json': '{}\n',
      'dist/generated.js': 'export const endpoint = "https://control.fly.dev"\n',
    })
    const result = scanPackedTarballs({ tarballs: [tarball] })
    assert.ok(result.failures.some((failure) => failure.includes('hosting provider hostname')))
  })
})

test('rejects embedded source and source paths outside the package', () => {
  withFixture((root) => {
    const tarball = fixtureTarball(root, 'unsafe-map', {
      'package.json': '{}\n',
      'dist/main.js.map': JSON.stringify({
        version: 3,
        sources: ['../../../private/main.ts'],
        sourcesContent: ['private source'],
        names: [],
        mappings: '',
      }),
    })
    const result = scanPackedTarballs({ tarballs: [tarball] })
    assert.ok(result.failures.some((failure) => failure.includes('embeds sourcesContent')))
    assert.ok(result.failures.some((failure) => failure.includes('resolves outside the package')))
  })
})

test('rejects forbidden filenames and owner-specific absolute paths', () => {
  withFixture((root) => {
    const tarball = fixtureTarball(root, 'private-path', {
      'package.json': '{}\n',
      '.env': 'CONTROL=true\n',
      'dist/main.js': 'const home = "/Users/private-owner/project/file.ts"\n',
    })
    const result = scanPackedTarballs({ tarballs: [tarball] })
    assert.ok(result.failures.some((failure) => failure.includes('forbidden file package/.env')))
    assert.ok(result.failures.some((failure) => failure.includes('owner-specific absolute home path')))
  })
})

test('allows explicit documentation placeholders without allowing real home names', () => {
  withFixture((root) => {
    const tarball = fixtureTarball(root, 'placeholder', {
      'package.json': '{}\n',
      'dist/main.js': 'const example = "/Users/you/.config/notifai"\n',
    })
    assert.deepEqual(scanPackedTarballs({ tarballs: [tarball] }).failures, [])
  })
})
