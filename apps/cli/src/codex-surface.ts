/**
 * Where the User talks to Codex, and how they approve Notifai's hooks there.
 *
 * Codex runs no new or changed hook until the User approves it, and each
 * surface asks differently:
 * - the Codex CLI: `/hooks` (and a "Hooks need review" prompt at start);
 * - the ChatGPT desktop app and the Codex IDE extension: a Review hooks icon
 *   in the message box opens a dialog with Allow all / Allow selected, and
 *   Settings → Hooks lists every hook with its switch.
 *
 * The client names itself in the environment Codex gives the agent's shell
 * and its hooks: the desktop app sets `CODEX_INTERNAL_ORIGINATOR_OVERRIDE` to
 * `Codex Desktop`, the IDE extension to `codex_vscode`, T3 Code to `T3 Code`;
 * the CLI sets none. `CODEX_THREAD_ID` says the command runs inside Codex at
 * all. Anything else is unknown, and gets the line that covers both.
 */

export type CodexSurface = 'cli' | 'app' | 'ide'

/** Originators of the ChatGPT desktop app's Codex besides `Codex Desktop…`. */
const APP_ORIGINATORS: ReadonlySet<string> = new Set(['codex_work_desktop', 'codex_chatgpt_desktop'])

/** The Codex surface this command runs in, from its environment; null when not known. */
export function codexSurface(env: NodeJS.ProcessEnv): CodexSurface | null {
  const override = env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE']?.trim()
  if (override !== undefined && override !== '') {
    if (override === 'codex_vscode') return 'ide'
    if (override.startsWith('Codex Desktop') || APP_ORIGINATORS.has(override)) return 'app'
    // T3 Code and other clients of Codex's app-server have their own UI.
    return null
  }
  // An Orca chat drives Codex's app-server without naming itself.
  if (env['ORCA_STRUCTURED_SESSION'] === '1') return null
  return (env['CODEX_THREAD_ID']?.trim() ?? '') !== '' ? 'cli' : null
}

/** Both ways at once, for when the surface is not known. */
const BOTH = 'in the ChatGPT app or your editor, click the **Review hooks** icon by the message box; in the terminal, type `/hooks`'

/** Codex's line in the done message's "To start" list. */
export function codexNextStep(surface: CodexSurface | null, needsApproval: boolean): string {
  const inChat = surface === 'app' || surface === 'ide'
  if (!needsApproval) return inChat ? 'start a new chat' : 'open a new session'
  if (surface === 'cli') return 'open a new session, type `/hooks` and **approve the Notifai hooks**'
  if (inChat) return 'start a new chat, click the **Review hooks** icon by the message box and **allow the Notifai hooks**'
  return `open a new session and **approve the Notifai hooks**: ${BOTH}`
}

/** During setup: Codex's hooks still wait for the User. Setup warns, never waits. */
export function codexHooksWarning(surface: CodexSurface | null): string {
  const how = surface === 'cli'
    ? 'type `/hooks` in Codex and approve them.'
    : surface === 'app' || surface === 'ide'
      ? 'click the **Review hooks** icon by the message box in Codex and allow them.'
      : `${BOTH}.`
  return `⚠️ **Codex won't use Notifai until you approve its hooks:** ${how}`
}

/** The same warning for a person reading a terminal: no Markdown. */
export function codexHooksTerminalLine(surface: CodexSurface | null): string {
  return codexHooksWarning(surface).replace('⚠️', '⚠').replace(/\*\*|`/g, '')
}

/**
 * Outside setup (`doctor`, a refused `ask`): the line the agent ends its reply
 * with. The agent carries on meanwhile; nothing waits for the approval.
 */
export function codexHooksReminder(surface: CodexSurface | null, options: { off?: boolean } = {}): string {
  if (options.off === true) {
    const how = surface === 'cli'
      ? 'Type `/hooks` to do both.'
      : surface === 'app' || surface === 'ide'
        ? 'Open Settings → **Hooks** in Codex to do both.'
        : 'In the ChatGPT app or your editor, open Settings → **Hooks**; in the terminal, type `/hooks`.'
    return `**Keep in mind:** Codex won't use Notifai until you turn its hooks on and approve them. ${how}`
  }
  const how = surface === 'cli'
    ? 'Type `/hooks` and approve them.'
    : surface === 'app' || surface === 'ide'
      ? 'Click the **Review hooks** icon by the message box and allow them.'
      : 'In the ChatGPT app or your editor, click the **Review hooks** icon by the message box; in the terminal, type `/hooks`.'
  return `**Keep in mind:** Codex won't use Notifai until you approve its hooks. ${how}`
}
