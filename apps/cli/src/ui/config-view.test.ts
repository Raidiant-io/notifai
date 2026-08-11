import { describe, expect, it } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { CONFIG_KEYS, loadConfig } from '../config.js'
import { configInfo } from '../config-schema.js'
import { renderConfigExplain, renderConfigList, renderConfigPlain } from './config-view.js'
import { width } from './theme.js'

const config = loadConfig({
  cwd: os.tmpdir(),
  env: { XDG_CONFIG_HOME: path.join(os.tmpdir(), 'notifai-config-view-tests') },
})

describe('renderConfigPlain', () => {
  it('is the flat form scripts already parse', () => {
    // This is the agent-facing shape and the reason the pretty renderer is
    // gated on a human terminal. Restyling it would be a breaking change for
    // an audience that cannot see the styling.
    const lines = renderConfigPlain(config, false)
    expect(lines).toHaveLength(CONFIG_KEYS.length)
    expect(lines[0]).toBe(`base_url = ${JSON.stringify(config.base_url.value)}`)
    for (const line of lines) expect(line).toMatch(/^[a-z_]+ = /)
  })

  it('appends the raw source tag under --explain', () => {
    const lines = renderConfigPlain(config, true)
    expect(lines[0]).toBe(
      `base_url = ${JSON.stringify(config.base_url.value)}  [${config.base_url.source}]`,
    )
  })

  it('carries no colour, so a pipe gets no escape bytes', () => {
    for (const line of renderConfigPlain(config, true)) {
      expect(line).toBe(line.replace(/\[[0-9;]*m/g, ''))
    }
  })
})

describe('renderConfigList', () => {
  it('names every non-advanced key and explains it', () => {
    const text = renderConfigList(config).join('\n')
    for (const key of CONFIG_KEYS) {
      // Derived, not listed: a hardcoded set of advanced keys silently becomes
      // an assertion about yesterday's key list the moment a key is added.
      if (configInfo(key).advanced === true) continue
      expect(text, key).toContain(key)
    }
    expect(text).toContain('Questions & presence')
    expect(text).toContain('notifai config explain')
  })

  it('reveals advanced keys only when asked', () => {
    expect(renderConfigList(config).join('\n')).not.toContain('base_url')
    expect(renderConfigList(config, { showAdvanced: true }).join('\n')).toContain('base_url')
  })

  it('fits the terminal, so no row wraps into the next', () => {
    const columns = process.stdout.columns
    Object.defineProperty(process.stdout, 'columns', { value: 80, configurable: true })
    try {
      for (const line of renderConfigList(config, { showAdvanced: true })) {
        expect(width(line), line).toBeLessThanOrEqual(80)
      }
    } finally {
      Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
    }
  })
})

describe('renderConfigExplain', () => {
  it('answers what it is, what it is now, and what it accepts', () => {
    const text = renderConfigExplain('require_idle', config).join('\n')
    expect(text).toContain('require_idle')
    expect(text).toContain('Only when I have stepped away')
    expect(text).toContain('Accepts')
    expect(text).toContain('true or false')
    // The copyable next step; the old output stopped at the value.
    expect(text).toContain('notifai config set require_idle')
  })

  it('lists what each choice of an enum means', () => {
    const text = renderConfigExplain('sound', config).join('\n')
    for (const choice of ['default', 'done', 'attention', 'alert', 'none']) {
      expect(text, choice).toContain(choice)
    }
    expect(text).toContain('the completion chime')
  })
})
