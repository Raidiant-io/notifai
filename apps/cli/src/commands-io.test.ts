import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

it('dismisses real select and text prompts without keyboard input when approval cancels them', async () => {
  // Keep stdin open in a separate process: EOF or a mocked prompt would hide
  // the actual library/adapter cancellation contract that login relies on.
  const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', `
    import { realIo } from ${JSON.stringify(new URL('../dist/commands-io.js', import.meta.url).href)}
    Object.defineProperty(process.stdin, 'isTTY', { value: true })
    Object.defineProperty(process.stdout, 'isTTY', { value: true })
    process.stdin.setRawMode = () => process.stdin
    const io = realIo({})
    const results = []
    for (const alreadyAborted of [false, true]) {
      for (const kind of ['select', 'text']) {
        const controller = new AbortController()
        if (alreadyAborted) controller.abort()
        else setTimeout(() => controller.abort(), 50)
        results.push(kind === 'select'
          ? await io.select('Approval route', [{ value: 'qr', label: 'Scan QR' }], controller.signal)
          : await io.text('Account email', controller.signal))
      }
    }
    console.log('PROMPT_RESULTS=' + JSON.stringify(results))
  `], { timeout: 5_000, env: { ...process.env, FORCE_COLOR: '0' } })
  expect(stdout).toContain('PROMPT_RESULTS=[null,null,null,null]')
})
