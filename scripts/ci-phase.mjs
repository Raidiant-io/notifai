#!/usr/bin/env node
// A separate supervisor keeps reporting even when the checked process blocks.
import { spawn, spawnSync } from 'node:child_process'
import os from 'node:os'
import process from 'node:process'
import { pathToFileURL } from 'node:url'
import { commandInvocation } from './cross-platform.mjs'

export async function runPhase({ phase, timeoutMs, command, args, heartbeatMs = 15_000 }) {
  if (!phase || !Number.isFinite(timeoutMs) || timeoutMs <= 0 || !command) throw new Error('A phase, positive timeout and command are required')
  const started = performance.now()
  const invocation = command === 'node' ? { file: process.execPath, args } : commandInvocation(command, args)
  console.error(`[${phase}] start; node=${process.version} os=${process.platform}/${process.arch} release=${os.release()} image=${process.env.ImageOS ?? "local"}/${process.env.ImageVersion ?? "local"}`)
  const child = spawn(invocation.file, invocation.args, { stdio: 'inherit', detached: process.platform !== 'win32', windowsHide: true })
  let timedOut = false
  const heartbeat = setInterval(() => console.error(`[${phase}] running ${Math.round(performance.now() - started)}ms pid=${child.pid}`), heartbeatMs)
  const timeout = setTimeout(() => {
    timedOut = true
    console.error(`[${phase}] timeout after ${timeoutMs}ms; process-tree snapshot (PID/PPID/name only)`)
    // Never include command lines: even a diagnostic must not expose arguments.
    const snapshot = process.platform === 'win32'
      ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress'], { encoding: 'utf8', timeout: 5_000 })
      : spawnSync('ps', ['-eo', 'pid,ppid,comm'], { encoding: 'utf8', timeout: 5_000 })
    console.error(snapshot.stdout || snapshot.error?.message || 'process snapshot unavailable')
    if (process.platform === 'win32') {
      spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { timeout: 5_000, stdio: 'inherit' })
    } else {
      try { process.kill(-child.pid, 'SIGKILL') } catch (error) { if (error.code !== 'ESRCH') console.error(error.message) }
    }
  }, timeoutMs)
  try {
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.once('close', code => resolve(code))
    })
    if (timedOut) throw new Error(`phase ${phase} timed out after ${timeoutMs}ms`)
    if (code !== 0) throw new Error(`phase ${phase} exited ${code}`)
  } finally {
    clearInterval(heartbeat)
    clearTimeout(timeout)
    console.error(`[${phase}] finished in ${Math.round(performance.now() - started)}ms`)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [phase, timeout, command, ...args] = process.argv.slice(2)
  try { await runPhase({ phase, timeoutMs: Number(timeout), command, args }) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
