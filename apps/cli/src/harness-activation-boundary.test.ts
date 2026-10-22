import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { installHookAdapter } from './hook-adapter.js'
import { opencodePluginSource } from './opencode-plugin.js'
import { openclawPluginSource } from './openclaw-plugin.js'
import { enableProject, projectBinding } from './project-enablement.js'
import { readOpenclawGeneration } from './openclaw-generation.js'
import { readSessionIncarnation } from './hook-session-state.js'

describe('generated activation through the real isolated CLI', () => {
  it('keeps disabled OpenCode Projects silent and activates from the next User prompt in the same Agent Session', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-activation-boundary-'))
    const cwd = path.join(root, 'project')
    mkdirSync(cwd)
    execFileSync('git', ['init', '-q', cwd])
    const adapter = installHookAdapter({
      execPath: process.execPath,
      scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    }, path.join(root, 'adapter-home'))
    const source = opencodePluginSource({ adapterPath: adapter.path, timeoutSeconds: 10 })
    const modulePath = path.join(root, 'opencode.mjs')
    writeFileSync(modulePath, source)
    const generated = await import(modulePath) as {
      NotifAIPlugin(input: object): Promise<{
        'experimental.chat.system.transform'(input: object, output: { system: string[] }): Promise<void>
        'chat.message'(input: object): Promise<void>
      }>
    }
    const plugin = await generated.NotifAIPlugin({
      directory: cwd,
      client: { session: { get: async () => ({ data: { id: 'activation-owner' } }) } },
    })
    const input = { sessionID: 'activation-owner' }
    const disabled = { system: ['existing harness instructions'] }
    await plugin['experimental.chat.system.transform'](input, disabled)
    expect(disabled.system).toEqual(['existing harness instructions'])

    const binding = projectBinding(cwd, process.env)
    if (binding === null) throw new Error('test Project binding unavailable')
    enableProject(binding)
    // Activation is resolved once per User prompt; the rest of this turn keeps it.
    const sameTurn = { system: ['existing harness instructions'] }
    await plugin['experimental.chat.system.transform'](input, sameTurn)
    expect(sameTurn.system).toEqual(['existing harness instructions'])
    await plugin['chat.message'](input)
    const enabled = { system: ['existing harness instructions'] }
    await plugin['experimental.chat.system.transform'](input, enabled)
    expect(enabled.system.join('\n')).toMatch(/Notifai.*enabled.*Project/i)

    // OpenCode reconstructs system[] for each request, including post-compaction.
    const nextRequest = { system: ['existing harness instructions'] }
    await plugin['experimental.chat.system.transform'](input, nextRequest)
    expect(nextRequest.system.join('\n')).toMatch(/Notifai.*enabled.*Project/i)
    await plugin['experimental.chat.system.transform'](input, nextRequest)
    expect(nextRequest.system.join('\n').match(/Notifai is enabled for this Project/g)).toHaveLength(1)
  })

  it('records an OpenClaw conversation with guidance off, and activates it at the first prompt after enablement', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-openclaw-activation-'))
    const cwd = path.join(root, 'project')
    mkdirSync(cwd)
    execFileSync('git', ['init', '-q', cwd])
    const adapter = installHookAdapter({
      execPath: process.execPath,
      scriptPath: fileURLToPath(new URL('../dist/main.js', import.meta.url)),
    }, path.join(root, 'adapter-home'))
    const modulePath = path.join(root, 'openclaw.mjs')
    writeFileSync(modulePath, openclawPluginSource({ adapterPath: adapter.path, timeoutSeconds: 10 }))
    type Handler = (event: object, ctx: object) => Promise<{ prependContext?: string } | undefined>
    const generated = await import(modulePath) as {
      default: { register(api: { on(name: string, handler: Handler): void }): void }
    }
    const handlers = new Map<string, Handler>()
    generated.default.register({ on: (name, handler) => { handlers.set(name, handler) } })
    const activate = handlers.get('before_prompt_build')!
    const ctx = { sessionKey: 'agent:main:activation-owner', workspaceDir: cwd }
    expect(await activate({}, ctx)).toBeUndefined()
    // Recorded, so its questions and answers route; nothing printed.
    const recorded = readOpenclawGeneration(ctx.sessionKey, process.env)
    expect(recorded).toMatchObject({ recorded: true, activationPrinted: false })
    expect(readSessionIncarnation(ctx.sessionKey, process.env)?.openclaw_generation).toBe(recorded!.id)

    const binding = projectBinding(cwd, process.env)
    if (binding === null) throw new Error('test Project binding unavailable')
    enableProject(binding)
    expect((await activate({}, ctx))?.prependContext).toMatch(/Notifai.*enabled.*Project/i)
    expect(readOpenclawGeneration(ctx.sessionKey, process.env)).toMatchObject({
      id: recorded!.id, recorded: true, activationPrinted: true,
    })
    expect(await activate({}, ctx)).toBeUndefined()
  })
})
