#!/usr/bin/env node
/**
 * Cut a release from conventional commits. Never publishes, never pushes,
 * never prompts.
 *
 *   pnpm release           dry-run
 *   pnpm release --write   bump versions and changelogs
 *   pnpm release --cut     write, commit, tag
 *   pnpm release --github  also create GitHub Releases (implies --cut)
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { upsertChangelog } from './lib/changelog.mjs'
import { git, isClean, latestTag, listCommits, versionIntroducedAt } from './lib/git.mjs'
import { PACKAGES, compareUrl, unreleasedUrl } from './lib/packages.mjs'
import { planRelease } from './lib/release-plan.mjs'

const root = path.resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const json = takeFlag(args, '--json')
const write = takeFlag(args, '--write')
const cut = takeFlag(args, '--cut')
const github = takeFlag(args, '--github')
const only = takeAllOptions(args, '--package')
const apply = write || cut || github

if (args.length > 0) {
  fail(2, `unknown argument: ${args[0]}\n${usage()}`)
}
if (only.some((id) => !PACKAGES.some((pkg) => pkg.id === id))) {
  fail(2, `--package must be one of: ${PACKAGES.map((pkg) => pkg.id).join(', ')}`)
}

try {
  const current = PACKAGES.map((pkg) => ({
    id: pkg.id,
    version: readJson(pkg.manifest).version,
  }))
  const baselines = Object.fromEntries(PACKAGES.map((pkg) => [pkg.id, baselineFor(pkg, current)]))
  const from = earliestBaseline(baselines)
  const commits = listCommits(root, { from })
  const plan = planRelease({
    packages: current,
    commits,
    baselines,
    only: only.length > 0 ? only : undefined,
  })

  if (!plan.ok) fail(1, plan.errors.join('\n'))

  const changing = plan.packages.filter((pkg) => pkg.bump !== null)
  if (!json) printPlan(plan, apply)

  if (changing.length === 0) {
    if (json) console.log(JSON.stringify({ ok: true, dryRun: !apply, packages: plan.packages }, null, 2))
    else console.log('\nNothing to release.')
    process.exit(0)
  }

  if (apply) {
    assertWritable(changing)
    applyPlan(plan, changing)
    if (cut || github) {
      const subject = releaseSubject(changing)
      git(root, ['add', ...filesTouched(changing)])
      git(root, ['commit', '-m', subject])
      for (const pkg of changing) {
        git(root, ['tag', '-a', pkg.tag, '-m', tagMessage(pkg)])
      }
    }
    if (github) {
      for (const pkg of changing) createGithubRelease(pkg)
    }
  }

  if (json) {
    console.log(JSON.stringify({ ok: true, dryRun: !apply, packages: plan.packages }, null, 2))
  } else if (!apply) {
    console.log('\nNext: pnpm release --write    (files only)')
    console.log('      pnpm release --cut      (commit + annotated tags; no push, no publish)')
  } else if (!cut && !github) {
    console.log('\nWrote files. Review the diff, then pnpm release --cut')
  } else {
    console.log('\nTagged locally. Push the commit and tags from the canonical clone,')
    console.log('then publish only the packages that changed. See docs/RELEASING.md.')
  }
} catch (error) {
  fail(2, error instanceof Error ? error.message : String(error))
}

function baselineFor(pkg, current) {
  const tagged = latestTag(root, pkg.id === 'cli' ? 'v[0-9]*' : 'protocol-v[0-9]*')
  if (tagged) return tagged
  // A package with no tag of its own must not walk into pre-convention
  // history: those commits are prose and would fail the linter. Share the
  // CLI tag as the epoch until the first protocol-v* tag exists.
  const epoch = latestTag(root, 'v[0-9]*')
  if (epoch) return epoch
  const version = current.find((entry) => entry.id === pkg.id)?.version
  if (!version) return null
  return versionIntroducedAt(root, pkg.manifest, version)
}

function earliestBaseline(baselines) {
  const refs = Object.values(baselines).filter((value) => typeof value === 'string')
  if (refs.length === 0) return null
  let oldest = refs[0]
  let oldestTime = Number(git(root, ['log', '-1', '--format=%ct', oldest]))
  for (const ref of refs.slice(1)) {
    const time = Number(git(root, ['log', '-1', '--format=%ct', ref]))
    if (time < oldestTime) {
      oldest = ref
      oldestTime = time
    }
  }
  return oldest
}

function applyPlan(plan, changing) {
  const today = isoDate()
  for (const pkg of changing) {
    const spec = PACKAGES.find((entry) => entry.id === pkg.id)
    if (!spec) continue
    patchJson(spec.manifest, (manifest) => {
      manifest.version = pkg.to
    })
    const existing = readMaybe(spec.changelog)
    const next = upsertChangelog(existing, {
      version: pkg.to,
      date: today,
      groups: pkg.groups,
      compareUrl: (from) => compareUrl(from === null ? null : spec.tag(from), spec.tag(pkg.to)),
      unreleasedUrl: () => unreleasedUrl(spec.tag(pkg.to)),
    })
    writeFileSync(path.join(root, spec.changelog), next)
  }
  updateReadme(plan.packages)
}

function updateReadme(packages) {
  const readmePath = path.join(root, 'README.md')
  let readme = readFileSync(readmePath, 'utf8')
  for (const pkg of packages) {
    readme = readme.replace(new RegExp(`\`${escapeReg(pkg.name)}\` \\d+\\.\\d+\\.\\d+`), `\`${pkg.name}\` ${pkg.to}`)
  }
  const cli = packages.find((pkg) => pkg.id === 'cli')
  if (cli) {
    readme = readme.replace(/#v\d+\.\d+\.\d+/g, `#v${cli.to}`)
    readme = readme.replace(/`v\d+\.\d+\.\d+`/g, `\`v${cli.to}\``)
  }
  writeFileSync(readmePath, readme)
}

function assertWritable(changing) {
  if (isClean(root)) return
  const allowed = new Set(filesTouched(changing))
  const dirty = git(root, ['status', '--porcelain'])
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3).replace(/^"|"$/g, ''))
  const unexpected = dirty.filter((file) => !allowed.has(file))
  if (unexpected.length > 0) {
    fail(1, `working tree has unrelated changes:\n  ${unexpected.join('\n  ')}`)
  }
}

function filesTouched(changing) {
  const files = ['README.md']
  for (const pkg of changing) {
    const spec = PACKAGES.find((entry) => entry.id === pkg.id)
    if (!spec) continue
    files.push(spec.manifest, spec.changelog)
  }
  return files
}

function releaseSubject(changing) {
  const names = changing.map((pkg) => `${pkg.name} ${pkg.to}`).join(', ')
  return `chore(repo): release ${names}`
}

function tagMessage(pkg) {
  const lines = [`${pkg.name} ${pkg.to}`, '']
  for (const [section, items] of Object.entries(pkg.groups)) {
    if (items.length === 0) continue
    lines.push(section)
    for (const item of items) lines.push(`- ${item}`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

function createGithubRelease(pkg) {
  const body = tagMessage(pkg)
  execFileSync('gh', ['release', 'create', pkg.tag, '--title', `${pkg.name} ${pkg.to}`, '--notes', body], {
    cwd: root,
    stdio: 'inherit',
  })
}

function printPlan(plan, apply) {
  console.log(apply ? 'Release' : 'Release dry-run')
  for (const pkg of plan.packages) {
    const delta = pkg.bump === null ? 'no bump' : `${pkg.bump} → ${pkg.to}`
    console.log(`  ${pkg.name}  ${pkg.from}  ${delta}  tag ${pkg.tag}`)
    for (const commit of pkg.commits) {
      const mark = commit.breaking ? '!' : ' '
      console.log(`    ${commit.sha.slice(0, 7)}${mark} ${commit.type}  ${commit.description}`)
    }
  }
}

function readJson(relative) {
  return JSON.parse(readFileSync(path.join(root, relative), 'utf8'))
}

function patchJson(relative, mutate) {
  const full = path.join(root, relative)
  const manifest = JSON.parse(readFileSync(full, 'utf8'))
  mutate(manifest)
  writeFileSync(full, `${JSON.stringify(manifest, null, 2)}\n`)
}

function readMaybe(relative) {
  try {
    return readFileSync(path.join(root, relative), 'utf8')
  } catch {
    return ''
  }
}

function isoDate() {
  return new Date().toISOString().slice(0, 10)
}

function escapeReg(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function takeFlag(argv, name) {
  const at = argv.indexOf(name)
  if (at === -1) return false
  argv.splice(at, 1)
  return true
}

function takeAllOptions(argv, name) {
  const values = []
  let at = argv.indexOf(name)
  while (at !== -1) {
    const value = argv[at + 1]
    if (value === undefined) fail(2, `${name} requires a value`)
    values.push(value)
    argv.splice(at, 2)
    at = argv.indexOf(name)
  }
  return values
}

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function usage() {
  return `Usage:
  pnpm release                  print the plan
  pnpm release --write          bump package.json, CHANGELOG, README
  pnpm release --cut            write, commit, annotated tags
  pnpm release --github         --cut plus gh release create
  pnpm release --package cli    only one package
  pnpm release --json           machine-readable plan

Never publishes. Never pushes. Never prompts.`
}
