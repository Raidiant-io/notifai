#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import process from 'node:process'
import { HELP, lintCommit, looksConventional } from './lib/conventional-commit.mjs'

const args = process.argv.slice(2)
const json = takeFlag(args, '--json')

try {
  const collected = collectMessages(args)
  const failures = []
  const skipped = []
  for (const { name, message, allowLegacy } of collected) {
    if (allowLegacy && !looksConventional(message)) {
      skipped.push(name)
      continue
    }
    const errors = lintCommit(message)
    if (errors.length > 0) failures.push({ name, errors, message })
  }
  const messages = collected

  if (json) {
    console.log(JSON.stringify({ ok: failures.length === 0, checked: messages.length, skipped, failures }, null, 2))
  } else if (failures.length > 0) {
    console.error('Commit check FAILED')
    for (const failure of failures) {
      console.error('')
      console.error(`  ${failure.name}`)
      for (const error of failure.errors) {
        for (const line of error.split('\n')) console.error(`    ${line}`)
      }
    }
    console.error('')
  }

  if (failures.length > 0) process.exit(1)
  if (!json) {
    const noun = messages.length === 1 ? 'commit' : 'commits'
    const skip = skipped.length > 0 ? `, ${skipped.length} pre-convention prose ignored` : ''
    console.log(`Commit check passed (${messages.length} ${noun}${skip}).`)
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(2)
}

function collectMessages(argv) {
  const file = takeOption(argv, '--file')
  const message = takeOption(argv, '--message')
  const range = takeOption(argv, '--range')
  const stdin = takeFlag(argv, '--stdin')

  if (argv.length > 0) {
    throw new Error(`unknown argument: ${argv[0]}\n${usage()}`)
  }

  const selected = [file, message, range, stdin ? '--stdin' : null].filter((value) => value !== null)
  if (selected.length > 1) throw new Error('use only one of --file, --message, --range, --stdin')

  if (file !== null) return [{ name: file, message: readFileSync(file, 'utf8'), allowLegacy: false }]
  if (message !== null) return [{ name: 'message', message, allowLegacy: false }]
  if (stdin) return [{ name: 'stdin', message: readFileSync(0, 'utf8'), allowLegacy: false }]
  if (range !== null) return commitsInRange(range, true)
  return commitsInRange('HEAD', false)
}

function commitsInRange(range, allowLegacy) {
  const format = '%H%x1f%s%x1f%b%x1e'
  const spec = range.includes('..') ? range : `${range}^!`
  let output
  try {
    output = execFileSync('git', ['log', '--format=' + format, spec], { encoding: 'utf8' })
  } catch (error) {
    throw new Error(`could not read git range ${range}: ${error instanceof Error ? error.message : String(error)}`)
  }
  const commits = []
  for (const record of output.split('\x1e')) {
    if (record.trim() === '') continue
    const [sha, subject, body] = record.replace(/^\n/, '').split('\x1f')
    if (!sha || subject === undefined) continue
    const message = (body ?? '').trim() === '' ? subject : `${subject}\n\n${body.trim()}`
    commits.push({ name: `${sha.slice(0, 7)} ${subject}`, message, allowLegacy })
  }
  if (commits.length === 0) throw new Error(`no commits in range ${range}`)
  return commits
}

function takeFlag(argv, name) {
  const at = argv.indexOf(name)
  if (at === -1) return false
  argv.splice(at, 1)
  return true
}

function takeOption(argv, name) {
  const at = argv.indexOf(name)
  if (at === -1) return null
  const value = argv[at + 1]
  if (value === undefined) throw new Error(`${name} requires a value`)
  argv.splice(at, 2)
  return value
}

function usage() {
  return `Usage:
  pnpm check:commit                  lint HEAD
  pnpm check:commit --message "..."  lint one message
  pnpm check:commit --file PATH      lint a commit-msg hook file
  pnpm check:commit --range A..B     lint every commit in the range
  pnpm check:commit --stdin          lint stdin

${HELP}`
}
