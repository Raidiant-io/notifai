import { mkdirSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  accountHome,
  configHome,
  isWindowsAbsolute,
  npxLaunch,
  quoteCmdArgument,
  stateHome,
  urlOpenLaunch,
  windowsNpxCli,
} from './platform.js'
import { globalConfigDir, stateDir } from './config.js'

const PAIRING_URL = 'https://notifai.example/approve?code=AB&next=1|calc'

describe('urlOpenLaunch', () => {
  it('keeps a metacharacter pairing URL as one Windows argument and hides the console', () => {
    const launch = urlOpenLaunch(PAIRING_URL, 'win32')
    expect(launch.file.toLowerCase()).not.toMatch(/^cmd(\.exe)?$/)
    expect(launch.args).toEqual(['url.dll,FileProtocolHandler', PAIRING_URL])
    expect(launch.options.windowsHide).toBe(true)
    expect(launch.options.detached).toBe(true)
    expect(launch.options.stdio).toBe('ignore')
  })

  it('preserves best-effort open and xdg-open on POSIX', () => {
    expect(urlOpenLaunch(PAIRING_URL, 'darwin')).toEqual({
      file: 'open',
      args: [PAIRING_URL],
      options: { stdio: 'ignore', detached: true },
    })
    expect(urlOpenLaunch(PAIRING_URL, 'linux')).toEqual({
      file: 'xdg-open',
      args: [PAIRING_URL],
      options: { stdio: 'ignore', detached: true },
    })
  })
})

describe('npxLaunch', () => {
  const source = 'Raidiant-io/notifai#v1.0.1'
  const args = ['-y', 'skills', 'add', source, '--skill', 'notifai', '--yes']

  it('runs npm\'s JavaScript npx entry point directly when Node bundles it on Windows', () => {
    const root = path.join(os.tmpdir(), `notifai-npx-${process.pid}`)
    const node = path.join(root, 'node.exe')
    const npx = path.join(root, 'node_modules', 'npm', 'bin', 'npx-cli.js')
    mkdirSync(path.dirname(npx), { recursive: true })
    writeFileSync(npx, '')
    const launch = npxLaunch(args, {
      cwd: 'C:\\proj',
      env: { ComSpec: 'C:\\Windows\\system32\\cmd.exe' },
      nodeExecutable: node,
      platform: 'win32',
    })
    expect(launch.file).toBe(node)
    expect(launch.args).toEqual([npx, ...args])
    expect(launch.options.windowsVerbatimArguments).toBeUndefined()
    expect(launch.options.windowsHide).toBe(true)
    expect(launch.options.stdio).toBe('inherit')
    expect(launch.options.cwd).toBe('C:\\proj')
  })

  it('prefers an npm_execpath companion and ignores a pnpm lifecycle executable', () => {
    const root = path.join(os.tmpdir(), `notifai-npm-execpath-${process.pid}`)
    const npm = path.join(root, 'npm-cli.js')
    const npx = path.join(root, 'npx-cli.js')
    mkdirSync(root, { recursive: true })
    writeFileSync(npx, '')
    expect(windowsNpxCli({ npm_execpath: npm }, 'C:\\missing\\node.exe')).toBe(npx)
    expect(
      windowsNpxCli({ npm_execpath: path.join(root, 'pnpm.cjs') }, 'C:\\missing\\node.exe'),
    ).toBeNull()
  })

  it('accepts an explicitly resolved npm entry point without cmd parsing', () => {
    const launch = npxLaunch(args, {
      cwd: 'C:\\proj',
      env: { PATH: 'C:\\Windows\\system32' },
      platform: 'win32',
      nodeExecutable: 'C:\\Program Files\\nodejs\\node.exe',
      npxCliPath: 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js',
    })
    expect(launch).toEqual({
      file: 'C:\\Program Files\\nodejs\\node.exe',
      args: ['C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npx-cli.js', ...args],
      options: {
        cwd: 'C:\\proj',
        env: { PATH: 'C:\\Windows\\system32' },
        stdio: 'inherit',
        windowsHide: true,
      },
    })
  })

  it('quotes a hostile source in the cmd fallback so & cannot start a second command', () => {
    const hostile = 'evil&calc.exe'
    const launch = npxLaunch(['-y', 'skills', 'add', hostile, '--skill', 'notifai'], {
      cwd: 'C:\\proj',
      env: {},
      nodeExecutable: 'C:\\missing\\node.exe',
      platform: 'win32',
      npxCliPath: null,
    })
    const script = launch.args[4] ?? ''
    expect(script).toContain(quoteCmdArgument(hostile))
    expect(script.startsWith('"') && script.endsWith('"')).toBe(true)
    expect(launch.file).toBe('cmd.exe')
  })

  it('spawns npx directly on POSIX without a shell', () => {
    const launch = npxLaunch(args, { cwd: '/tmp/proj', env: { PATH: '/usr/bin' }, platform: 'linux' })
    expect(launch).toEqual({
      file: 'npx',
      args,
      options: { cwd: '/tmp/proj', env: { PATH: '/usr/bin' }, stdio: 'inherit' },
    })
    expect(launch.options.windowsVerbatimArguments).toBeUndefined()
  })
})

describe('accountHome', () => {
  it('rejects an MSYS HOME on Windows and uses a Windows-absolute USERPROFILE', () => {
    expect(
      accountHome({ HOME: '/c/Users/rafael', USERPROFILE: 'C:\\Users\\rafael' }, 'win32'),
    ).toBe('C:\\Users\\rafael')
    expect(accountHome({ HOME: '/home/rafael', USERPROFILE: 'C:/Users/rafael' }, 'win32')).toBe(
      'C:/Users/rafael',
    )
    expect(isWindowsAbsolute('/c/Users/rafael')).toBe(false)
    expect(isWindowsAbsolute('C:\\Users\\rafael')).toBe(true)
  })

  it('honours a Windows-absolute HOME and falls back to os.homedir()', () => {
    expect(accountHome({ HOME: 'D:\\homes\\dev', USERPROFILE: 'C:\\Users\\rafael' }, 'win32')).toBe(
      'D:\\homes\\dev',
    )
    expect(accountHome({ HOME: '/c/Users/rafael' }, 'win32')).toBe(os.homedir())
  })

  it('preserves POSIX HOME, including a POSIX-looking value', () => {
    expect(accountHome({ HOME: '/home/rafael', USERPROFILE: 'C:\\Users\\rafael' }, 'linux')).toBe(
      '/home/rafael',
    )
    expect(accountHome({ HOME: '/c/Users/rafael' }, 'darwin')).toBe('/c/Users/rafael')
    expect(accountHome({}, 'linux')).toBe(os.homedir())
  })
})

describe('known-folder roots', () => {
  it('defaults Windows config to APPDATA/notifai and state to LOCALAPPDATA/notifai', () => {
    const env = {
      APPDATA: 'C:\\Users\\rafael\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\rafael\\AppData\\Local',
      HOME: '/c/Users/rafael',
      USERPROFILE: 'C:\\Users\\rafael',
    }
    expect(configHome(env, 'win32')).toBe(env.APPDATA)
    expect(stateHome(env, 'win32')).toBe(env.LOCALAPPDATA)
    expect(globalConfigDir(env, 'win32')).toBe(path.join(env.APPDATA, 'notifai'))
    expect(stateDir(env, 'win32')).toBe(path.join(env.LOCALAPPDATA, 'notifai'))
  })

  it('lets explicit XDG roots override Windows known folders', () => {
    const env = {
      XDG_CONFIG_HOME: 'D:\\xdg\\config',
      XDG_STATE_HOME: 'D:\\xdg\\state',
      APPDATA: 'C:\\Users\\rafael\\AppData\\Roaming',
      LOCALAPPDATA: 'C:\\Users\\rafael\\AppData\\Local',
    }
    expect(globalConfigDir(env, 'win32')).toBe(path.join('D:\\xdg\\config', 'notifai'))
    expect(stateDir(env, 'win32')).toBe(path.join('D:\\xdg\\state', 'notifai'))
  })

  it('keeps POSIX XDG defaults under the account home', () => {
    const env = { HOME: '/home/rafael' }
    expect(globalConfigDir(env, 'linux')).toBe(path.join('/home/rafael', '.config', 'notifai'))
    expect(stateDir(env, 'linux')).toBe(path.join('/home/rafael', '.local', 'state', 'notifai'))
    expect(globalConfigDir({ XDG_CONFIG_HOME: '/custom/config' }, 'darwin')).toBe(
      path.join('/custom/config', 'notifai'),
    )
    expect(stateDir({ XDG_STATE_HOME: '/custom/state' }, 'linux')).toBe(
      path.join('/custom/state', 'notifai'),
    )
  })
})
