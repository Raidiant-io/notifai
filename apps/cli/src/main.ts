#!/usr/bin/env node
import { isatty } from 'node:tty'
import { cursorBareHookRun } from './cursor-imported-hook.js'
import { grokImportedHookRun } from './grok-imported-hook.js'
import { belowNodeFloor, nodeFloorMessage } from './node-floor.js'

// Imported hook copies are no-ops even when this Node cannot run the CLI.
if (cursorBareHookRun(process.argv.slice(2), process.env, isatty(0))) process.exit(0)
if (grokImportedHookRun(process.argv.slice(2), process.env)) process.exit(0)

// Optional hooks must never turn a missing runtime prerequisite into a
// harness denial (exit 2 blocks prompts and permissions in some harnesses).
// Explicit commands still explain the prerequisite before loading the CLI.
if (belowNodeFloor(process.version)) {
  if (process.argv[2] === 'hook') process.exit(0)
  for (const line of nodeFloorMessage(process.version)) process.stderr.write(`${line}\n`)
  process.exit(2)
}

await import('./main-run.js')
