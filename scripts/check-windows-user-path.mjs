#!/usr/bin/env node
// MSVC fixture under an isolated registry key, never the runner's User PATH.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { repositoryRoot } from './cross-platform.mjs'
assert.equal(process.platform, 'win32', 'Requires native Windows')
const output = mkdtempSync(path.join(os.tmpdir(), 'notifai-user-path-check-'))
try {
  const executable = path.join(output, 'check.exe')
  execFileSync('cl.exe', ['/nologo', '/O2', '/MT', '/W4', '/WX', '/std:c11', '/D_CRT_SECURE_NO_WARNINGS',
    `/Fo${path.join(output, 'check.obj')}`, `/Fe${executable}`,
    path.join(repositoryRoot, 'apps/cli/launcher/windows-user-path.test.c')], { cwd: output, stdio: 'inherit', timeout: 60_000 })
  execFileSync(executable, [], { cwd: output, stdio: 'inherit', timeout: 30_000 })
} finally { rmSync(output, { recursive: true, force: true }) }
