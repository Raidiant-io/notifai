#!/usr/bin/env node
/**
 * Remove a package's build output before it is rebuilt.
 *
 * `tsc` writes the files a source tree currently implies; it never removes the
 * ones an earlier tree implied. So deleting a module leaves its compiled
 * output behind indefinitely, and the stale file keeps resolving, keeps
 * passing checks that only look at what is present, and ships. A release once
 * went out carrying the compiled form of a module that no longer existed in
 * its own source.
 *
 * Running this in front of every build makes `dist/` a pure function of `src/`,
 * which is the property every other guard here assumes it already has.
 *
 * Operates on the working directory, so each package invokes it for itself.
 */
import { rmSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'

rmSync(path.resolve(process.cwd(), 'dist'), { recursive: true, force: true })
