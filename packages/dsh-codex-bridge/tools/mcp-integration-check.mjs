#!/usr/bin/env node
/**
 * Integration check: boots the real tool registry (`@deepseek-ai/dsh-tools`)
 * plus this bridge, so every discovered MCP server is actually spawned and its
 * tools register under the official `mcp__<server>__<tool>` names.
 *
 * `ToolRuntime` injects the `systemPrompt` service, which the harness provides
 * elsewhere in the tree; this check mounts a minimal stub so the registry can
 * start standalone.
 *
 *   node tools/mcp-integration-check.mjs
 */
import { Context, Service } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as bridge from '../lib/mcp.js'

/** Placeholder for the prompt service ToolRuntime waits on. */
class StubSystemPrompt extends Service {
  constructor(ctx) {
    super(ctx, 'systemPrompt')
  }
  tools() {
    return () => {}
  }
  section() {
    return () => {}
  }
}

const ctx = new Context()
await ctx.plugin(StubSystemPrompt)
await ctx.plugin(ToolRuntime)
await ctx.plugin(bridge, {})

const schemas = ctx.tools.schemas()
const byServer = new Map()
for (const schema of schemas) {
  const parts = schema.name.split('__')
  const server = schema.name.startsWith('mcp__') && parts.length >= 3 ? parts[1] : 'non-mcp'
  byServer.set(server, [...(byServer.get(server) ?? []), schema.name])
}

console.log(`tools total    ${schemas.length}`)
for (const [server, names] of [...byServer].sort()) {
  console.log(`\n  ${server}  (${names.length})`)
  for (const toolName of names) console.log(`    ${toolName}`)
}

await ctx.stop?.()
process.exitCode = schemas.length > 0 ? 0 : 1
