#!/usr/bin/env node
/**
 * Integration check: boots the real `ctx.skills` registry (the same class the
 * harness mounts) plus this plugin, then reads the merged catalog and loads a
 * body through the registry — not through the provider directly.
 *
 *   node tools/integration-check.mjs [cwd] [skill-name]
 */
import { Context } from '@deepseek-ai/cordis'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import * as plugin from '../lib/skill.js'

const cwd = process.argv[2] ?? process.cwd()
const probe = process.argv[3] ?? 'figma-use'

const ctx = new Context()
await ctx.plugin(SkillRegistry)
await ctx.plugin(plugin)

const catalog = await ctx.skills.list({ cwd })
const bySource = new Map()
for (const skill of catalog) bySource.set(skill.provider, (bySource.get(skill.provider) ?? 0) + 1)

console.log(`catalog size   ${catalog.length}`)
for (const [provider, count] of [...bySource].sort()) console.log(`  ${provider.padEnd(16)} ${count}`)

const definition = await ctx.skills.get(probe, { cwd })
if (definition === undefined) {
  console.log(`\nload ${probe}: NOT FOUND`)
  process.exit(1)
}
console.log(`\nload ${probe}: ok`)
console.log(`  provider     ${definition.provider}`)
console.log(`  source       ${definition.source}`)
console.log(`  resourceBase ${definition.resourceBase?.path}`)
console.log(`  body bytes   ${definition.content.length}`)
console.log(`  first line   ${definition.content.split('\n')[0]}`)

await ctx.stop?.()
process.exitCode = 0
