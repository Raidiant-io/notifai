import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { EXIT, hookRunCommand, type CommandDeps, type CommandIo } from './commands.js'
import { createLogger } from './logging.js'

const worker = process.env['NOTIFAI_SESSION_END_WORKER']

class SilentIo implements CommandIo {
  out(): void {}
  err(): void {}
  async confirm(): Promise<boolean> {
    return false
  }
  openUrl(): void {}
}

if (worker === undefined) {
  describe('SessionEnd process worker', () => {
    it('stays dormant outside the hook-budget regression', () => {
      expect(worker).toBeUndefined()
    })
  })
} else {
  describe('SessionEnd process worker', () => {
    it('isolates a contended lifecycle log after local cleanup', async () => {
      const env = process.env
      const cwd = env['NOTIFAI_SESSION_END_CWD']!
      const sessionId = env['NOTIFAI_SESSION_END_SESSION']!
      const logger = createLogger({ env, cmd: 'hook session-end' })
      const deps: CommandDeps = {
        io: new SilentIo(),
        store: {
          load: () => null,
          save: () => undefined,
          clear: () => undefined,
          describe: () => 'unused test credential store',
        },
        env,
        cwd,
        logger,
      }

      writeFileSync(env['NOTIFAI_SESSION_END_READY']!, 'ready')
      const code = await hookRunCommand(
        deps,
        'session-end',
        async () => JSON.stringify({ session_id: sessionId, cwd }),
        'codex',
      )

      expect(code).toBe(EXIT.ok)
      expect(logger.enabled).toBe(false)
    })
  })
}
