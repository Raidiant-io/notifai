#!/usr/bin/env node
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { checkGuidanceChanges } from './guidance-changes.mjs'
import { repositoryRoot } from './cross-platform.mjs'

const packageRoot = path.join(repositoryRoot, 'apps/cli')
const source = path.join(repositoryRoot, 'skills/notifai')
const destinationRoot = path.join(packageRoot, 'dist/skill-source')
const destination = path.join(destinationRoot, 'notifai')
const packageVersion = JSON.parse(readFileSync(path.join(packageRoot, 'package.json'), 'utf8')).version
const integrityModule = await import(
  pathToFileURL(path.join(packageRoot, 'dist/skill-integrity.js')).href
)

checkGuidanceChanges(repositoryRoot)
rmSync(destinationRoot, { recursive: true, force: true })
mkdirSync(destinationRoot, { recursive: true })
cpSync(source, destination, { recursive: true, dereference: false })
cpSync(path.join(repositoryRoot, 'skills/guidance-changes.json'), path.join(destinationRoot, 'guidance-changes.json'))
const manifest = integrityModule.createSkillManifest(destination, packageVersion)
writeFileSync(path.join(destinationRoot, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
