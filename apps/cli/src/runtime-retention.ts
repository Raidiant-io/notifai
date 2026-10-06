import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from './atomic-file.js'
import { installationAccess, type InstallationAccess } from './installation-access.js'
import { withFileLock } from './file-lock.js'
import { canonicalPath } from './local-path.js'
import { sanitizeSessionId } from './config.js'
import { openclawHostWork } from './openclaw-host-state.js'

export interface RuntimeOwnerInspection {
  status: 'clear' | 'waiting_for_questions' | 'uncertain'
  sessions: Array<{ file: string; sessionId: string; builds: string[] }>
}

const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value)
function present(file: string): boolean {
  try { lstatSync(file); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error }
}

/** Linux documents this per-kernel-boot UUID. Other platforms retain builds
 * until an equally supported identity is available; clocks are not a substitute. */
export function osBootIdentity(): string | null {
  if (process.platform !== 'linux') return null
  try {
    const value = readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim()
    return uuid(value) ? value : null
  } catch { return null }
}

/** Indexes existing durable owners, including owners using another state root.
 * The session record remains the authority. No PID leases or installation lock
 * are added to ordinary hooks; owner registration uses their existing lock. */
export class RuntimeRetention {
  constructor(private readonly root: string, private readonly installationId: string,
    private readonly access: InstallationAccess = installationAccess(), private readonly boot: () => string | null = osBootIdentity) {
    if (!path.isAbsolute(root) || !uuid(installationId)) throw new Error('Invalid runtime retention identity')
  }
  private file(build: string, name: string): string {
    if (!/^[a-f0-9]{64}$/.test(build)) throw new Error('Invalid retained build')
    return path.join(this.root, 'runtime-retention', build, name)
  }
  private parents(file: string, create = false): void {
    const relative = path.relative(this.root, path.dirname(file))
    if (relative.startsWith('..') || path.isAbsolute(relative)) return // Durable state may use another state root.
    let directory = this.root
    for (const part of ['', ...relative.split(path.sep).filter(Boolean)]) {
      if (part) directory = path.join(directory, part)
      if (!present(directory)) { if (create) this.access.directory(directory); else return }
      const stat = lstatSync(directory)
      if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' &&
          (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error('Unsafe runtime retention directory')
      this.access.check(directory, true)
    }
  }
  private readValue(file: string, limit = 256 * 1024): unknown {
    this.parents(file)
    if (!present(file)) return undefined
    const stat = lstatSync(file)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit ||
        (typeof process.getuid === 'function' && (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error('Uncertain runtime retention record')
    this.access.check(file, false)
    return JSON.parse(readFileSync(file, 'utf8')) as unknown
  }
  private read(file: string, limit = 256 * 1024): Record<string, unknown> | null {
    const value = this.readValue(file, limit)
    if (value === undefined) return null
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid runtime retention record')
    return value as Record<string, unknown>
  }
  private save(file: string, value: Record<string, unknown>): void {
    this.parents(file, true)
    atomicWriteFileSync(file, JSON.stringify({ schema: 1, installation_id: this.installationId, ...value }) + '\n', {
      requireCurrentUserOwner: true, prepareTemporary: temporary => this.access.beforePublish(temporary),
    })
  }
  private ownedRecord(record: Record<string, unknown> | null): record is Record<string, unknown> {
    return record?.['schema'] === 1 && record['installation_id'] === this.installationId
  }
  private currentBoot(): string | null {
    const value = this.boot()
    return uuid(value) ? value : null
  }
  /** Caller holds installation.lock. Recovery deliberately retires again in
   * the recovery boot, conservatively retaining a partially committed update. */
  activate(from: string | null, to: string): void {
    if (from === to) return
    if (from !== null) this.save(this.file(from, 'retired.json'), { boot: this.currentBoot() })
    const file = this.file(to, 'retired.json')
    this.parents(file)
    rmSync(file, { force: true })
  }
  /** Caller holds the referenced session's existing state lock. Publish the
   * index and current boot BEFORE the reference can be released or handed off. */
  retain(build: string, sessionFile: string): void {
    const file = canonicalPath(sessionFile)
    const key = createHash('sha256').update(file).digest('hex')
    const ownerFile = this.file(build, `owners/${key}.json`), owner = this.read(ownerFile)
    if (!this.ownedRecord(owner) || owner['session_file'] !== file) this.save(ownerFile, { session_file: file })
    this.resume(build)
  }
  /** Resumption does not add an owner. The durable reference and its index
   * already exist, and the caller holds that owner's state lock. */
  resume(build: string): void {
    const boot = this.currentBoot()
    if (boot === null) return // Unknown-boot generations cannot be reclaimed.
    const resumedFile = this.file(build, 'resumed.json')
    const recorded = () => { const record = this.read(resumedFile); return this.ownedRecord(record) && record['boot'] === boot }
    if (!recorded()) {
      try { this.save(resumedFile, { boot }) }
      catch (error) { if (!recorded()) throw error } // Two owners may publish the same boot concurrently.
    }
  }
  /** Sidecars have independent persistence; a missing main state file cannot
   * erase an unreported handoff or a cached input. Caller holds state lock. */
  private pendingSidecars(file: string, hasState: boolean): boolean {
    const stem = file.slice(0, -5), journalFile = `${stem}.deliveries`
    const reportedMessages = new Set<string>()
    let pending = false
    withFileLock(`${journalFile}.lock`, () => {
      const journal = this.read(journalFile, 16 * 1024 * 1024)
      if (journal === null) return
      if (typeof journal['session_id'] !== 'string' ||
          sanitizeSessionId(journal['session_id']) !== path.basename(stem) || !Array.isArray(journal['entries'])) {
        throw new Error('Uncertain delivery journal')
      }
      for (const entry of journal['entries']) {
        if (!entry || typeof entry.attempt_id !== 'string' ||
            !['claimed', 'writing', 'written', 'failed', 'released'].includes(entry.stage) ||
            !entry.writer || !Number.isSafeInteger(entry.writer.pid) || entry.writer.pid <= 0 ||
            typeof entry.writer.start !== 'string' || !entry.subject ||
            !(entry.subject.type === 'answer' && typeof entry.subject.request_id === 'string' ||
              entry.subject.type === 'session_message' && typeof entry.subject.message_id === 'string')) {
          throw new Error('Uncertain delivery attempt')
        }
        if (entry.reported === undefined) pending = true
        else {
          if (!['handed_off', 'unconfirmed', 'released'].includes(entry.reported) ||
              !Number.isFinite(entry.reported_at)) throw new Error('Uncertain delivery receipt')
          if (entry.subject.type === 'session_message') reportedMessages.add(entry.subject.message_id)
        }
      }
    })
    const inputs = this.read(`${stem}.inputs.json`, 16 * 1024 * 1024)
    if (inputs !== null) {
      if (typeof inputs['session_id'] !== 'string' || sanitizeSessionId(inputs['session_id']) !== path.basename(stem) ||
          typeof inputs['incarnation'] !== 'string' || !Number.isSafeInteger(inputs['generation']) ||
          !Array.isArray(inputs['messages'])) throw new Error('Uncertain input cache')
      for (const message of inputs['messages']) {
        if (!message || typeof message.message_id !== 'string' || !/^sm_[A-Za-z0-9_-]+$/.test(message.message_id) ||
            typeof message.created_at !== 'string' || typeof message.agent_acknowledgement_text_required !== 'boolean' ||
            !(message.kind === 'note' && typeof message.body === 'string' || message.kind === 'answer_edit' &&
              typeof message.request_id === 'string' && typeof message.text === 'string' && Array.isArray(message.answers))) {
          throw new Error('Uncertain cached message')
        }
        // Reported messages leave their separate acknowledgement debt in the
        // main state. Without that state, do not assume the debt was settled.
        if (!hasState || !reportedMessages.has(message.message_id)) pending = true
      }
    }
    return pending
  }
  /** Uninstall preflight across the current state root and every indexed root.
   * Include unindexed siblings: legacy work in a discovered root still counts.
   * This is a work inventory, never process-absence or deletion authority. The
   * uninstall coordinator must close launch admission and recheck before edits. */
  inspectOwners(currentSessions: string): RuntimeOwnerInspection {
    const sessions: RuntimeOwnerInspection['sessions'] = []
    try {
      if (!path.isAbsolute(currentSessions)) throw new Error('Invalid session directory')
      const directories = new Set([canonicalPath(currentSessions)])
      const retention = path.join(this.root, 'runtime-retention')
      if (present(retention)) {
        this.parents(path.join(retention, '_'))
        for (const build of readdirSync(retention)) {
          const owners = this.file(build, 'owners')
          this.parents(path.join(owners, '_'))
          if (!present(owners)) continue
          for (const name of readdirSync(owners)) {
            const owner = this.read(path.join(owners, name)), file = owner?.['session_file']
            if (!this.ownedRecord(owner) || typeof file !== 'string' || !path.isAbsolute(file) ||
                canonicalPath(file) !== file || createHash('sha256').update(file).digest('hex') + '.json' !== name) {
              throw new Error('Uncertain owner index')
            }
            directories.add(path.dirname(file))
          }
        }
      }
      let pending = openclawHostWork(this.root, this.installationId, this.access)
      for (const directory of [...directories].sort()) {
        const retireFile = path.join(path.dirname(directory), 'retire-queue.json')
        if (present(retireFile)) withFileLock(`${retireFile}.lock`, () => {
          const queue = this.readValue(retireFile, 16 * 1024 * 1024)
          if (!Array.isArray(queue)) throw new Error('Uncertain retirement queue')
          if (queue.length > 0) pending = true
        })
        if (!present(directory)) continue
        const stat = lstatSync(directory)
        if (!stat.isDirectory() || stat.isSymbolicLink() || (typeof process.getuid === 'function' &&
            (stat.uid !== process.getuid() || (stat.mode & 0o022) !== 0))) throw new Error('Uncertain session directory')
        this.access.check(directory, true)
        const names = new Set(readdirSync(directory).flatMap(name => {
          const matched = /^([A-Za-z0-9_-]+)(?:\.json|\.inputs\.json|\.deliveries)$/.exec(name)
          return matched ? [`${matched[1]}.json`] : []
        }))
        for (const name of [...names].sort()) {
          const file = path.join(directory, name)
          withFileLock(`${file}.lock`, () => {
            const state = this.read(file, 16 * 1024 * 1024)
            if (this.pendingSidecars(file, state !== null)) pending = true
            if (state === null) return
            this.access.check(file, false)
            const sessionId = state['session_id']
            if (typeof sessionId !== 'string' || `${sanitizeSessionId(sessionId)}.json` !== name) throw new Error('Uncertain session identity')
            const references = state['runtime_builds'] ?? []
            if (!Array.isArray(references) || references.some(item => !item || !uuid(item.installation_id) ||
                typeof item.build !== 'string' || !/^[a-f0-9]{64}$/.test(item.build))) throw new Error('Uncertain runtime references')
            sessions.push({ file, sessionId, builds: references.filter(item => item.installation_id === this.installationId).map(item => item.build) })
            for (const field of ['pending', 'retiring', 'waiting_answers', 'delivered_answers', 'acknowledgement_due',
              'message_acknowledgement_due', 'openclaw_foreground_replies']) {
              const value = state[field]
              if (value !== undefined && !Array.isArray(value)) throw new Error('Uncertain pending work')
              if (Array.isArray(value) && value.length > 0) pending = true
            }
            if (state['accepted'] !== undefined) pending = true
            const native = state['native_answer_operations']
            if (native !== undefined && (!Array.isArray(native) || native.some(item => item === null || typeof item !== 'object'))) {
              throw new Error('Uncertain native answer state')
            }
            if (Array.isArray(native)) for (const item of native) {
              const acknowledgement = item.acknowledgement
              if (acknowledgement === undefined) { pending = true; continue }
              if (!acknowledgement || typeof acknowledgement !== 'object' ||
                  typeof acknowledgement.text !== 'string' || typeof acknowledgement.created_at !== 'string' ||
                  !Number.isFinite(Date.parse(acknowledgement.created_at)) ||
                  !item.report || !Number.isSafeInteger(item.report.reply_seq) || item.report.reply_seq < 1 ||
                  typeof item.report.reply_id !== 'string' || !/^rpl_[A-Za-z0-9_-]+$/.test(item.report.reply_id) ||
                  typeof item.request_id !== 'string' || !/^req_[A-Za-z0-9_-]+$/.test(item.request_id)) throw new Error('Uncertain native acknowledgement')
            }
            if (state['input_wake'] !== undefined) pending = true
            const wakes = state['input_wake_attempts']
            if (wakes !== undefined && !Array.isArray(wakes)) throw new Error('Uncertain input wakes')
            if (Array.isArray(wakes)) for (const wake of wakes) {
              if (!wake || !['prepared', 'sending', 'accepted', 'unknown', 'consumed', 'cancelled'].includes(wake.phase)) {
                throw new Error('Uncertain input wake')
              }
              if (!['consumed', 'cancelled'].includes(wake.phase)) pending = true
            }
          })
        }
      }
      return { status: pending ? 'waiting_for_questions' : 'clear', sessions }
    } catch { return { status: 'uncertain', sessions } }
  }
  /** A reason means retain. Malformed, unreadable or missing evidence cannot
   * turn into deletion authority. Called under installation.lock only. */
  reason(build: string): string | null {
    try {
      const boot = this.currentBoot()
      if (boot === null) return 'boot_identity_unknown'
      const retired = this.read(this.file(build, 'retired.json'))
      if (!this.ownedRecord(retired) || !uuid(retired['boot'])) return 'retirement_unknown'
      if (retired['boot'] === boot) return 'retired_this_boot'
      const resumed = this.read(this.file(build, 'resumed.json'))
      if (resumed !== null && (!this.ownedRecord(resumed) || !uuid(resumed['boot']))) return 'owner_state_uncertain'
      if (resumed?.['boot'] === boot) return 'resumed_this_boot'
      const owners = this.file(build, 'owners')
      if (!present(owners)) return null
      const directory = lstatSync(owners)
      if (!directory.isDirectory() || directory.isSymbolicLink()) return 'owner_state_uncertain'
      for (const name of readdirSync(owners)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) return 'owner_state_uncertain'
        const owner = this.read(path.join(owners, name))
        const file = owner?.['session_file']
        if (!this.ownedRecord(owner) || typeof file !== 'string' || !path.isAbsolute(file) ||
            createHash('sha256').update(file).digest('hex') + '.json' !== name || canonicalPath(file) !== file) return 'owner_state_uncertain'
        if (!present(file)) continue
        const retained = withFileLock(`${file}.lock`, () => {
          const state = this.read(file, 16 * 1024 * 1024)
          if (state === null || state['runtime_builds'] === undefined) return false
          const references = state['runtime_builds']
          if (!Array.isArray(references)) throw new Error('Invalid retained owner')
          return references.some(item => {
            if (!item || !uuid(item.installation_id) || typeof item.build !== 'string' || !/^[a-f0-9]{64}$/.test(item.build)) throw new Error('Invalid retained owner')
            return item.installation_id === this.installationId && item.build === build
          })
        })
        if (retained) return 'durable_owner'
      }
      // An owner could have resumed and settled while earlier records were
      // inspected. Its marker is written under its lock before losing the pin.
      if (this.read(this.file(build, 'resumed.json'))?.['boot'] === boot) return 'resumed_this_boot'
      return null
    } catch { return 'owner_state_uncertain' }
  }
}
