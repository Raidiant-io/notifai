#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { execCommand, repositoryRoot } from './cross-platform.mjs'

const root = repositoryRoot
const failures = []

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
}

function requireValue(ok, message) {
  if (!ok) failures.push(message)
}

const rootManifest = readJson('package.json')
const rootLicense = readFileSync(path.join(root, 'LICENSE'), 'utf8')
const packages = [
  {
    directory: 'apps/cli',
    manifest: readJson('apps/cli/package.json'),
    requiredFiles: ['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json'],
  },
  {
    directory: 'packages/protocol',
    manifest: readJson('packages/protocol/package.json'),
    requiredFiles: ['LICENSE', 'README.md', 'CHANGELOG.md', 'package.json', 'tsconfig.json'],
  },
]

requireValue(rootManifest.private === true, 'root workspace must remain private')
requireValue(rootManifest.version === undefined, 'root workspace must not advertise a package version')
requireValue(rootManifest.engines?.node === '>=20', 'root Node support must be exactly >=20')

const semver = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/
for (const entry of packages) {
  const { manifest, directory } = entry
  requireValue(semver.test(manifest.version), `${manifest.name}: version must be semver`)
  requireValue(manifest.license === 'Apache-2.0', `${manifest.name}: license must be Apache-2.0`)
  requireValue(manifest.engines?.node === '>=20', `${manifest.name}: Node support must be exactly >=20`)
  requireValue(manifest.publishConfig?.access === 'public', `${manifest.name}: publishConfig.access must be public`)
  requireValue(manifest.repository?.directory === directory, `${manifest.name}: repository.directory must be ${directory}`)
  requireValue(manifest.homepage === 'https://github.com/Raidiant-io/notifai#readme', `${manifest.name}: homepage is missing or unexpected`)
  requireValue(manifest.bugs?.url === 'https://github.com/Raidiant-io/notifai/issues', `${manifest.name}: bugs URL is missing or unexpected`)
  requireValue(
    readFileSync(path.join(root, directory, 'LICENSE'), 'utf8') === rootLicense,
    `${manifest.name}: package LICENSE must exactly match the repository LICENSE`,
  )
  requireValue(
    JSON.stringify(manifest.files) === JSON.stringify(['dist', 'src', 'tsconfig.json', 'CHANGELOG.md']),
    `${manifest.name}: files allowlist must be dist, src, tsconfig.json, CHANGELOG.md`,
  )

  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, specifier] of Object.entries(manifest[field] ?? {})) {
      requireValue(
        !specifier.startsWith('workspace:'),
        `${manifest.name}: ${field}.${dependency} must use a publishable semver specifier, not ${specifier}`,
      )
    }
  }

  let packed
  try {
    const output = execCommand(
      'pnpm',
      ['--filter', manifest.name, 'pack', '--dry-run', '--json'],
      { cwd: root, encoding: 'utf8' },
    )
    // `prepack` builds before packing, so anything the build prints lands on
    // stdout ahead of the JSON. Parse from the first brace rather than
    // assuming the whole stream is the document.
    packed = JSON.parse(output.slice(output.indexOf('{')))
  } catch (error) {
    failures.push(`${manifest.name}: could not inspect pnpm pack output (${String(error)})`)
    continue
  }

  const paths = packed.files.map((file) => file.path)
  for (const required of entry.requiredFiles) {
    requireValue(paths.includes(required), `${manifest.name}: packed artifact is missing ${required}`)
  }
  for (const file of paths) {
    const allowed =
      entry.requiredFiles.includes(file) || file.startsWith('dist/') || file.startsWith('src/')
    requireValue(allowed, `${manifest.name}: unexpected packed file ${file}`)
  }

  /**
   * The compiled tree must correspond, module for module, to the sources
   * packed beside it.
   *
   * This is the check that catches a stale build, and it catches it in both
   * directions: a source with no compiled output means the build never saw it,
   * and a compiled file with no source means the build output outlived the
   * module it came from. Version strings and file counts both looked correct
   * while exactly this correspondence was broken, which is how a release
   * shipped the previous version's code under a new number.
   */
  const modules = (prefix, extension) =>
    new Set(
      paths
        .filter((file) => file.startsWith(`${prefix}/`) && file.endsWith(extension))
        .filter((file) => !file.endsWith(`.test${extension}`) && !file.endsWith(`.d${extension}`))
        .map((file) => file.slice(prefix.length + 1, -extension.length)),
    )
  const sources = modules('src', '.ts')
  const compiled = modules('dist', '.js')
  for (const name of sources) {
    requireValue(
      compiled.has(name),
      `${manifest.name}: packed src/${name}.ts has no dist/${name}.js — the build is stale or incomplete`,
    )
  }
  for (const name of compiled) {
    requireValue(
      sources.has(name),
      `${manifest.name}: packed dist/${name}.js has no src/${name}.ts — leftover output from a deleted module`,
    )
  }
}

const cli = packages[0].manifest
const cliSource = readFileSync(path.join(root, 'apps/cli/src/main.ts'), 'utf8')
requireValue(!/\.version\(\s*['"]\d/.test(cliSource), 'CLI version must not be hardcoded in src/main.ts')

/**
 * Ask the built artifact what it thinks it is, rather than grepping for a
 * constant. The pin is derived from the manifest at runtime, so the only
 * meaningful question is what the shipped code actually resolves — which is
 * also the one thing a stale build cannot fake.
 */
const expectedSkillsSource = `Raidiant-io/notifai#v${cli.version}`
try {
  const derived = execFileSync(
    'node',
    ['-e', "import('./apps/cli/dist/release.js').then((m) => process.stdout.write(String(m.skillsSource())))"],
    { cwd: root, encoding: 'utf8' },
  ).trim()
  requireValue(
    derived === expectedSkillsSource,
    `built CLI resolves skill source ${derived || '<empty>'}, expected ${expectedSkillsSource}`,
  )
} catch (error) {
  failures.push(`could not resolve the built CLI skill source (${String(error)})`)
}
requireValue(
  !/SKILLS_SOURCE\s*=\s*['"]/.test(readFileSync(path.join(root, 'apps/cli/src/commands.ts'), 'utf8')),
  'skill source must stay derived from the package version, not reintroduced as a literal',
)

try {
  const reported = execFileSync('node', ['apps/cli/dist/main.js', '--version'], {
    cwd: root,
    encoding: 'utf8',
  }).trim()
  requireValue(reported === cli.version, `CLI reports ${reported || '<empty>'}, manifest says ${cli.version}`)
} catch (error) {
  failures.push(`could not execute built CLI version check (${String(error)})`)
}

const readme = readFileSync(path.join(root, 'README.md'), 'utf8').replace(/<!--[\s\S]*?-->/g, '')
for (const { manifest, directory } of packages) {
  requireValue(
    readme.includes(`\`${manifest.name}\` ${manifest.version}`),
    `README must name the current ${manifest.name} version (${manifest.version})`,
  )
  const changelog = readFileSync(path.join(root, directory, 'CHANGELOG.md'), 'utf8')
  requireValue(
    changelog.includes(`## [${manifest.version}]`),
    `${manifest.name}: CHANGELOG.md must have a section for ${manifest.version}`,
  )
}
requireValue(
  readme.includes(`#v${cli.version}`) && readme.includes(`\`v${cli.version}\``),
  `README skill pin must name the current CLI tag v${cli.version}`,
)
for (const relative of ['LICENSE', 'NOTICE', 'SECURITY.md', 'CONTRIBUTING.md', 'docs/BOUNDARY.md', 'docs/RELEASING.md']) {
  requireValue(readFileSync(path.join(root, relative), 'utf8').trim().length > 0, `${relative} must not be empty`)
}
requireValue(rootLicense.includes('Apache License'), 'LICENSE must contain Apache-2.0')

try {
  const licenses = JSON.parse(
    execCommand('pnpm', ['licenses', 'list', '--prod', '--json'], { cwd: root, encoding: 'utf8' }),
  )
  /**
   * Permissive licences cleared for redistribution inside an Apache-2.0
   * package: each grants use, modification and redistribution with no
   * copyleft and no obligation beyond preserving the notice.
   *
   * ISC is the OSI-approved simplification of BSD-2-Clause and is accepted as
   * equivalent in substance to MIT. It entered the tree with `picocolors`,
   * whose only job is to decide whether the terminal wants colour at all.
   *
   * This list stays short on purpose. It is a review gate, not a formality:
   * anything that is not plainly permissive belongs in front of a human
   * before it ships to npm.
   */
  const allowedLicenses = new Set(['Apache-2.0', 'MIT', 'BSD-3-Clause', 'ISC'])
  for (const license of Object.keys(licenses)) {
    requireValue(allowedLicenses.has(license), `production dependency license requires review: ${license}`)
  }
} catch (error) {
  failures.push(`could not inspect production dependency licenses (${String(error)})`)
}

if (process.env.GITHUB_REF_TYPE === 'tag') {
  const protocol = packages[1].manifest
  const name = process.env.GITHUB_REF_NAME
  requireValue(
    name === `v${cli.version}` || name === `protocol-v${protocol.version}`,
    `tag must be v${cli.version} or protocol-v${protocol.version}`,
  )
}

if (failures.length > 0) {
  console.error('Release check FAILED:')
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}

console.log(
  `Release check passed (${packages.map(({ manifest }) => `${manifest.name}@${manifest.version}`).join(', ')}).`,
)
