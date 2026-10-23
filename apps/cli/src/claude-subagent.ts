/**
 * Which Claude Code subagent, if any, is running this `notifai ask`.
 *
 * Claude Code runs a subagent inside its root's process and gives the
 * subagent's shell the root's own variables, session id included, so a
 * subagent's question registers to the root Agent Session and its answer
 * reaches the root. To act on that answer the root needs to know that one of
 * its subagents asked, and which one. Nothing in the shell says so; Claude
 * Code's transcripts do. Claude Code writes each subagent's Bash call to that
 * subagent's own transcript (`<session>/subagents/agent-<id>.jsonl`, beside a
 * `.meta.json` with its type and description) before running it, and the
 * call's result after. The subagent asking is the one whose `notifai ask`
 * call is still waiting for its result.
 *
 * This names the asker; it never routes or authorizes anything, and the
 * question belongs to the root either way. Where the transcripts do not single
 * out one subagent (the root asking at the same moment, two subagents asking
 * the same question, a format this does not read), nobody is named and the
 * question reads as the root's own.
 */
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from 'node:fs'
import path from 'node:path'
import { claudeDescriptorDir } from './claude-wake.js'
import type { QuestionAsker } from './hook-types.js'

/** Enough of a transcript's end to hold the call that is running now. */
const TAIL_BYTES = 256 * 1024

const ASK_COMMAND = /\bnotifai\b[^\n]*?\bask\b/

const normalized = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()

function tail(file: string): string | null {
  let fd: number | null = null
  try {
    fd = openSync(file, 'r')
    const size = fstatSync(fd).size
    const length = Math.min(size, TAIL_BYTES)
    const buffer = Buffer.alloc(length)
    const read = readSync(fd, buffer, 0, length, size - length)
    const text = buffer.subarray(0, read).toString('utf8')
    // A first line cut by the read window is not evidence.
    return size > length ? text.slice(text.indexOf('\n') + 1) : text
  } catch {
    return null
  } finally {
    if (fd !== null) closeSync(fd)
  }
}

/** The commands of `notifai ask` Bash calls in this transcript that have no result yet. */
function waitingAsks(file: string): string[] {
  const text = tail(file)
  if (text === null) return []
  const calls = new Map<string, string>()
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    let record: unknown
    try { record = JSON.parse(line) } catch { continue }
    const content = (record as { message?: { content?: unknown } } | null)?.message?.content
    if (!Array.isArray(content)) continue
    for (const block of content as Array<Record<string, unknown>>) {
      if (block === null || typeof block !== 'object') continue
      if (block['type'] === 'tool_use' && block['name'] === 'Bash' && typeof block['id'] === 'string') {
        const command = (block['input'] as { command?: unknown } | undefined)?.command
        if (typeof command === 'string' && ASK_COMMAND.test(command)) calls.set(block['id'], command)
      } else if (block['type'] === 'tool_result' && typeof block['tool_use_id'] === 'string') {
        calls.delete(block['tool_use_id'])
      }
    }
  }
  return [...calls.values()]
}

interface SubagentMeta { agentType?: unknown; description?: unknown; finished?: unknown }

function readMeta(file: string): SubagentMeta | null {
  try {
    const value: unknown = JSON.parse(readFileSync(file, 'utf8'))
    return typeof value === 'object' && value !== null ? value as SubagentMeta : null
  } catch {
    return null
  }
}

/**
 * The subagent of this Claude Code session that is asking `questions` now,
 * or undefined when the transcripts do not single one out.
 */
export function claudeAskingSubagent(sessionId: string, env: NodeJS.ProcessEnv, questions: readonly string[]): QuestionAsker | undefined {
  if (!/^[0-9A-Za-z-]{1,128}$/.test(sessionId)) return undefined
  const projects = path.join(path.dirname(claudeDescriptorDir(env)), 'projects')
  let folders: string[]
  try { folders = readdirSync(projects) } catch { return undefined }
  const asking: Array<{ asker: QuestionAsker; commands: string[] }> = []
  for (const folder of folders) {
    const root = path.join(projects, folder)
    // The root asking at this moment is the ordinary case: it asked.
    if (waitingAsks(path.join(root, `${sessionId}.jsonl`)).length > 0) return undefined
    const subagents = path.join(root, sessionId, 'subagents')
    let files: string[]
    try { files = readdirSync(subagents) } catch { continue }
    for (const file of files) {
      const id = /^agent-([0-9A-Za-z_-]{1,64})\.jsonl$/.exec(file)?.[1]
      if (id === undefined) continue
      const meta = readMeta(path.join(subagents, `agent-${id}.meta.json`))
      if (meta?.finished === true) continue
      const commands = waitingAsks(path.join(subagents, file))
      if (commands.length === 0) continue
      asking.push({
        asker: {
          agent_id: id,
          ...(typeof meta?.agentType === 'string' && meta.agentType !== '' ? { agent_type: meta.agentType.slice(0, 80) } : {}),
          ...(typeof meta?.description === 'string' && meta.description !== '' ? { description: meta.description.slice(0, 120) } : {}),
        },
        commands,
      })
    }
  }
  if (asking.length === 1) return asking[0]!.asker
  // Several subagents asking at once: only the one whose call carries this question.
  const wanted = questions.map((text) => normalized(text).slice(0, 48)).filter((text) => text !== '')
  const matching = asking.filter(({ commands }) =>
    commands.some((command) => wanted.some((text) => normalized(command).includes(text))))
  return matching.length === 1 ? matching[0]!.asker : undefined
}

/** Native children share their root's environment. Once one exists, a shell's
 * session id alone cannot identify which conversation read guidance. */
export function claudeSessionHasSubagents(sessionId: string, env: NodeJS.ProcessEnv): boolean {
  if (!/^[0-9A-Za-z-]{1,128}$/.test(sessionId)) return true
  const projects = path.join(path.dirname(claudeDescriptorDir(env)), 'projects')
  let folders: string[]
  try { folders = readdirSync(projects) } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  if (folders.length > 256) return true
  return folders.some(folder => {
    try {
      return readdirSync(path.join(projects, folder, sessionId, 'subagents'))
        .some(name => /^agent-.+\.(jsonl|meta\.json)$/.test(name))
    } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ENOENT' }
  })
}
