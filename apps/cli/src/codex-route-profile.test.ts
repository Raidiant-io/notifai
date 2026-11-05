import { describe, expect, it } from 'vitest'
import { codexRouteProfile, type CodexRouteProfile } from './codex-surface.js'
import { codexPlaceOf, type CodexHostKind, type CodexPlace } from './session-place.js'

const ORCA_CHAT = { ORCA_STRUCTURED_SESSION: '1', ORCA_AGENT_SESSION_ID: 'codex_1', ORCA_ENVIRONMENT: '', ORCA_REMOTE_PAIRING: '' }
const ORCA_PANE = { ORCA_PANE_KEY: 'pane', ORCA_TERMINAL_HANDLE: 'term_1', ORCA_USER_DATA_PATH: '/u/orca' }

type Row = [name: string, env: NodeJS.ProcessEnv, hostKind: CodexHostKind, platform: NodeJS.Platform,
  profile: Pick<CodexRouteProfile, 'host' | 'steersCards' | 'textAnswers' | 'orcaChat'>, place: CodexPlace]

/** Which logic each Codex surface gets: the matrix the reports and docs describe. */
const SURFACES: Row[] = [
  ['plain codex terminal on the shared server', {}, 'shared-server', 'darwin',
    { host: null, steersCards: true, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['plain codex terminal hosting its own thread (--no-daemon)', { CODEX_THREAD_ID: 't' }, 'other', 'linux',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['codex terminal inside an Orca terminal', ORCA_PANE, 'other', 'darwin',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['codex terminal inside an Orca terminal, on the shared server', ORCA_PANE, 'shared-server', 'darwin',
    { host: null, steersCards: true, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['codex terminal started from an Orca chat\'s shell', ORCA_CHAT, 'other', 'darwin',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['Orca chat', ORCA_CHAT, 'app-server', 'darwin',
    { host: 'orca', steersCards: false, textAnswers: 'orca', orcaChat: true }, 'orca-chat'],
  ['Orca chat on a paired or remote Orca host', { ...ORCA_CHAT, ORCA_ENVIRONMENT: 'ssh:box' }, 'app-server', 'linux',
    { host: 'orca', steersCards: false, textAnswers: 'orca', orcaChat: false }, 'orca-chat'],
  ['T3 Code', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3' }, 'app-server', 'darwin',
    { host: 't3', steersCards: false, textAnswers: 't3', orcaChat: false }, 't3'],
  ['T3 Code (earlier spelling)', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3 Code' }, 'app-server', 'darwin',
    { host: 't3', steersCards: false, textAnswers: 't3', orcaChat: false }, 't3'],
  ['codex terminal started from a T3 Code shell', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'T3' }, 'other', 'darwin',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'terminal'],
  ['Codex desktop app', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'Codex Desktop' }, 'app-server', 'darwin',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'codex-app'],
  ['Codex IDE extension', { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: 'codex_vscode' }, 'app-server', 'linux',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'codex-app'],
  ['an app-server client Notifai cannot name', {}, 'app-server', 'linux',
    { host: null, steersCards: false, textAnswers: 'labels', orcaChat: false }, 'codex-app'],
  ['codex exec', {}, 'exec', 'linux',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'headless'],
  ['Windows, where the process kind cannot be read', { CODEX_THREAD_ID: 't' }, 'unknown', 'win32',
    { host: null, steersCards: false, textAnswers: 'none', orcaChat: false }, 'unknown'],
  // Where `ps` cannot tell the process kind, the environment decides, as before the process kind was read.
  ['Orca chat whose process kind cannot be read', ORCA_CHAT, 'unknown', 'darwin',
    { host: 'orca', steersCards: true, textAnswers: 'orca', orcaChat: true }, 'orca-chat'],
  // Windows runs no hub, so the Orca chat routes never act there.
  ['Windows Orca chat', ORCA_CHAT, 'unknown', 'win32',
    { host: 'orca', steersCards: false, textAnswers: 'orca', orcaChat: true }, 'orca-chat'],
]

describe('where a Codex session runs, and the logic it gets', () => {
  it.each(SURFACES)('%s', (_name, env, hostKind, platform, profile, place) => {
    expect(codexRouteProfile(env, hostKind, platform)).toMatchObject(profile)
    expect(codexPlaceOf({ hostKind, originatorOverride: env['CODEX_INTERNAL_ORIGINATOR_OVERRIDE'] ?? null,
      orcaStructured: env['ORCA_STRUCTURED_SESSION'] === '1' })).toBe(place)
  })

  it('tells the IDE extension from the Codex app by the thread\'s originator', () => {
    expect(codexPlaceOf({ hostKind: 'app-server', originator: 'codex_vscode' })).toBe('codex-ide')
  })
})
