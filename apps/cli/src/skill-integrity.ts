import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const REPOSITORY = 'Raidiant-io/notifai'
const SKILL_DIRECTORY = 'skills/notifai'
const GITHUB_API = `https://api.github.com/repos/${REPOSITORY}`
const COMMIT_SHA = /^[0-9a-f]{40}$/

export interface SkillManifestFile {
  path: string
  sha256: string
  git_blob_sha1: string
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

export type VerifiedSkillSourceResult =
  | { ok: true; source: string; commit: string; digest: string }
  | { ok: false; error: string }

type FetchImpl = typeof fetch

function sha256(contents: Buffer): string {
  return createHash('sha256').update(contents).digest('hex')
}

function gitBlobSha1(contents: Buffer): string {
  return createHash('sha1')
    .update(`blob ${contents.byteLength}\0`)
    .update(contents)
    .digest('hex')
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
      git_blob_sha1: gitBlobSha1(file.contents),
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
        typeof file.sha256 === 'string' &&
        typeof file.git_blob_sha1 === 'string',
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

function githubHeaders(accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    Accept: accept,
    'User-Agent': '@raidiant/notifai skill-integrity',
    'X-GitHub-Api-Version': '2026-03-10',
  }
}

async function githubJson(fetchImpl: FetchImpl, url: string): Promise<unknown> {
  const response = await fetchImpl(url, {
    headers: githubHeaders(),
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`)
  return await response.json()
}

async function resolveTagCommit(fetchImpl: FetchImpl, tag: string): Promise<string> {
  const ref = (await githubJson(
    fetchImpl,
    `${GITHUB_API}/git/ref/tags/${encodeURIComponent(tag)}`,
  )) as { object?: { type?: unknown; sha?: unknown } }
  let type = ref.object?.type
  let sha = ref.object?.sha
  for (let depth = 0; type === 'tag' && depth < 4; depth += 1) {
    if (typeof sha !== 'string' || !COMMIT_SHA.test(sha)) {
      throw new Error('GitHub returned an invalid annotated tag object')
    }
    const tagObject = (await githubJson(fetchImpl, `${GITHUB_API}/git/tags/${sha}`)) as {
      object?: { type?: unknown; sha?: unknown }
    }
    type = tagObject.object?.type
    sha = tagObject.object?.sha
  }
  if (type !== 'commit' || typeof sha !== 'string' || !COMMIT_SHA.test(sha)) {
    throw new Error('the release tag does not resolve to one full commit SHA')
  }
  return sha
}

function remoteSkillFiles(tree: unknown): Map<string, { sha: string; type: string }> {
  if (tree === null || typeof tree !== 'object') throw new Error('GitHub returned a malformed tree')
  const candidate = tree as { truncated?: unknown; tree?: unknown }
  if (candidate.truncated === true) throw new Error('GitHub truncated the release tree')
  if (!Array.isArray(candidate.tree)) throw new Error('GitHub returned a malformed tree')
  const prefix = `${SKILL_DIRECTORY}/`
  const files = new Map<string, { sha: string; type: string }>()
  for (const item of candidate.tree) {
    if (item === null || typeof item !== 'object') continue
    const entry = item as { path?: unknown; sha?: unknown; type?: unknown }
    if (
      typeof entry.path !== 'string' ||
      !entry.path.startsWith(prefix) ||
      typeof entry.sha !== 'string' ||
      typeof entry.type !== 'string'
    ) {
      continue
    }
    if (entry.type !== 'tree') files.set(entry.path.slice(prefix.length), { sha: entry.sha, type: entry.type })
  }
  return files
}

async function verifyRemoteSkill(
  fetchImpl: FetchImpl,
  commit: string,
  bundle: VerifiedSkillBundle,
): Promise<void> {
  const commitObject = (await githubJson(fetchImpl, `${GITHUB_API}/commits/${commit}`)) as {
    commit?: { tree?: { sha?: unknown } }
  }
  const treeSha = commitObject.commit?.tree?.sha
  if (typeof treeSha !== 'string' || !COMMIT_SHA.test(treeSha)) {
    throw new Error('GitHub returned an invalid commit tree')
  }
  const tree = remoteSkillFiles(
    await githubJson(fetchImpl, `${GITHUB_API}/git/trees/${treeSha}?recursive=1`),
  )
  const expectedPaths = bundle.manifest.files.map((file) => file.path)
  const remotePaths = [...tree.keys()].sort()
  if (JSON.stringify(remotePaths) !== JSON.stringify(expectedPaths)) {
    throw new Error('the release tag skill file list differs from the npm package')
  }
  for (const file of bundle.manifest.files) {
    const remote = tree.get(file.path)
    if (remote?.type !== 'blob' || remote.sha !== file.git_blob_sha1) {
      throw new Error(`the release tag skill object differs at ${file.path}`)
    }
    const encodedPath = `${SKILL_DIRECTORY}/${file.path}`
      .split('/')
      .map((segment) => encodeURIComponent(segment))
      .join('/')
    const response = await fetchImpl(
      `${GITHUB_API}/contents/${encodedPath}?ref=${encodeURIComponent(commit)}`,
      {
        headers: githubHeaders('application/vnd.github.raw+json'),
        redirect: 'error',
        signal: AbortSignal.timeout(10_000),
      },
    )
    if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status} for ${file.path}`)
    const contents = Buffer.from(await response.arrayBuffer())
    if (sha256(contents) !== file.sha256) {
      throw new Error(`the release tag skill bytes differ at ${file.path}`)
    }
  }
}

/**
 * Turn the human-readable release tag into the content-addressed source given
 * to the external installer, but only after GitHub's tree matches npm's copy.
 */
export async function verifiedReleaseSkillSource(
  releaseSource: string,
  packageVersion: string,
  fetchImpl: FetchImpl = fetch,
): Promise<VerifiedSkillSourceResult> {
  const expectedSource = `${REPOSITORY}#v${packageVersion}`
  if (releaseSource !== expectedSource) {
    return { ok: false, error: `skill source ${releaseSource} does not match ${expectedSource}` }
  }
  const bundleResult = shippedSkillBundle(packageVersion)
  if (!bundleResult.ok) return bundleResult
  try {
    const commit = await resolveTagCommit(fetchImpl, `v${packageVersion}`)
    await verifyRemoteSkill(fetchImpl, commit, bundleResult.bundle)
    return {
      ok: true,
      source: `${REPOSITORY}#${commit}`,
      commit,
      digest: bundleResult.bundle.manifest.digest,
    }
  } catch (error) {
    return {
      ok: false,
      error: `could not bind the release tag to the shipped notifai skill (${String(error)})`,
    }
  }
}
