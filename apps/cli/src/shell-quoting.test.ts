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
const available = (shell: string) => spawnSync(shell, ['-c', 'exit 0'], { timeout: 15_000 }).status === 0
const posixQuote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
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
  describe.skipIf(!available(shell))(`${shell} lossless shell transport`, () => {
    const powershell = /^(pwsh|powershell)/.test(shell)
    const quote = powershell ? powershellQuote : posixQuote
    const hostile = "SELECT 'ready'; ’ ‘ ‚ ‛\n$(touch SHELL_SENTINEL) `touch SHELL_SENTINEL`\n$(New-Item SHELL_SENTINEL); #\nexample'; Write-Output SENTINEL; #\n"
    function run(args: string[]) {
      const script = path.join(root, powershell ? 'command.ps1' : `command-${shell}.sh`)
      // Node + driver stands in for the installed executable; argv goes straight
      // through the shell into the production CLI parser, with no eval.
      const command = `${powershell ? '& ' : ''}${quote(process.execPath)} ${quote(driver)} ${args.map(quote).join(' ')}`
      // A BOM makes Windows PowerShell read script source as UTF-8.
      writeFileSync(script, `${powershell ? '\ufeff' : ''}${command}\n`)
      const result = spawnSync(shell, powershell ? ['-NoProfile', '-NonInteractive', '-File', script] : ['-f', script], {
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
    })
    // Legacy Windows PowerShell strips embedded double quotes on native argv.
    // Its documented file route is exercised above; pwsh 7.3+ preserves quotes.
    it.skipIf(shell === 'powershell.exe')('passes inline form JSON intact', () => {
      const form = JSON.stringify({ title: 'Review', summary: 'Ship?', questions: [{ text: hostile }] })
      expect(run(['ask', '--form-json', form])).toEqual({ form })
    })
  })
}
