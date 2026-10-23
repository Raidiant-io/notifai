import { createHash } from 'node:crypto'
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bundledSkillRoot } from './distribution.js'

export interface SkillManifestFile {
  path: string
  sha256: string
}

export interface SkillManifest {
  schema_version: 1
  package_version: string
  skill: 'notifai'
  digest: string
  files: SkillManifestFile[]
  guidance?: { current: string; releases: Array<{ digest: string; note: string }> }
}

/** Bounded release-authored catalog; no receipt can supply these strings. */
export function isGuidanceCatalog(value: unknown): value is NonNullable<SkillManifest['guidance']> {
  if (value === null || typeof value !== 'object') return false
  const catalog = value as NonNullable<SkillManifest['guidance']>
  if (!/^[a-f0-9]{64}$/.test(catalog.current) || !Array.isArray(catalog.releases) ||
    catalog.releases.length === 0 || catalog.releases.length > 4096) return false
  const seen = new Set<string>()
  return catalog.releases.every(release => {
    if (release === null || typeof release !== 'object' || !/^[a-f0-9]{64}$/.test(release.digest) ||
      seen.has(release.digest) || typeof release.note !== 'string' || !release.note.trim() || Buffer.byteLength(release.note) > 16000) return false
    seen.add(release.digest)
    return true
  }) && catalog.releases.at(-1)?.digest === catalog.current
}

export interface VerifiedSkillBundle {
  sourceRoot: string
  skillRoot: string
  manifest: SkillManifest
}

export type SkillBundleResult =
  | { ok: true; bundle: VerifiedSkillBundle }
  | { ok: false; error: string }

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function portableRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

export interface SkillInspectionBudget { maxFiles: number; maxBytes: number; deadlineAt: number }

function skillFiles(root: string, budget?: SkillInspectionBudget): Array<{ path: string; contents: Buffer }> {
  const files: Array<{ path: string; contents: Buffer }> = []
  let bytes = 0
  const walk = (directory: string): void => {
    if (budget !== undefined && Date.now() >= budget.deadlineAt) throw new Error('local skill inspection budget exhausted')
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (budget !== undefined && Date.now() >= budget.deadlineAt) throw new Error('local skill inspection budget exhausted')
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
        if (budget !== undefined) {
          bytes += statSync(absolute).size
          if (files.length >= budget.maxFiles || bytes > budget.maxBytes) throw new Error('local skill inspection size exceeded')
        }
        files.push({ path: portableRelative(root, absolute), contents: readFileSync(absolute) })
      } else {
        throw new Error(`skill contains unsupported filesystem entry ${portableRelative(root, absolute)}`)
      }
    }
  }
  walk(root)
  return files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

/** Build the exact content identity stored beside the skill in the npm tarball. */
export function createSkillManifest(skillRoot: string, packageVersion: string, budget?: SkillInspectionBudget): SkillManifest {
  const files = skillFiles(skillRoot, budget)
  const digest = createHash('sha256')
  const manifestFiles = files.map((file): SkillManifestFile => {
    digest.update(file.path)
    digest.update('\0')
    digest.update(file.contents)
    digest.update('\0')
    return {
      path: file.path,
      sha256: sha256(file.contents),
    }
  })
  return {
    schema_version: 1,
    package_version: packageVersion,
    skill: 'notifai',
    digest: `sha256:${digest.digest('hex')}`,
    files: manifestFiles,
    ...(existsSync(path.join(skillRoot, '../guidance-changes.json')) ? { guidance: JSON.parse(readFileSync(path.join(skillRoot, '../guidance-changes.json'), 'utf8')) as NonNullable<SkillManifest['guidance']> } : {}),
  }
}

/** Content identity of one installed skill directory, or null when it cannot be read. */
export function skillTreeDigest(root: string): string | null {
  if (!existsSync(root)) return null
  try {
    return createSkillManifest(root, '').digest
  } catch {
    return null
  }
}

function isSkillManifest(value: unknown): value is SkillManifest {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as Partial<SkillManifest>
  return (
    candidate.schema_version === 1 &&
    typeof candidate.package_version === 'string' &&
    candidate.skill === 'notifai' &&
    typeof candidate.digest === 'string' &&
    (candidate.guidance === undefined || isGuidanceCatalog(candidate.guidance)) &&
    Array.isArray(candidate.files) &&
    candidate.files.every(
      (file) =>
        file !== null &&
        typeof file === 'object' &&
        typeof file.path === 'string' &&
        typeof file.sha256 === 'string',
    )
  )
}

function sameManifest(expected: SkillManifest, actual: SkillManifest): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual)
}

/** Verify a bundle before either its bytes or its manifest are trusted. */
export function verifySkillBundle(
  sourceRoot: string,
  expectedPackageVersion?: string,
  budget?: SkillInspectionBudget,
): SkillBundleResult {
  const skillRoot = path.join(sourceRoot, 'notifai')
  const manifestFile = path.join(sourceRoot, 'manifest.json')
  if (!existsSync(skillRoot) || !existsSync(manifestFile)) {
    return { ok: false, error: 'the installed CLI package has no shipped notifai skill bundle' }
  }
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestFile, 'utf8'))
    if (!isSkillManifest(parsed)) {
      return { ok: false, error: 'the shipped notifai skill manifest is malformed' }
    }
    if (
      expectedPackageVersion !== undefined &&
      parsed.package_version !== expectedPackageVersion
    ) {
      return {
        ok: false,
        error:
          `the shipped notifai skill belongs to CLI ${parsed.package_version}, ` +
          `not CLI ${expectedPackageVersion}`,
      }
    }
    const actual = createSkillManifest(skillRoot, parsed.package_version, budget)
    if (!sameManifest(parsed, actual)) {
      return {
        ok: false,
        error: 'the shipped notifai skill bytes do not match their package integrity manifest',
      }
    }
    return { ok: true, bundle: { sourceRoot, skillRoot, manifest: parsed } }
  } catch (error) {
    return { ok: false, error: `could not verify the shipped notifai skill (${String(error)})` }
  }
}

/** The directory holding the generated bundle (`notifai/` and `manifest.json`) in a published install or a built source checkout. */
export function shippedSkillSourceRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  return bundledSkillRoot() ?? path.join(
    moduleDirectory,
    path.basename(moduleDirectory) === 'dist' ? 'skill-source' : '../dist/skill-source',
  )
}

/** Locate the generated bundle in a published install or a built source checkout. */
export function shippedSkillBundle(expectedPackageVersion?: string, budget?: SkillInspectionBudget): SkillBundleResult {
  return verifySkillBundle(shippedSkillSourceRoot(), expectedPackageVersion, budget)
}
