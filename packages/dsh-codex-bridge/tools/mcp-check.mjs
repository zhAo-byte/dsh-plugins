#!/usr/bin/env node
/**
 * Deterministic self-check for the `dsh-mcp-codex` bridge: discovers and maps
 * Codex MCP servers without connecting to any of them.
 *
 *   node tools/mcp-check.mjs [--json] [--cwd <dir>]
 */
import { CodexMcpBridge } from '../lib/mcp.js'

const args = process.argv.slice(2)
const json = args.includes('--json')
const cwdIndex = args.indexOf('--cwd')
const cwd = cwdIndex >= 0 ? args[cwdIndex + 1] : process.cwd()

const bridge = new CodexMcpBridge({}, args.includes('--oauth-proxy') ? { oauthProxy: { enabled: true } } : {})
const servers = await bridge.discover(cwd)

if (json) {
  console.log(JSON.stringify({ codexHome: bridge.codexHome, servers, skipped: bridge.skipped }, null, 2))
} else {
  console.log(`codex home   ${bridge.codexHome}`)
  console.log(`servers      ${servers.length}`)
  for (const { config, source } of servers) {
    const target = config.transport === 'stdio'
      ? `${config.command} ${config.args.join(' ')}`.trim()
      : config.url
    console.log(`\n  ${config.serverName}   [${source}]`)
    console.log(`    transport  ${config.transport}`)
    console.log(`    target     ${target}`)
    if (config.transport === 'stdio') console.log(`    cwd        ${config.cwd === '' ? '(inherit)' : config.cwd}`)
    const envKeys = Object.keys(config.env ?? {})
    if (envKeys.length > 0) console.log(`    env        ${envKeys.join(', ')}`)
    console.log(`    timeout    ${config.toolCallTimeoutMs} ms`)
  }
  if (bridge.skipped.length > 0) {
    console.log(`\nskipped      ${bridge.skipped.length}`)
    for (const entry of bridge.skipped) console.log(`  ${entry.serverName}  [${entry.source}]  ${entry.reason}`)
  }
}
process.exitCode = 0
