import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  chooseTerminal,
  claudeLaunchOptions,
  claudeResumeArgs,
  claudeStartMode,
  codexLaunchOptions,
  codexPostureOptions,
  codexResumeArgs,
  customTerminalLaunch,
  reopenScript,
  reopenTitle,
  shellQuote,
  terminalEnvironment,
  terminalSeen,
  type TerminalProbe,
} from './reopen-terminal.js'

function probe(platform: NodeJS.Platform, options: { apps?: string[]; bins?: string[]; env?: NodeJS.ProcessEnv } = {}): TerminalProbe {
  return {
    platform,
    env: options.env ?? (platform === 'linux' ? { DISPLAY: ':0' } : {}),
    hasApp: (name) => (options.apps ?? []).includes(name),
    which: (name) => (options.bins ?? []).includes(name) ? `/usr/bin/${name}` : null,
  }
}

describe('the terminal a conversation ran in', () => {
  it('is read from what each terminal sets in its shells', () => {
    expect(terminalSeen({ TERM_PROGRAM: 'Apple_Terminal' }, 'darwin').app).toBe('terminal')
    expect(terminalSeen({ TERM_PROGRAM: 'iTerm.app' }, 'darwin').app).toBe('iterm2')
    expect(terminalSeen({ GHOSTTY_RESOURCES_DIR: '/x' }, 'linux').app).toBe('ghostty')
    expect(terminalSeen({ KITTY_WINDOW_ID: '1' }, 'linux').app).toBe('kitty')
    expect(terminalSeen({ GNOME_TERMINAL_SCREEN: '/org/x' }, 'linux').app).toBe('gnome-terminal')
    expect(terminalSeen({ KONSOLE_VERSION: '230' }, 'linux').app).toBe('konsole')
    // tmux inside Terminal: macOS still names the app that started the shell.
    expect(terminalSeen({ TERM_PROGRAM: 'tmux', __CFBundleIdentifier: 'com.apple.Terminal' }, 'darwin')).toMatchObject({ app: 'terminal' })
  })

  it('is no app for editor terminals, tmux alone and Orca panes, which cannot be opened from outside', () => {
    expect(terminalSeen({ TERM_PROGRAM: 'vscode', __CFBundleIdentifier: 'com.microsoft.VSCode' }, 'darwin')).toEqual({ app: null, seen: 'editor', orcaPane: false })
    expect(terminalSeen({ TERM_PROGRAM: 'tmux', TMUX: '/tmp/s' }, 'linux')).toEqual({ app: null, seen: 'tmux', orcaPane: false })
    expect(terminalSeen({ ORCA_AGENT_PANE: 'p1', TERM_PROGRAM: 'Orca' }, 'darwin')).toEqual({ app: null, seen: 'orca', orcaPane: true })
  })
})

describe('which window opens', () => {
  const run = (choice: ReturnType<typeof chooseTerminal>) => {
    if (!choice.ok) return choice.reason
    const launch = choice.launch('/s/run/reopen/t.command', '/work/app', 'Claude Code · app · reopened by Notifai')
    return [launch.command, ...launch.args]
  }

  it('on macOS: the recorded app when installed, else Terminal, in the background unless asked otherwise', () => {
    expect(run(chooseTerminal('auto', null, null, probe('darwin'), 'background'))).toEqual(['/usr/bin/open', '-g', '-a', 'Terminal', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, 'iterm2', probe('darwin', { apps: ['iTerm'] }), 'front'))).toEqual(['/usr/bin/open', '-a', 'iTerm', '/s/run/reopen/t.command'])
    // Not installed (any more): the system terminal.
    expect(run(chooseTerminal('auto', null, 'iterm2', probe('darwin'), 'background'))).toEqual(['/usr/bin/open', '-g', '-a', 'Terminal', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, 'ghostty', probe('darwin', { apps: ['Ghostty'] }), 'background')))
      .toEqual(['/usr/bin/open', '-g', '-n', '-a', 'Ghostty', '--args', '--working-directory=/work/app', '-e', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('wezterm', null, null, probe('darwin', { apps: ['WezTerm'] }), 'background')))
      .toEqual(['/usr/bin/open', '-g', '-n', '-a', 'WezTerm', '--args', 'start', '--cwd', '/work/app', '--', '/s/run/reopen/t.command'])
    // Named but missing: nothing opens.
    expect(run(chooseTerminal('kitty', null, null, probe('darwin'), 'background'))).toBe('terminal-unavailable')
  })

  it('on Linux: the recorded app, else the desktop default chain; nothing without a desktop session', () => {
    expect(run(chooseTerminal('auto', null, 'gnome-terminal', probe('linux', { bins: ['gnome-terminal', 'xterm'] }), 'background')))
      .toEqual(['/usr/bin/gnome-terminal', '--working-directory=/work/app', '--', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: ['xterm', 'konsole'] }), 'background')))
      .toEqual(['/usr/bin/konsole', '--workdir', '/work/app', '-e', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: ['xterm'] }), 'background')))
      .toEqual(['/usr/bin/xterm', '-T', 'Claude Code · app · reopened by Notifai', '-e', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: ['xdg-terminal-exec', 'xterm'] }), 'background')))
      .toEqual(['/usr/bin/xdg-terminal-exec', '/s/run/reopen/t.command'])
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: [] }), 'background'))).toBe('terminal-unavailable')
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: ['xterm'], env: {} }), 'background'))).toBe('no-display')
    expect(run(chooseTerminal('auto', null, null, probe('linux', { bins: ['xterm'], env: { WAYLAND_DISPLAY: 'wayland-0' } }), 'background')))
      .toEqual(['/usr/bin/xterm', '-T', 'Claude Code · app · reopened by Notifai', '-e', '/s/run/reopen/t.command'])
  })

  it('runs a custom command word by word, with no shell', () => {
    expect(run(chooseTerminal('custom', 'tmux -S /tmp/s new-window -d -c {cwd} {script}', null, probe('darwin'), 'background')))
      .toEqual(['tmux', '-S', '/tmp/s', 'new-window', '-d', '-c', '/work/app', '/s/run/reopen/t.command'])
    expect(customTerminalLaunch('xterm -e $(rm -rf ~) {script}', '/s', '/w')?.args).toEqual(['-e', '$(rm', '-rf', '~)', '/s'])
    expect(run(chooseTerminal('custom', 'xterm', null, probe('darwin'), 'background'))).toBe('terminal-unavailable')
    expect(run(chooseTerminal('custom', null, null, probe('darwin'), 'background'))).toBe('terminal-unavailable')
  })
})

describe('the harness command', () => {
  it('replays every option of a Claude Code command line that shapes what it may do, never its prompt or picker', () => {
    const argv = ['claude', '--model', 'opus', '--add-dir', '/a', '/b', '--permission-mode', 'plan', '--disallowedTools', 'Bash(rm:*)', 'WebFetch',
      '--settings', '{"permissions":{"deny":["Read(./.env)"]}}', '--mcp-config', '/m.json', '--strict-mcp-config', '--append-system-prompt', 'be careful',
      '--allowed-tools=Edit', '-r', 'old-id', '--name', 'work', '--', 'fix the build']
    expect(claudeLaunchOptions(argv)).toEqual(['--model', 'opus', '--add-dir', '/a', '/b', '--permission-mode', 'plan', '--disallowedTools',
      'Bash(rm:*)', 'WebFetch', '--settings', '{"permissions":{"deny":["Read(./.env)"]}}', '--mcp-config', '/m.json', '--strict-mcp-config',
      '--append-system-prompt', 'be careful', '--allowedTools', 'Edit'])
    expect(claudeStartMode(claudeLaunchOptions(argv)!)).toBe('plan')
    expect(claudeStartMode(['--dangerously-skip-permissions'])).toBe('bypassPermissions')
    // An option this build does not know, or a run that is not a terminal conversation: not repeated at all.
    expect(claudeLaunchOptions(['claude', '--brand-new-deny', 'x'])).toBeNull()
    expect(claudeLaunchOptions(['claude', '-p', 'hi'])).toBeNull()
  })

  it('resumes Claude Code with those options in the mode it last ran in, never a more permissive one', () => {
    const options = ['--model', 'opus', '--disallowedTools', 'Bash(rm:*)', '--permission-mode', 'plan']
    expect(claudeResumeArgs('s1', options, 'acceptEdits', 'same'))
      .toEqual(['--resume', 's1', '--model', 'opus', '--disallowedTools', 'Bash(rm:*)', '--permission-mode', 'acceptEdits'])
    // Before any prompt reported a mode: the one it started in.
    expect(claudeResumeArgs('s1', options, null, 'same')).toEqual(['--resume', 's1', '--model', 'opus', '--disallowedTools', 'Bash(rm:*)', '--permission-mode', 'plan'])
    expect(claudeResumeArgs('s1', [], 'bypassPermissions', 'same')).toEqual(['--resume', 's1', '--dangerously-skip-permissions'])
    // Started bypassed, then switched to the ordinary mode: bypass stays reachable as before, not on.
    expect(claudeResumeArgs('s1', ['--dangerously-skip-permissions'], 'default', 'same'))
      .toEqual(['--resume', 's1', '--allow-dangerously-skip-permissions', '--permission-mode', 'default'])
    // Always named: a resume would otherwise restore the mode its transcript last recorded.
    expect(claudeResumeArgs('s1', [], null, 'same')).toEqual(['--resume', 's1', '--permission-mode', 'default'])
    expect(claudeResumeArgs('s1', [], 'yolo', 'same')).toEqual(['--resume', 's1', '--permission-mode', 'default'])
    // `default`: the ordinary mode or a narrower one, without what widens it; what narrows it stays.
    expect(claudeResumeArgs('s1', ['--allowedTools', 'Bash', '--disallowedTools', 'WebFetch', '--dangerously-skip-permissions'], 'bypassPermissions', 'default'))
      .toEqual(['--resume', 's1', '--disallowedTools', 'WebFetch', '--permission-mode', 'default'])
    expect(claudeResumeArgs('s1', [], 'plan', 'default')).toEqual(['--resume', 's1', '--permission-mode', 'plan'])
  })

  it('replays a Codex command line\'s approval, sandbox and config overrides exactly', () => {
    const options = codexLaunchOptions(['codex', '--no-daemon', '-m', 'gpt-5', '-a', 'never', '-s', 'workspace-write', '-c',
      'sandbox_workspace_write.network_access=false', '--config=approval_policy="never"', '-i', 'a.png', 'b.png', '-C', '/x', 'write tests'])
    expect(options).toEqual(['--no-daemon', '--model', 'gpt-5', '--ask-for-approval', 'never', '--sandbox', 'workspace-write', '--config',
      'sandbox_workspace_write.network_access=false', '--config', 'approval_policy="never"'])
    expect(codexResumeArgs('t1', options!, 'same')).toEqual(['resume', 't1', ...options!])
    expect(codexLaunchOptions(['codex', 'resume', 'old', '-anever', '--last'])).toEqual(['--ask-for-approval', 'never'])
    expect(codexLaunchOptions(['codex', '--remote', 'ws://h:1'])).toBeNull()
    expect(codexLaunchOptions(['codex', '--new-thing'])).toBeNull()
    // `default`: without what widens Codex's ordinary posture; narrowing overrides stay.
    expect(codexResumeArgs('t1', ['--dangerously-bypass-approvals-and-sandbox', '--ask-for-approval', 'never', '--sandbox', 'read-only',
      '--config', 'approval_policy="never"', '--config', 'sandbox_workspace_write.network_access=false', '--approve-for-me'], 'default'))
      .toEqual(['resume', 't1', '--sandbox', 'read-only', '--config', 'sandbox_workspace_write.network_access=false'])
  })

  it('expresses a Codex thread\'s recorded posture as overrides, or not at all', () => {
    expect(codexPostureOptions({ approval_policy: 'never', approvals_reviewer: 'user', sandbox_policy: { type: 'read-only' } }))
      .toEqual(['--config', 'approval_policy="never"', '--config', 'sandbox_mode="read-only"'])
    expect(codexPostureOptions({ approval_policy: 'on-request', sandbox_policy: { type: 'workspace-write', network_access: false,
      writable_roots: ['/extra'], exclude_slash_tmp: true } })).toEqual(['--config', 'approval_policy="on-request"', '--config',
      'sandbox_mode="workspace-write"', '--config', 'sandbox_workspace_write.network_access=false', '--config',
      'sandbox_workspace_write.writable_roots=["/extra"]', '--config', 'sandbox_workspace_write.exclude_slash_tmp=true'])
    expect(codexPostureOptions({ approval_policy: { granular: {} }, sandbox_policy: { type: 'read-only' } })).toBeNull()
    expect(codexPostureOptions({ approval_policy: 'never', approvals_reviewer: 'auto', sandbox_policy: { type: 'read-only' } })).toBeNull()
    expect(codexPostureOptions({ approval_policy: 'never', sandbox_policy: { type: 'external-sandbox' } })).toBeNull()
    expect(codexPostureOptions({ approval_policy: 'never', sandbox_policy: { type: 'workspace-write', new_knob: 1 } })).toBeNull()
  })
})

describe('the window script', () => {
  const script = reopenScript({
    launcher: '/opt/notifai/notifai', record: '/s/run/reopen/abc.json', cwd: "/work/it's here",
    title: reopenTitle('claude-code', "/work/it's here"), command: ['/usr/local/bin/claude', '--resume', 's1'], loginShell: '/bin/zsh',
    pinned: { CLAUDE_CONFIG_DIR: '/h/.claude-work', XDG_STATE_HOME: null },
  })

  it('deletes itself, clears the window, titles it, checks once more and becomes the harness in the login shell', () => {
    expect(script.split('\n')).toEqual([
      '#!/bin/sh',
      '# Notifai wrote this to reopen one conversation; it deletes itself.',
      'rm -f -- "$0"',
      `printf '\\033]0;%s\\007\\033[H\\033[2J' 'Claude Code · it'\\''s here · reopened by Notifai'`,
      `cd -- '/work/it'\\''s here' 2>/dev/null || { printf '%s\\n' 'Notifai did not reopen this conversation: its folder no longer exists.'; exit 0; }`,
      "CLAUDE_CONFIG_DIR='/h/.claude-work'; export CLAUDE_CONFIG_DIR",
      'unset XDG_STATE_HOME',
      "'/opt/notifai/notifai' --internal-reopen-guard '/s/run/reopen/abc.json' || exit 0",
      // Set again after the login profile: a profile that exports another home cannot move the conversation.
      `exec '/bin/zsh' -l -c 'CLAUDE_CONFIG_DIR='\\''/h/.claude-work'\\''; export CLAUDE_CONFIG_DIR; unset XDG_STATE_HOME; exec "$@"' notifai '/usr/local/bin/claude' '--resume' 's1'`,
      '',
    ])
  })

  it('names no secret: only the config home and Notifai\'s own folders are set', () => {
    for (const name of ['ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'TOKEN', 'SECRET', 'PASSWORD']) expect(script).not.toContain(name)
    const fish = reopenScript({ launcher: '/l', record: '/r.json', cwd: '/w', title: 't', command: ['/c', 'resume', 'x'], loginShell: '/usr/bin/fish', pinned: {} })
    expect(fish.trim().split('\n').at(-1)).toBe("exec '/c' 'resume' 'x'")
  })

  it.skipIf(process.platform === 'win32')('keeps the conversation\'s config home whatever the login profile exports', () => {
    const home = mkdtempSync(path.join(os.tmpdir(), 'notifai-reopen-profile-'))
    writeFileSync(path.join(home, '.profile'), 'CLAUDE_CONFIG_DIR=/elsewhere; export CLAUDE_CONFIG_DIR\nCODEX_HOME=/other; export CODEX_HOME\n')
    const file = path.join(home, 'reopen.command')
    writeFileSync(file, reopenScript({ launcher: '/usr/bin/true', record: '/r.json', cwd: home, title: 't', command: ['/usr/bin/env'],
      loginShell: '/bin/sh', pinned: { CLAUDE_CONFIG_DIR: '/h/.claude-work', CODEX_HOME: null } }), { mode: 0o700 })
    const output = execFileSync('/bin/sh', [file], { encoding: 'utf8', env: { HOME: home, PATH: '/usr/bin:/bin', CODEX_HOME: '/inherited' } })
    expect(output.split('\n')).toContain('CLAUDE_CONFIG_DIR=/h/.claude-work')
    expect(output).not.toContain('CODEX_HOME=')
  })

  it('quotes every word for a POSIX shell', () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`)
    expect(shellQuote('$(x) `y`')).toBe("'$(x) `y`'")
  })

  it('starts a Linux terminal with the desktop session only, not the terminal that started the hub', () => {
    expect(terminalEnvironment({ HOME: '/h', PATH: '/bin', DISPLAY: ':0', DBUS_SESSION_BUS_ADDRESS: 'unix:x', XDG_RUNTIME_DIR: '/run/1',
      TERM_PROGRAM: 'vscode', ANTHROPIC_API_KEY: 'k', NOTIFAI_LOG: 'x' })).toEqual({ HOME: '/h', PATH: '/bin', DISPLAY: ':0',
      DBUS_SESSION_BUS_ADDRESS: 'unix:x', XDG_RUNTIME_DIR: '/run/1' })
  })
})
