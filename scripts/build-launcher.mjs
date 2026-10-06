#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { repositoryRoot } from './cross-platform.mjs'

if (!process.argv[2]) throw new Error('Usage: node scripts/build-launcher.mjs <output directory>')
const output = path.resolve(process.argv[2])
mkdirSync(output, { recursive: true })
const source = path.join(repositoryRoot, 'apps/cli/launcher/main.c')
const windows = process.platform === 'win32'
const executable = path.join(output, windows ? 'notifai.exe' : 'notifai')
execFileSync(windows ? 'cl.exe' : 'cc', windows
  ? ['/nologo', '/O2', '/MT', '/W4', '/WX', '/std:c11', '/D_CRT_SECURE_NO_WARNINGS',
    `/Fo${path.join(output, 'launcher.obj')}`, `/Fe${executable}`, source]
  : ['-std=c11', '-D_POSIX_C_SOURCE=200809L', '-D_XOPEN_SOURCE=700',
    ...(process.platform === 'darwin' ? ['-D_DARWIN_C_SOURCE', '-mmacosx-version-min=13.0'] : ['-static']),
    '-Wall', '-Wextra', '-Werror', '-O2', source, '-o', executable],
{ cwd: output, stdio: 'inherit' })
process.stdout.write(`${executable}\n`)
