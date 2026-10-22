import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { claudeDialogExpiry, claudeRemoteControlAtStartup, claudeRemotePickerCheck } from './claude-remote-pickers.js'

function claudeHome(settings?: Record<string, unknown>, globalConfig?: Record<string, unknown>): { env: NodeJS.ProcessEnv; project: string } {
  const root = mkdtempSync(path.join(tmpdir(), 'notifai-remote-pickers-'))
  const config = path.join(root, 'claude')
  const project = path.join(root, 'project')
  mkdirSync(config, { recursive: true })
  mkdirSync(path.join(project, '.claude'), { recursive: true })
  if (settings !== undefined) writeFileSync(path.join(config, 'settings.json'), JSON.stringify(settings))
  if (globalConfig !== undefined) writeFileSync(path.join(config, '.claude.json'), JSON.stringify(globalConfig))
  return { env: { HOME: root, CLAUDE_CONFIG_DIR: config }, project }
}

describe('Claude Code Remote Control and question pickers', () => {
  it('reads the dialog expiry Claude Code applies to a picker forwarded to a remote client', () => {
    expect(claudeDialogExpiry(claudeHome().env, [])).toEqual({ ms: 300_000, source: 'default' })
    expect(claudeDialogExpiry(claudeHome({ dialogExpiry: '10m' }).env, [])).toEqual({ ms: 600_000, source: 'settings' })
    expect(claudeDialogExpiry(claudeHome({ dialogExpiry: 'never' }).env, [])).toEqual({ ms: null, source: 'settings' })
    // An unknown value is ignored, as Claude Code ignores it.
    expect(claudeDialogExpiry(claudeHome({ dialogExpiry: '1h' }).env, [])).toEqual({ ms: 300_000, source: 'default' })
    // The environment variable overrides the setting; zero or less means never.
    const { env } = claudeHome({ dialogExpiry: 'never' })
    expect(claudeDialogExpiry({ ...env, CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '90000' }, [])).toEqual({ ms: 90_000, source: 'env' })
    expect(claudeDialogExpiry({ ...env, CLAUDE_CODE_USER_DIALOG_TIMEOUT_MS: '0' }, [])).toEqual({ ms: null, source: 'env' })
  })

  it('takes the dialog expiry from local settings first, never from a checked-in project file', () => {
    const { env, project } = claudeHome({ dialogExpiry: '10m' })
    writeFileSync(path.join(project, '.claude', 'settings.json'), JSON.stringify({ dialogExpiry: 'never' }))
    expect(claudeDialogExpiry(env, [project])).toEqual({ ms: 600_000, source: 'settings' })
    writeFileSync(path.join(project, '.claude', 'settings.local.json'), JSON.stringify({ dialogExpiry: '60s' }))
    expect(claudeDialogExpiry(env, [project])).toEqual({ ms: 60_000, source: 'settings' })
  })

  it('sees Remote Control set to start in every session in the User settings or the older global config', () => {
    expect(claudeRemoteControlAtStartup(claudeHome().env)).toBe(false)
    expect(claudeRemoteControlAtStartup(claudeHome({ remoteControlAtStartup: true }).env)).toBe(true)
    expect(claudeRemoteControlAtStartup(claudeHome(undefined, { remoteControlAtStartup: true }).env)).toBe(true)
    // The settings file decides over the older copy.
    expect(claudeRemoteControlAtStartup(claudeHome({ remoteControlAtStartup: false }, { remoteControlAtStartup: true }).env)).toBe(false)
  })

  it('notes that an expired Remote Control picker closes like Esc only for a User who starts Remote Control every session', () => {
    const noted = claudeRemotePickerCheck({ expiry: { ms: 300_000, source: 'default' }, remoteControlAtStartup: true })
    expect(noted.ok).toBe(false)
    expect(noted.detail).toContain('5 minutes')
    expect(noted.detail).toContain('the same way as Esc')
    expect(noted.detail).toContain('/config')

    const elsewhere = claudeRemotePickerCheck({ expiry: { ms: 60_000, source: 'settings' }, remoteControlAtStartup: false })
    expect(elsewhere.ok).toBe(true)
    expect(elsewhere.detail).toContain('1 minute')

    const never = claudeRemotePickerCheck({ expiry: { ms: null, source: 'settings' }, remoteControlAtStartup: true })
    expect(never.ok).toBe(true)
    expect(never.detail).toContain('never expires')
    expect(never.technical).toEqual({ dialog_expiry_ms: null, dialog_expiry_source: 'settings', remote_control_at_startup: true })
  })
})
