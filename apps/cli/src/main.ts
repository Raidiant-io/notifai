#!/usr/bin/env node
import { belowNodeFloor, nodeFloorMessage } from './node-floor.js'

// Before anything else is parsed. `node-floor.js` imports nothing and uses no
// syntax newer than the floor it checks, so it can report on the runtimes that
// would otherwise fail somewhere in a dependency with no mention of Notifai.
if (belowNodeFloor(process.version)) {
  for (const line of nodeFloorMessage(process.version)) process.stderr.write(`${line}\n`)
  process.exit(2)
}

await import('./main-run.js')
