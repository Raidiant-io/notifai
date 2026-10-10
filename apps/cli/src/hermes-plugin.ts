import { stampIntegrationSource, INTEGRATION_REVISION_PLACEHOLDER } from './integration-revision.js'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hookAdapterPath, inspectHookAdapter } from './hook-adapter.js'
import { accountHome } from './platform.js'
import { createHash } from 'node:crypto'
import { atomicWriteFileSync } from './atomic-file.js'

export const HERMES_PLUGIN_ID = 'notifai'
export const HERMES_PLUGIN_MARKER = '# notifai managed hermes plugin v1'

export function hermesPluginDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env['HERMES_HOME']?.trim() || path.join(accountHome(env, process.platform), '.hermes')
  return path.join(home, 'plugins', HERMES_PLUGIN_ID)
}

export function hermesPluginSource(adapterPath: string, nodePath?: string, integrationScope = ''): string {
  const command = nodePath === undefined ? [adapterPath] : [nodePath, adapterPath]
  return stampIntegrationSource(`${HERMES_PLUGIN_MARKER}
"""Notifai activation and Session Attendant for a local Hermes CLI session."""
import atexit
import json
import os
import select
import subprocess
import threading
import time

NOTIFAI_INTEGRATION_REVISION = "${INTEGRATION_REVISION_PLACEHOLDER}"
COMMAND = ${JSON.stringify(command)}
_attendants = {}
_lock = threading.RLock()

def _attached_session(ctx):
    cli = getattr(ctx._manager, "_cli_ref", None)
    return str(getattr(cli, "session_id", "") or "") if cli is not None else ""

def _run_attendant(ctx, session_id, cwd, stopped):
    proc = None
    wall_anchor = time.time_ns()
    mono_anchor = time.monotonic_ns()
    try:
        proc = subprocess.Popen(COMMAND + ["hook", "hermes-attend", "--owner", "notifai", "--harness", "hermes", "--integration-revision", NOTIFAI_INTEGRATION_REVISION],
                                cwd=cwd, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.DEVNULL, text=True, bufsize=1)
        with _lock:
            _attendants[session_id] = (stopped, proc)
        def send(frame):
            with _lock:
                if proc.stdin is None or proc.stdin.closed:
                    return False
                try:
                    proc.stdin.write(json.dumps(frame, ensure_ascii=False) + "\\n")
                    proc.stdin.flush()
                    return True
                except (OSError, ValueError):
                    return False
        if not send({"type": "hello", "session_id": session_id, "cwd": cwd, "pid": os.getpid()}):
            return
        pending = bytearray()
        while not stopped.is_set() and proc.poll() is None:
            with _lock:
                current = _attached_session(ctx)
                working = bool(getattr(ctx._manager._cli_ref, "_agent_running", False)) if current == session_id else False
            if current != session_id:
                break
            if not send({"type": "state", "session_id": session_id,
                         "activity": "working" if working else "idle"}):
                break
            readable, _, _ = select.select([proc.stdout], [], [], 1.0)
            if not readable:
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            pending.extend(chunk)
            if len(pending) > 2 * 1024 * 1024:
                break
            while b"\\n" in pending:
                raw, _, rest = pending.partition(b"\\n")
                pending = bytearray(rest)
                try:
                    frame = json.loads(raw.decode("utf-8"))
                except (UnicodeDecodeError, ValueError):
                    continue
                if frame.get("type") != "write" or not isinstance(frame.get("id"), int):
                    continue
                accepted = False
                with _lock:
                    wall_now = time.time_ns()
                    mono_now = time.monotonic_ns()
                    # Fail closed after a backward wall-clock step. Node's
                    # deadline is wall time because its monotonic origin may
                    # differ from Python's on the same macOS host.
                    clock_stable = wall_now - wall_anchor + 100_000_000 >= mono_now - mono_anchor
                    deadline = frame.get("deadline_ms")
                    if (not stopped.is_set() and frame.get("session_id") == session_id and
                            _attached_session(ctx) == session_id and
                            type(deadline) is int and wall_now < deadline * 1_000_000 and clock_stable):
                        try:
                            accepted = bool(ctx.inject_message(frame.get("text", "")))
                        except Exception:
                            pass
                send({"type": "result", "id": frame["id"], "accepted": accepted,
                      "reason": "session-replaced" if not accepted else ""})
        send({"type": "end", "session_id": session_id})
    except (OSError, ValueError):
        pass
    finally:
        with _lock:
            if _attendants.get(session_id, (None, None))[0] is stopped:
                _attendants.pop(session_id, None)
        if proc is not None:
            try:
                if proc.stdin is not None:
                    proc.stdin.close()
                proc.wait(timeout=4)
            except (OSError, subprocess.TimeoutExpired):
                proc.terminate()
                try:
                    proc.wait(timeout=2)
                except subprocess.TimeoutExpired:
                    proc.kill()

def _start_attendant(ctx, session_id, cwd):
    if os.name == "nt":
        return
    with _lock:
        if _attached_session(ctx) != session_id or os.environ.get("HERMES_SESSION_ID") != session_id:
            return
        if session_id in _attendants:
            return
        stopped = threading.Event()
        _attendants[session_id] = (stopped, None)
        threading.Thread(target=_run_attendant, args=(ctx, session_id, cwd, stopped),
                         daemon=True, name="notifai-hermes-attendant").start()

def _stop_attendant(session_id):
    with _lock:
        item = _attendants.get(session_id)
        if item is None:
            return
        stopped, proc = item
        stopped.set()
        if proc is not None and proc.stdin is not None and not proc.stdin.closed:
            try:
                proc.stdin.write(json.dumps({"type": "end", "session_id": session_id}) + "\\n")
                proc.stdin.flush()
            except (OSError, ValueError):
                pass

def _stop_all():
    for session_id in list(_attendants):
        _stop_attendant(session_id)

def _activation(info):
    platform = str(info.get("platform") or "")
    if platform not in ("cli", "subagent"):
        return ""
    if os.environ.get("HERMES_SESSION_SOURCE", "").lower() not in ("", "cli"):
        return ""
    # Hermes may import gateway.run inside a classic CLI and set its process
    # marker there. The attached CLI object and exact session are the proof.
    if os.environ.get("HERMES_TUI_ACTIVE_SESSION_FILE"):
        return ""
    if os.environ.get("TERMINAL_ENV", "").lower() not in ("", "local"):
        return ""
    if os.environ.get("HERMES_SESSION_KEY") or os.environ.get("HERMES_SESSION_PLATFORM"):
        return ""
    session_id = str(info.get("session_id") or "").strip()
    if not session_id:
        return ""
    cwd = str(info.get("cwd") or "").strip()
    if not cwd:
        # A set but invalid TERMINAL_CWD cannot fall back to the launch dir.
        if os.environ.get("TERMINAL_CWD", "").strip():
            return ""
        try:
            cwd = os.getcwd()
        except OSError:
            return ""
    if not os.path.isdir(cwd):
        return ""
    worker = platform == "subagent"
    event = "subagent-start" if worker else "session-start"
    envelope = {"session_id": session_id, "cwd": cwd,
                "hook_event_name": "SubagentStart" if worker else "SessionStart"}
    try:
        result = subprocess.run(COMMAND + ["hook", event, "--owner", "notifai", "--harness", "hermes", "--integration-revision", NOTIFAI_INTEGRATION_REVISION],
                                input=json.dumps(envelope), text=True, capture_output=True,
                                timeout=10, check=False)
    except (OSError, subprocess.TimeoutExpired):
        return ""
    content = result.stdout.strip() if result.returncode == 0 else ""
    if content and not worker:
        _start_attendant(_ctx, session_id, cwd)
    return content

def register(ctx):
    global _ctx
    _ctx = ctx
    ctx.register_system_prompt_section("notifai.activation", _activation,
                                       position="after_memory", max_chars=4000)
    ctx.register_hook("on_session_finalize", lambda session_id=None, **_: _stop_attendant(str(session_id or "")))
    ctx.register_hook("on_session_reset", lambda session_id=None, **_: _stop_all())
    atexit.register(_stop_all)
`, integrationScope)
}

export function isOurHermesPlugin(dir: string): boolean {
  try {
    if (!lstatSync(dir).isDirectory() ||
      !lstatSync(path.join(dir, '__init__.py')).isFile() ||
      !lstatSync(path.join(dir, 'plugin.yaml')).isFile()) return false
    return readFileSync(path.join(dir, '__init__.py'), 'utf8').startsWith(HERMES_PLUGIN_MARKER) &&
      /^name: notifai$/m.test(readFileSync(path.join(dir, 'plugin.yaml'), 'utf8'))
  } catch {
    return false
  }
}

function hermesCommand(args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync('hermes', ['plugins', ...args], {
    env, encoding: 'utf8', timeout: 30_000, maxBuffer: 256 * 1024,
  })
  if (result.error || result.status !== 0) {
    throw new Error(`Hermes plugin command failed: ${result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim() ?? 'unknown error'}`)
  }
  return result.stdout
}

export function hermesVersionSupported(env: NodeJS.ProcessEnv = process.env): boolean {
  const result = spawnSync('hermes', ['--version'], {
    env, encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024,
  })
  return result.status === 0 && /^Hermes Agent v0\.21\.5\b/m.test(result.stdout)
}

export function hermesPluginListed(env: NodeJS.ProcessEnv = process.env): boolean {
  return hermesCommand(['list', '--plain', '--no-bundled'], env)
    .split(/\r?\n/)
    .some(line => /^enabled\s+\S+\s+\S+\s+notifai\s*$/.test(line))
}

export function preflightHermesPlugin(env: NodeJS.ProcessEnv = process.env): void {
  const installed = hermesPluginDir(env)
  if (existsSync(installed) && !isOurHermesPlugin(installed)) {
    throw new Error('Hermes already has a foreign plugin named notifai; leave it unchanged')
  }
  if (!hermesVersionSupported(env)) {
    throw new Error('Hermes v0.21.5 is required for the proven Notifai plugin integration')
  }
  if (!existsSync(installed) && hermesCommand(['list', '--plain'], env)
    .split(/\r?\n/)
    .some(line => /^(?:enabled|disabled|not enabled)\s+\S+\s+\S+\s+notifai\s*$/.test(line))) {
    throw new Error('Hermes already discovers a foreign plugin named notifai; leave it unchanged')
  }
}

export function installHermesPlugin(adapterPath: string, env: NodeJS.ProcessEnv = process.env, nodePath?: string): string {
  const installed = hermesPluginDir(env)
  preflightHermesPlugin(env)
  const source = hermesPluginSource(adapterPath, nodePath, path.join(installed, '__init__.py'))
  if (existsSync(installed) && readFileSync(path.join(installed, '__init__.py'), 'utf8') === source) {
    hermesCommand(['enable', HERMES_PLUGIN_ID], env)
  } else {
    const temp = mkdtempSync(path.join(os.tmpdir(), 'notifai-hermes-plugin-'))
    try {
      writeFileSync(path.join(temp, 'plugin.yaml'), 'name: notifai\nversion: "1.0.0"\ndescription: "Notifai activation and Session Attendant"\nprovides_hooks:\n  - on_session_finalize\n  - on_session_reset\n')
      writeFileSync(path.join(temp, '__init__.py'), source)
      const git = (args: string[]) => {
        const result = spawnSync('git', args, { cwd: temp, env, encoding: 'utf8', timeout: 10_000 })
        if (result.error || result.status !== 0) throw new Error(`Could not prepare Hermes plugin: ${result.error?.message ?? result.stderr?.trim() ?? 'git failed'}`)
      }
      git(['init', '-q'])
      git(['add', 'plugin.yaml', '__init__.py'])
      git(['-c', 'user.name=Notifai', '-c', 'user.email=notifai@example.invalid', 'commit', '-qm', 'plugin'])
      hermesCommand(['install', pathToFileURL(temp).href, '--enable', '--no-deps', ...(existsSync(installed) ? ['--force'] : [])], env)
    } finally {
      rmSync(temp, { recursive: true, force: true })
    }
  }
  if (!isOurHermesPlugin(installed) || !hermesPluginListed(env)) {
    throw new Error('Hermes did not report an enabled Notifai plugin after installation')
  }
  return installed
}

/** Refresh only the recognized owned module. The host's install receipt,
 * enablement and already-loaded Python module remain under Hermes authority. */
export function refreshHermesPlugin(adapterPath: string, env: NodeJS.ProcessEnv, nodePath?: string): string {
  const installed = hermesPluginDir(env)
  if (!isOurHermesPlugin(installed)) throw new Error('The owned Hermes plugin is unavailable; preserve its configuration')
  const file = path.join(installed, '__init__.py'), before = readFileSync(file, 'utf8')
  const next = hermesPluginSource(adapterPath, nodePath, path.join(installed, '__init__.py'))
  if (next !== before) atomicWriteFileSync(file, next, { requireCurrentUserOwner: true,
    expectedContentsSha256: createHash('sha256').update(before).digest('hex') })
  return installed
}

export function uninstallHermesPlugin(env: NodeJS.ProcessEnv = process.env): boolean {
  const installed = hermesPluginDir(env)
  if (!existsSync(installed)) return false
  if (!isOurHermesPlugin(installed)) throw new Error('Hermes plugin named notifai is foreign; leave it unchanged')
  hermesCommand(['remove', HERMES_PLUGIN_ID], env)
  if (existsSync(installed)) throw new Error('Hermes still has the Notifai plugin after removal')
  return true
}

export function hermesPluginCurrent(adapterHome: string | undefined, env: NodeJS.ProcessEnv): boolean {
  const dir = hermesPluginDir(env)
  const target = inspectHookAdapter(adapterHome).target
  return isOurHermesPlugin(dir) && readFileSync(path.join(dir, '__init__.py'), 'utf8') ===
    hermesPluginSource(hookAdapterPath(adapterHome), process.platform === 'win32' && target?.kind !== 'native' ? target?.execPath : undefined, path.join(dir, '__init__.py'))
}

/** Admit the loaded native bridge once. A refresh replaces only Python bytes;
 * it must not retire that bridge. Removal or replacement of the owned plugin
 * directory/manifest still revokes ownership. This is a lifetime observation,
 * never permission to load the replacement module into this process. */
export function retainedHermesPlugin(adapterHome: string | undefined, env: NodeJS.ProcessEnv): () => boolean {
  const directory = hermesPluginDir(env)
  const inspect = () => {
    if (process.platform === 'win32' || typeof process.getuid !== 'function') throw new Error('Unproven Hermes plugin ownership')
    const dir = lstatSync(directory), manifest = lstatSync(path.join(directory, 'plugin.yaml')),
      module = lstatSync(path.join(directory, '__init__.py'))
    if (!dir.isDirectory() || dir.isSymbolicLink() || !manifest.isFile() || manifest.isSymbolicLink() ||
        !module.isFile() || module.isSymbolicLink() || manifest.size > 64 * 1024 || module.size > 256 * 1024 ||
        [dir, manifest, module].some(stat => stat.uid !== process.getuid!() || (stat.mode & 0o022) !== 0) ||
        !isOurHermesPlugin(directory)) throw new Error('Hermes plugin ownership changed')
    return { path: realpathSync(directory), directory: `${dir.dev}:${dir.ino}`, manifest: `${manifest.dev}:${manifest.ino}`,
      digest: createHash('sha256').update(readFileSync(path.join(directory, 'plugin.yaml'))).digest('hex') }
  }
  try {
    const before = inspect()
    if (!hermesPluginCurrent(adapterHome, env)) return () => false
    const stillOwned = () => {
      try {
        const now = inspect()
        return now.path === before.path && now.directory === before.directory && now.manifest === before.manifest && now.digest === before.digest
      } catch { return false }
    }
    return stillOwned() ? stillOwned : () => false
  } catch { return () => false }
}
