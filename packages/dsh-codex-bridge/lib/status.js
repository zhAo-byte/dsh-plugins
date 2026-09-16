/**
 * Assemble everything the Codex panel shows: login state, the skills this
 * bridge publishes (usable vs rejected), and the MCP servers it loads (usable
 * vs skipped). Pure data — no UI, no side effects beyond reading Codex's own
 * files. `panel.js` reuses it in the host row; `tools/panel-check.mjs` reuses it
 * for a browser-free self-check.
 *
 * Every entry carries enough to be marked ✅/❌; the reasons are also logged by
 * the underlying providers, which is where debugging belongs.
 *
 * @module dsh-codex-bridge/status
 */
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { inspectCodexAuth } from './auth.js'
import { CodexMcpBridge } from './mcp.js'
import { CodexSkillProvider } from './skill.js'

/**
 * @param {object} [options] - `{ codexHome?, cwd?, logger?, toolNames? }`.
 * @returns {Promise<object>} the panel payload.
 */
export async function collectCodexStatus(options = {}) {
  const codexHome = resolve(expandHome(options.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')))
  const cwd = options.cwd ?? process.cwd()
  const ctx = { logger: options.logger ?? { info() {}, warn() {} } }
  const control = { signal: new AbortController().signal, invalidate() {} }

  const auth = inspectCodexAuth(codexHome)

  const provider = new CodexSkillProvider(ctx, control, { codexHome, watch: false })
  const candidates = await provider.list({ cwd })
  const skills = {
    usable: candidates
      .map((candidate) => ({
        name: candidate.name,
        source: candidate.source,
        rank: candidate.rank,
        path: candidate.path,
        description: candidate.description
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    skipped: provider.rejections.map((rejection) => ({ path: rejection.path, reason: rejection.reason }))
  }
  await provider.dispose()

  const bridge = new CodexMcpBridge(ctx, { codexHome })
  const discovered = await bridge.discover(cwd)
  const toolNames = Array.isArray(options.toolNames) ? options.toolNames : []
  const mcp = {
    servers: discovered.map(({ config, source }) => ({
      name: config.serverName,
      source,
      transport: config.transport,
      target: config.transport === 'stdio'
        ? `${config.command} ${config.args.join(' ')}`.trim()
        : config.url,
      tools: toolNames.filter((tool) => tool.startsWith(`mcp__${config.serverName}__`)).sort()
    })),
    skipped: bridge.skipped.map((entry) => ({ name: entry.serverName, source: entry.source, reason: entry.reason }))
  }

  return { codexHome, generatedAt: new Date().toISOString(), auth, skills, mcp }
}

/**
 * Flatten the payload into ✅/❌ rows the panel and the self-check share.
 *
 * A skip is not automatically a failure: `enabled = false` is Codex's own
 * opt-out, honored deliberately, so those rows carry `kind: 'off'` and callers
 * render them as neutral. Everything else in `skipped` is a source defect and
 * carries `kind: 'bad'`. The browser card matches the same phrase, so the panel
 * and this self-check never disagree about severity.
 *
 * @param {object} status - the payload from `collectCodexStatus`.
 * @returns {Array<object>} rows carrying `{ group, label, ok, kind?, detail }`.
 */
export function statusRows(status) {
  const rows = []
  rows.push({ group: 'auth', label: status.auth.authMode ?? 'codex login', ok: status.auth.state === 'ok', detail: status.auth.detail })
  for (const skill of status.skills.usable) rows.push({ group: 'skill', label: skill.name, ok: true, detail: skill.source })
  for (const skill of status.skills.skipped) {
    rows.push({ group: 'skill', label: skill.path, ok: false, kind: skipKind(skill.reason), detail: skill.reason })
  }
  for (const server of status.mcp.servers) {
    rows.push({ group: 'mcp', label: server.name, ok: true, detail: `${server.tools.length} tools · ${server.source}` })
  }
  for (const server of status.mcp.skipped) {
    rows.push({ group: 'mcp', label: server.name, ok: false, kind: skipKind(server.reason), detail: server.reason })
  }
  return rows
}

/**
 * Classify one skip reason: a deliberate Codex-side disable, or a source defect.
 * @param {string} reason - the provider's or bridge's rejection text.
 * @returns {'off'|'bad'} the severity callers render.
 */
export function skipKind(reason) {
  return String(reason).includes('enabled = false') ? 'off' : 'bad'
}

function expandHome(path) {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
