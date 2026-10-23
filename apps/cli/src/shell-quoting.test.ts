import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Real shells and Commander; runners capture inputs without a service or User state.
const root = mkdtempSync(path.join(os.tmpdir(), 'notifai-shell-'))
const driver = path.join(root, 'cli.cjs')
const shells = ['bash', 'zsh', 'pwsh', ...(process.platform === 'win32' ? ['powershell.exe'] : [])]
const shellExecutable = (shell: string): string => shell === 'pwsh' ? (process.env['NOTIFAI_TEST_PWSH'] ?? shell) : shell
const probeShell = (shell: string) => spawnSync(shellExecutable(shell),
  /^(pwsh|powershell)/.test(shell) ? ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'] : ['-c', 'exit 0'],
  { encoding: 'utf8', timeout: 30_000 },
)
const posixQuote = (value: string) => `'${value.replaceAll("'", `'"'"'`)}'`
const powershellQuote = (value: string) => `'${value.replace(/['’‘‚‛]/g, '$&$&')}'`

beforeAll(() => {
  buildSync({
    stdin: {
      contents: `const { buildProgram } = require(${JSON.stringify(fileURLToPath(new URL('./program.ts', import.meta.url)))});
const output = value => { process.stdout.write(JSON.stringify(value).split('').map(c => c.charCodeAt(0) > 127 ? String.fromCharCode(92) + 'u' + c.charCodeAt(0).toString(16).padStart(4, '0') : c).join('')); return 0; };
const deps = { env: {}, cwd: process.cwd(), io: { out() {}, err: text => console.error(text) } };
buildProgram(deps, { exit: code => process.exit(code), runners: {
  send: async (_, flags) => output(flags),
  ask: async (_, question, flags) => output({ question, ...flags }),
  guidanceSet: async (_, topic, text) => output({ topic, text }),
} }).parseAsync(process.argv).catch(error => { console.error(error); process.exit(1); });`,
      resolveDir: path.dirname(fileURLToPath(import.meta.url)),
    },
    define: { 'import.meta.url': JSON.stringify(new URL('./program.ts', import.meta.url).href) },
    outfile: driver, bundle: true, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent',
    banner: { js: `module.paths.unshift(${JSON.stringify(fileURLToPath(new URL('../node_modules', import.meta.url)))}, ${JSON.stringify(fileURLToPath(new URL('../../../node_modules', import.meta.url)))});` },
  })
}, 30_000)
afterAll(() => rmSync(root, { recursive: true, force: true }))

for (const shell of shells) {
  const probe = probeShell(shell)
  const present = probe.status === 0
  const required = shell === 'bash' || (process.platform === 'darwin' && shell === 'zsh') || (process.platform === 'win32' && /^(pwsh|powershell)/.test(shell))
  if (required && !present) {
    throw new Error(`Required shell is unavailable: ${shell}: ${probe.error?.message ?? `exit ${probe.status}, signal ${probe.signal}`}; ${probe.stderr?.trim().slice(0, 300) ?? ''}`)
  }
  describe.skipIf(!present)(`${shell} lossless shell transport`, () => {
    const powershell = /^(pwsh|powershell)/.test(shell)
    const quote = powershell ? powershellQuote : posixQuote
    const baseHostile = "SELECT 'ready'; ’ ‘ ‚ ‛\n$(touch SHELL_SENTINEL) `touch SHELL_SENTINEL`\n$(New-Item SHELL_SENTINEL); #\nexample'; Write-Output SENTINEL; #\n"
    const hostile = baseHostile + [..."'’‘‚‛"].map((q) => `example${q}; New-Item SHELL_SENTINEL; #\n`).join('')
    function run(args: string[]) {
      const script = path.join(root, powershell ? 'command.ps1' : `command-${shell}.sh`)
      // Node + driver stands in for the installed executable; argv goes straight
      // through the shell into the production CLI parser, with no eval.
      const command = `${powershell ? '& ' : ''}${quote(process.execPath)} ${quote(driver)} ${args.map(quote).join(' ')}`
      // A BOM makes Windows PowerShell read script source as UTF-8.
      writeFileSync(script, `${powershell ? '\ufeff' : ''}${command}\n`)
      const result = spawnSync(shellExecutable(shell), powershell ? ['-NoProfile', '-NonInteractive', '-File', script] : ['-f', script], {
        cwd: root, encoding: 'utf8', timeout: 25_000,
      })
      expect(result.error).toBeUndefined()
      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      expect(existsSync(path.join(root, 'SHELL_SENTINEL'))).toBe(false)
      return JSON.parse(result.stdout)
    }
    it('passes hostile text and verbatim guidance byte for byte without executing it', () => {
      expect(run(['send', '--kind', 'done', '--title', hostile, '--summary', hostile, '--body', hostile]))
        .toEqual({ kind: 'done', title: hostile, summary: hostile, body: hostile })
      expect(run(['ask', hostile, '--title', hostile, '--choice', hostile, '--body', hostile]))
        .toMatchObject({ question: hostile, title: hostile, choice: [hostile], body: hostile })
      expect(run(['guidance', 'set', 'when-to-notify', hostile, '--local', '--yes']))
        .toEqual({ topic: 'when-to-notify', text: hostile })
    })
    it('preserves double quotes and hostile content through Body and form files', () => {
      const body = `${hostile}"quoted"\n`
      writeFileSync(path.join(root, 'body.md'), body)
      const form = JSON.stringify({ title: 'Review', summary: 'Ship?', questions: [{ text: body }] })
      writeFileSync(path.join(root, '{release}.json'), form)
      expect(run(['send', '--kind', 'done', '--title', 'Review', '--summary', 'Review', '--body-file', 'body.md']))
        .toMatchObject({ body })
      expect(run(['ask', '--form', '{release}.json'])).toEqual({ form })
      expect(run(['guidance', 'set', 'when-to-notify', '--file', 'body.md', '--local', '--yes']))
        .toEqual({ topic: 'when-to-notify', text: body })
    })
    it.each(['Saved to C:\\out\\', ''])('preserves a legacy-unsafe value through files: %j', (value) => {
      writeFileSync(path.join(root, 'value.txt'), value)
      const summary = 'p --device x q'
      const form = JSON.stringify({ title: value, summary, questions: [{ text: value }] })
      writeFileSync(path.join(root, 'value.json'), form)
      expect(run(['send', '--kind', 'done', '--title', 'Review', '--summary', summary, '--body-file', 'value.txt']))
        .toEqual({ kind: 'done', title: 'Review', summary, body: value })
      expect(run(['ask', '--form', 'value.json'])).toEqual({ form })
      expect(run(['guidance', 'set', 'when-to-notify', '--file', 'value.txt', '--local', '--yes']))
        .toEqual({ topic: 'when-to-notify', text: value })
    })
    it.skipIf(shell === 'powershell.exe').each(['Saved to C:\\out\\', ''])('preserves a trailing backslash or empty inline value in modern shells: %j', (value) => {
      const summary = 'p --device x q'
      expect(run(['send', '--kind', 'done', '--title', value, '--summary', summary, '--body', value]))
        .toEqual({ kind: 'done', title: value, summary, body: value })
    })
    // Legacy Windows PowerShell strips embedded double quotes on native argv.
    // Its documented file route is exercised above; pwsh 7.3+ preserves quotes.
    it.skipIf(shell === 'powershell.exe')('passes inline form JSON intact', () => {
      const form = JSON.stringify({ title: 'Review', summary: 'Ship?', questions: [{ text: hostile }] })
      expect(run(['ask', '--form-json', form])).toEqual({ form })
    })
  })
}
