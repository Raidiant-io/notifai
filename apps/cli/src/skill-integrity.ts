import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

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
}

export interface VerifiedSkillBundle {
  sourceRoot: string
  skillRoot: string
  manifest: SkillManifest
}

export type SkillBundleResult =
  | { ok: true; bundle: VerifiedSkillBundle }
  | { ok: false; error: string }

export interface StagedSkillBundle {
  /** Machine-neutral path relative to the installer project cwd. */
  source: string
  cleanup(): void
}

/** Local-source grammar accepted by skills@1.5.23 on every supported host. */
export function portableLocalInstallerSource(
  cwd: string,
  source: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const paths = platform === 'win32' ? path.win32 : path.posix
  const relative = paths.relative(cwd, source).split(paths.sep).join('/')
  if (relative === '') return '.'
  if (relative === '..' || relative.startsWith('../')) return relative
  return `./${relative}`
}

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function portableRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join('/')
}

function skillFiles(root: string): Array<{ path: string; contents: Buffer }> {
  const files: Array<{ path: string; contents: Buffer }> = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else if (entry.isFile()) {
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
export function createSkillManifest(skillRoot: string, packageVersion: string): SkillManifest {
  const files = skillFiles(skillRoot)
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
    const actual = createSkillManifest(skillRoot, parsed.package_version)
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

/** Locate the generated bundle in a published install or a built source checkout. */
export function shippedSkillBundle(expectedPackageVersion?: string): SkillBundleResult {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
  const sourceRoot = path.join(
    moduleDirectory,
    path.basename(moduleDirectory) === 'dist' ? 'skill-source' : '../dist/skill-source',
  )
  return verifySkillBundle(sourceRoot, expectedPackageVersion)
}

/**
 * Copy the verified npm-bundled skill to a short-lived project-relative source
 * understood by the pinned native installer. The relative argument keeps the
 * installer lock free of account names and absolute paths; the copied install
 * remains after this staging directory is removed.
 */
export function stageShippedSkillBundle(
  cwd: string,
  packageVersion: string,
): { ok: true; staged: StagedSkillBundle } | { ok: false; error: string } {
  const bundle = shippedSkillBundle(packageVersion)
  if (!bundle.ok) return bundle
  let stagingRoot: string | undefined
  try {
    const stagingParent = path.join(cwd, '.notifai')
    mkdirSync(stagingParent, { recursive: true })
    stagingRoot = mkdtempSync(path.join(stagingParent, 'skill-source-'))
    cpSync(bundle.bundle.skillRoot, path.join(stagingRoot, 'notifai'), { recursive: true })
    cpSync(
      path.join(bundle.bundle.sourceRoot, 'manifest.json'),
      path.join(stagingRoot, 'manifest.json'),
    )
    const stagedVerification = verifySkillBundle(stagingRoot, packageVersion)
    if (!stagedVerification.ok) {
      rmSync(stagingRoot, { recursive: true, force: true })
      return stagedVerification
    }
    const verifiedStagingRoot = stagingRoot
    return {
      ok: true,
      staged: {
        source: portableLocalInstallerSource(cwd, verifiedStagingRoot),
        cleanup: () => rmSync(verifiedStagingRoot, { recursive: true, force: true }),
      },
    }
  } catch (error) {
    if (stagingRoot !== undefined) rmSync(stagingRoot, { recursive: true, force: true })
    return { ok: false, error: `could not stage the packaged notifai skill (${String(error)})` }
  }
}
