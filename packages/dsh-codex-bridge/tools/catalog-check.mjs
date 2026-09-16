#!/usr/bin/env node
/**
 * Deterministic self-check for the `dsh-skill-codex` provider.
 *
 * Runs the provider without the harness (no `ctx.skills`) against the real
 * Codex home, prints the discovered catalog, and optionally loads every body.
 *
 *   node tools/catalog-check.mjs [cwd] [--load] [--json]
 */
import { CodexSkillProvider } from '../lib/skill.js'

const args = process.argv.slice(2)
const flags = new Set(args.filter((arg) => arg.startsWith('--')))
const cwd = args.find((arg) => !arg.startsWith('--')) ?? process.cwd()

const warnings = []
const control = { signal: new AbortController().signal, invalidate: () => {} }
const ctx = { logger: { warn: (message) => warnings.push(message) } }
const provider = new CodexSkillProvider(ctx, control, { watch: false })

const candidates = await provider.list({ cwd })
const bySource = new Map()
for (const candidate of candidates) {
  bySource.set(candidate.source, (bySource.get(candidate.source) ?? 0) + 1)
}

const duplicates = new Map()
for (const candidate of candidates) {
  const seen = duplicates.get(candidate.name) ?? []
  seen.push(`${candidate.source}@${candidate.rank}`)
  duplicates.set(candidate.name, seen)
}
const shadowed = [...duplicates].filter(([, sources]) => sources.length > 1)

const failures = []
if (flags.has('--load')) {
  for (const candidate of candidates) {
    try {
      const definition = await provider.get(candidate, {})
      if (definition === undefined || definition.content.length === 0) {
        failures.push({ name: candidate.name, path: candidate.path, reason: 'no content' })
      }
    } catch (error) {
      failures.push({ name: candidate.name, path: candidate.path, reason: String(error) })
    }
  }
}

if (flags.has('--json')) {
  console.log(JSON.stringify({ cwd, candidates, bySource: Object.fromEntries(bySource), failures, warnings }, null, 2))
} else {
  console.log(`cwd            ${cwd}`)
  console.log(`codex home     ${provider.codexHome}`)
  console.log(`skills found   ${candidates.length}`)
  for (const [source, count] of [...bySource].sort()) console.log(`  ${source.padEnd(14)} ${count}`)
  if (shadowed.length > 0) {
    console.log(`\nshadowed names (${shadowed.length}) — lowest rank wins in one registry layer:`)
    for (const [name, sources] of shadowed.slice(0, 20)) console.log(`  ${name}: ${sources.join(' | ')}`)
  }
  if (flags.has('--load')) console.log(`\nload check     ${candidates.length - failures.length}/${candidates.length} bodies readable`)
  if (failures.length > 0) {
    console.log('\nfailures:')
    for (const failure of failures) console.log(`  ${failure.name} (${failure.path}): ${failure.reason}`)
  }
  if (warnings.length > 0) {
    console.log(`\nwarnings (${warnings.length}):`)
    for (const warning of warnings.slice(0, 20)) console.log(`  ${warning}`)
  }
  console.log('\nby source:')
  for (const candidate of candidates.slice(0, 200)) {
    console.log(`  [${candidate.source}] ${candidate.name}  ->  ${candidate.path}`)
  }
}

process.exitCode = failures.length === 0 ? 0 : 1
