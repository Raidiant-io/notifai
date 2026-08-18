import { openUrl } from './platform.js'
import type { CommandIo } from './commands-core.js'

// ---------------------------------------------------------------------------
// production IO
// ---------------------------------------------------------------------------

/**
 * Whether a human is driving this terminal.
 *
 * A TTY alone is NOT that evidence: agent harnesses frequently allocate a PTY
 * for the commands they run, and a prompt shown to an agent does not fail — it
 * hangs, because every prompt library waits on stdin rather than erroring. So
 * this also honours `CI` and an explicit `NOTIFAI_NO_INPUT=1` escape hatch,
 * and every interactive affordance stays strictly optional: anything `init`
 * can ask, a flag can answer.
 */
function isHumanTerminal(env: NodeJS.ProcessEnv): boolean {
  return (
    process.stdin.isTTY === true &&
    process.stdout.isTTY === true &&
    (env['CI'] ?? '') === '' &&
    (env['NOTIFAI_NO_INPUT'] ?? '') === ''
  )
}

/**
 * Lazy on purpose: the hook path runs in front of every prompt the user types,
 * and must not pay for a prompt library it will never show.
 */
async function clack() {
  return await import('@clack/prompts')
}

export function realIo(env: NodeJS.ProcessEnv = process.env): CommandIo {
  const interactive = () => isHumanTerminal(env)
  return {
    out: (line) => console.log(line),
    err: (line) => console.error(line),
    get interactive() {
      return interactive()
    },
    confirm: async (question, fallback = false) => {
      if (!interactive()) return fallback
      const p = await clack()
      const answer = await p.confirm({ message: question, initialValue: fallback })
      // Ctrl-C mid-prompt arrives as a cancel symbol, not a SIGINT; treat it
      // as the safe answer rather than letting a Symbol escape into logic.
      return p.isCancel(answer) ? false : answer
    },
    select: async (message, options) => {
      if (!interactive()) return null
      const p = await clack()
      const answer = await p.select({ message, options })
      return p.isCancel(answer) ? null : (answer as string)
    },
    multiselect: async (message, options, initial) => {
      if (!interactive()) return null
      const p = await clack()
      const answer = await p.multiselect({
        message,
        options,
        required: true,
        ...(initial !== undefined && initial.length > 0 ? { initialValues: initial } : {}),
      })
      return p.isCancel(answer) ? null : (answer as string[])
    },
    intro: async (title) => {
      if (!interactive()) return
      ;(await clack()).intro(title)
    },
    outro: async (message) => {
      if (!interactive()) return
      ;(await clack()).outro(message)
    },
    note: async (message, title) => {
      if (!interactive()) return
      ;(await clack()).note(message, title)
    },
    spinner: async (message) => {
      if (!interactive()) return null
      const progress = (await clack()).spinner()
      progress.start(message)
      return {
        message: (next) => progress.message(next),
        stop: (next) => progress.stop(next),
        error: (next) => progress.error(next),
      }
    },
    check: async (ok, message, tone) => {
      if (!interactive()) return
      const { log } = await clack()
      switch (tone ?? (ok ? 'ok' : 'bad')) {
        case 'ok':
          return log.success(message)
        case 'warn':
          return log.warn(message)
        case 'pending':
          // Never checked. `log.info` reads as neutral, which is the honest
          // rendering for a state no evidence was gathered about.
          return log.info(message)
        case 'bad':
          return log.error(message)
      }
    },
    openUrl,
  }
}
