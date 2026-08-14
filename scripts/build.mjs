#!/usr/bin/env node
/**
 * Build: compile TS with tsc, then copy the market.html asset into lib/web so
 * the host plugin can serve it from the published package.
 */
import { execSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))

console.log('[build] tsc -b')
execSync('npx tsc -b tsconfig.json', { cwd: root, stdio: 'inherit' })

console.log('[build] copy market.html -> lib/web')
rmSync(join(root, 'lib', 'web'), { recursive: true, force: true })
mkdirSync(join(root, 'lib', 'web'), { recursive: true })
cpSync(join(root, 'src', 'web', 'market.html'), join(root, 'lib', 'web', 'market.html'))

console.log('[build] done')
