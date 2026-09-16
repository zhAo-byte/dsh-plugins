#!/usr/bin/env node
/**
 * Browser-free preview of the Codex panel: prints the same ✅/❌ rows the panel
 * renders, so the data layer can be verified (and debugged) without the GUI.
 *
 *   node tools/panel-check.mjs [cwd] [--json]
 */
import { collectCodexStatus, skipKind, statusRows } from '../lib/status.js'

const args = process.argv.slice(2)
const cwd = args.find((arg) => !arg.startsWith('--')) ?? process.cwd()
const status = await collectCodexStatus({ cwd })

if (args.includes('--json')) {
  console.log(JSON.stringify(status, null, 2))
} else {
  const rows = statusRows(status)
  // Three marks, because a deliberate Codex-side disable is not a failure:
  // ✅ registered · ◌ off by config · ❌ the source itself is broken.
  const mark = (row) => (row.ok ? '✅' : row.kind === 'off' ? '◌' : '❌')
  const tally = (usable, skipped) => {
    const off = skipped.filter((entry) => skipKind(entry.reason) === 'off').length
    return `✅${usable} ◌${off} ❌${skipped.length - off}`
  }
  console.log(`CODEX_HOME   ${status.codexHome}`)
  console.log(`generatedAt  ${status.generatedAt}`)
  console.log(`summary      skills ${tally(status.skills.usable.length, status.skills.skipped)} · ` +
    `mcp ${tally(status.mcp.servers.length, status.mcp.skipped)}`)
  console.log('\nAUTH')
  for (const row of rows.filter((r) => r.group === 'auth')) console.log(`  ${mark(row)} ${row.label} — ${row.detail}`)
  console.log('\nSKILLS')
  for (const row of rows.filter((r) => r.group === 'skill')) console.log(`  ${mark(row)} ${row.label}${row.ok ? '' : ` — ${row.detail}`}`)
  console.log('\nMCP')
  for (const row of rows.filter((r) => r.group === 'mcp')) console.log(`  ${mark(row)} ${row.label} — ${row.detail}`)
}
process.exitCode = 0
