#!/usr/bin/env node
/**
 * Self-check for the `codex-auth` preflight row: prints what the row would log
 * at boot, without starting the harness.
 *
 *   node tools/auth-check.mjs [--json] [--codex-home <dir>]
 */
import { inspectCodexAuth } from '../lib/auth.js'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = process.argv.slice(2)
const homeIndex = args.indexOf('--codex-home')
const codexHome = homeIndex >= 0 ? args[homeIndex + 1] : join(homedir(), '.codex')
const verdict = inspectCodexAuth(codexHome)

if (args.includes('--json')) {
  console.log(JSON.stringify({ codexHome, verdict }, null, 2))
} else {
  const when = verdict.expiresAt === undefined ? '' : ` (${new Date(verdict.expiresAt).toISOString()})`
  console.log(`codex home   ${codexHome}`)
  console.log(`state        ${verdict.state}${when}`)
  console.log(`detail       ${verdict.detail}`)
  if (verdict.hint !== '') console.log(`hint         ${verdict.hint}`)
}
process.exitCode = 0
