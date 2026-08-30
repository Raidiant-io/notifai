import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  createSkillManifest,
  portableLocalInstallerSource,
  shippedSkillBundle,
  stageShippedSkillBundle,
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

  it('rejects CRLF-transformed bytes instead of silently changing reviewed guidance', () => {
    const fixture = fixtureBundle()
    writeFileSync(path.join(fixture.skillRoot, 'SKILL.md'), '# Notifai\r\n')
    expect(verifySkillBundle(fixture.sourceRoot, '8.0.0')).toMatchObject({
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
  it('stages a verified machine-neutral local source and removes it afterward', () => {
    const cwd = mkdtempSync(path.join(os.tmpdir(), 'notifai-skill-project-'))
    const version = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const result = stageShippedSkillBundle(cwd, version.version)
    if (!result.ok) throw new Error(result.error)
    expect(path.isAbsolute(result.staged.source)).toBe(false)
    expect(result.staged.source).toMatch(/^\.\/\.notifai\/skill-source-/)
    expect(result.staged.source).not.toContain(os.homedir())
    const stagedRoot = path.resolve(cwd, result.staged.source)
    expect(verifySkillBundle(stagedRoot, version.version)).toMatchObject({ ok: true })

    result.staged.cleanup()
    expect(existsSync(stagedRoot)).toBe(false)
  })

  it('uses the explicit portable local grammar for a Windows project path', () => {
    expect(
      portableLocalInstallerSource(
        String.raw`C:\Users\person\project`,
        String.raw`C:\Users\person\project\.notifai\skill-source-123`,
        'win32',
      ),
    ).toBe('./.notifai/skill-source-123')
  })
})
