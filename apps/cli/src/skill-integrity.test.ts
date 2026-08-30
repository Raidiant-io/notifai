import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createSkillManifest,
  shippedSkillBundle,
  verifiedReleaseSkillSource,
  verifySkillBundle,
  type SkillManifest,
} from './skill-integrity.js'

function fixtureBundle(): { sourceRoot: string; skillRoot: string; manifest: SkillManifest } {
  const sourceRoot = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-integrity-'))
  const skillRoot = path.join(sourceRoot, 'notifai')
  mkdirSync(path.join(skillRoot, 'references'), { recursive: true })
  writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Notifai\n')
  writeFileSync(path.join(skillRoot, 'references', 'setup.md'), '# Setup\n')
  const manifest = createSkillManifest(skillRoot, '8.0.0')
  writeFileSync(path.join(sourceRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  return { sourceRoot, skillRoot, manifest }
}

describe('packaged skill integrity', () => {
  it('accepts an exact file-for-file bundle', () => {
    const fixture = fixtureBundle()
    expect(verifySkillBundle(fixture.sourceRoot, '8.0.0')).toMatchObject({
      ok: true,
      bundle: { manifest: { digest: fixture.manifest.digest } },
    })
  })

  it('rejects changed or additional guidance even when the manifest was left in place', () => {
    const changed = fixtureBundle()
    writeFileSync(path.join(changed.skillRoot, 'SKILL.md'), '# Replaced\n')
    expect(verifySkillBundle(changed.sourceRoot, '8.0.0')).toMatchObject({
      ok: false,
      error: expect.stringContaining('do not match'),
    })

    const additional = fixtureBundle()
    writeFileSync(path.join(additional.skillRoot, 'unreviewed.md'), '# Added\n')
    expect(verifySkillBundle(additional.sourceRoot, '8.0.0')).toMatchObject({
      ok: false,
      error: expect.stringContaining('do not match'),
    })
  })

  it('ships a bundle whose manifest belongs to this exact CLI version', () => {
    const version = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(shippedSkillBundle(version.version)).toMatchObject({
      ok: true,
      bundle: { manifest: { package_version: version.version, skill: 'notifai' } },
    })
  })
})

function releaseFetch(
  manifest: SkillManifest,
  mutate?: (file: string, contents: Buffer) => Buffer,
): typeof fetch {
  const commit = 'a'.repeat(40)
  const tree = 'b'.repeat(40)
  const shipped = shippedSkillBundle(manifest.package_version)
  if (!shipped.ok) throw new Error(shipped.error)
  const contents = new Map(
    manifest.files.map((file) => [file.path, readFileSync(path.join(shipped.bundle.skillRoot, file.path))]),
  )
  return (async (input: string | URL | Request) => {
    const url = String(input)
    if (url.includes('/git/ref/tags/')) {
      return Response.json({ object: { type: 'commit', sha: commit } })
    }
    if (url.includes(`/commits/${commit}`)) {
      return Response.json({ commit: { tree: { sha: tree } } })
    }
    if (url.includes(`/git/trees/${tree}`)) {
      return Response.json({
        truncated: false,
        tree: manifest.files.map((file) => ({
          path: `skills/notifai/${file.path}`,
          type: 'blob',
          sha: file.git_blob_sha1,
        })),
      })
    }
    const marker = '/contents/skills/notifai/'
    const start = url.indexOf(marker)
    if (start !== -1) {
      const file = decodeURIComponent(url.slice(start + marker.length).split('?')[0] ?? '')
      const bytes = contents.get(file)
      if (bytes === undefined) return new Response('', { status: 404 })
      return new Response(mutate?.(file, bytes) ?? bytes)
    }
    return new Response('', { status: 404 })
  }) as typeof fetch
}

describe('release skill source verification', () => {
  it('hands the installer a full commit SHA only after the tag bytes match npm', async () => {
    const version = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const shipped = shippedSkillBundle(version.version)
    if (!shipped.ok) throw new Error(shipped.error)

    await expect(
      verifiedReleaseSkillSource(
        `Raidiant-io/notifai#v${version.version}`,
        version.version,
        releaseFetch(shipped.bundle.manifest),
      ),
    ).resolves.toEqual({
      ok: true,
      source: `Raidiant-io/notifai#${'a'.repeat(40)}`,
      commit: 'a'.repeat(40),
      digest: shipped.bundle.manifest.digest,
    })
  })

  it('refuses a moved tag whose skill bytes differ before invoking an installer', async () => {
    const version = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const shipped = shippedSkillBundle(version.version)
    if (!shipped.ok) throw new Error(shipped.error)

    await expect(
      verifiedReleaseSkillSource(
        `Raidiant-io/notifai#v${version.version}`,
        version.version,
        releaseFetch(shipped.bundle.manifest, (file, contents) =>
          file === 'SKILL.md' ? Buffer.from('# hostile replacement\n') : contents,
        ),
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: expect.stringContaining('skill bytes differ at SKILL.md'),
    })
  })
})
