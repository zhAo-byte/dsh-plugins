/**
 * `dsh-mcp-codex` — batch MCP bridge from the Codex ecosystem into the Harness.
 *
 * `@deepseek-ai/dsh-mcp-client` is deliberately one-server-per-row: every MCP
 * server needs its own `cordis.yml` entry. That is fine for two servers and
 * unbearable for a machine whose Codex config already knows about ten.
 *
 * This plugin keeps the official client and removes the per-server entry: it
 * discovers every MCP server the Codex ecosystem declares, maps it onto the
 * official client's config shape, and loads one `mcp-client` child per server
 * with `ctx.plugin()`. The tools then appear under the official names
 * (`mcp__<serverName>__<tool>`) with no hand-written rows.
 *
 * Sources, lowest precedence first (a later source overwrites by server name):
 *
 *   1. `<projectRoot>/.mcp.json`                      (`mcpServers` object)
 *   2. `$CODEX_HOME/plugins/cache/<market>/<plugin>/[<version>/].mcp.json`
 *      — skipped when Codex disables that plugin
 *      (`[plugins."<plugin>@<market>"] enabled = false`)
 *   3. `$CODEX_HOME/config.toml` → `[mcp_servers.<name>]` (+ `.env` sub-table)
 *
 * Everything is read-only, and nothing is fatal: a server that cannot start is
 * logged and skipped instead of failing profile boot.
 *
 * @module dsh-mcp-codex
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { listLivePlugins, pluginMcpFiles as mcpFilesOfPlugin } from './plugin-sources.js'

/** Cordis plugin name. */
export const name = 'mcp-codex'
/** The tool registry the child MCP clients publish into. */
export const inject = ['tools']

const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/
const DEFAULT_TOOL_CALL_TIMEOUT_MS = 60000
const DEFAULT_OAUTH_PROXY_PACKAGE = 'mcp-remote@0.14.2'
const MAX_SERVER_NAME_LENGTH = 32

/**
 * Register one `mcp-client` child per discovered Codex MCP server.
 * @param {object} ctx - Cordis context carrying the tool registry.
 * @param {object} [config] - bridge configuration; see the README.
 */
export async function apply(ctx, config = {}) {
  const bridge = new CodexMcpBridge(ctx, config)
  const servers = await bridge.discover()
  if (servers.length === 0) {
    bridge.log('no Codex MCP servers found')
    return
  }
  let client
  try {
    client = await loadMcpClient()
  } catch (error) {
    bridge.warn(`cannot load @deepseek-ai/dsh-mcp-client: ${String(error)}`)
    return
  }
  bridge.log(`loading ${servers.length} Codex MCP server(s)`)
  for (const entry of bridge.skipped) {
    bridge.warn(`skipped ${entry.serverName} (${entry.source}): ${entry.reason}`)
  }
  const results = await Promise.allSettled(servers.map((server) => ctx.plugin(client, server.config)))
  results.forEach((result, index) => {
    const { serverName, source } = servers[index].config
    if (result.status === 'fulfilled') bridge.log(`mcp__${serverName}__* ready (${source})`)
    else bridge.warn(`mcp__${serverName}__* failed (${source}): ${String(result.reason)}`)
  })
}

/** Discovers Codex-ecosystem MCP servers and maps them onto mcp-client configs. */
export class CodexMcpBridge {
  /**
   * @param {object} ctx - Cordis context (uses `ctx.logger` when present).
   * @param {object} [config] - bridge configuration.
   */
  constructor(ctx, config = {}) {
    this.ctx = ctx
    this.codexHome = resolve(expandHome(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')))
    this.includeConfigServers = config.includeConfigServers ?? true
    this.includePluginServers = config.includePluginServers ?? true
    this.includeRepoMcp = config.includeRepoMcp ?? true
    this.includeDisabled = config.includeDisabled ?? false
    this.excludeServers = config.excludeServers ?? []
    this.onlyServers = config.onlyServers ?? []
    this.toolCallTimeoutMs = config.toolCallTimeoutMs ?? DEFAULT_TOOL_CALL_TIMEOUT_MS
    this.envPassthrough = config.envPassthrough ?? true
    /** Skip servers whose declared auth cannot be satisfied by a static header. */
    this.skipUnauthenticated = config.skipUnauthenticated ?? true
    /** Route OAuth-protected HTTP servers through a local OAuth proxy (`mcp-remote`). */
    this.oauthProxy = config.oauthProxy ?? {}
    /** Servers declared here instead of in Codex; highest precedence. */
    this.extraServers = config.extraServers ?? []
    /** @type {Array<{ serverName: string, source: string, reason: string }>} */
    this.skipped = []
  }

  /**
   * Collect every server, lowest precedence first.
   * @param {string} [cwd] - session working directory for repo scope.
   * @returns {Promise<Array<{ config: object, source: string }>>}
   */
  async discover(cwd = process.cwd()) {
    /** @type {Map<string, { config: object, source: string }>} */
    const byName = new Map()
    const add = (raw, source, baseDir) => {
      const serverName = sanitizeServerName(raw.name)
      if (serverName === undefined) return
      // An explicit `enabled = false` is the user's own verdict: it suppresses
      // the name outright, even when an earlier source declared the same server.
      if (raw.enabled === false && !this.includeDisabled) {
        byName.delete(serverName)
        this.skipped.push({ serverName, source, reason: 'enabled = false in Codex config' })
        return
      }
      if (!this.selected(serverName)) return
      const mapped = this.mapServer(raw, baseDir, serverName)
      if (mapped === undefined) return
      if (mapped.skipReason !== undefined) {
        this.skipped.push({ serverName, source, reason: mapped.skipReason })
        return
      }
      byName.set(serverName, { config: mapped.config, source })
    }
    if (this.includeRepoMcp) {
      for (const path of [join(findProjectRoot(resolve(cwd)), '.mcp.json'), join(resolve(cwd), '.mcp.json')]) {
        for (const [serverName, raw] of Object.entries(await readMcpJson(path))) {
          add({ ...raw, name: serverName }, 'project-mcp', dirname(path))
        }
      }
    }
    if (this.includePluginServers) {
      const disabledPlugins = this.disabledPlugins()
      for (const { path, baseDir, pluginKey } of await this.pluginMcpFiles()) {
        if (disabledPlugins.has(pluginKey)) continue
        for (const [serverName, raw] of Object.entries(await readMcpJson(path))) {
          add({ ...raw, name: serverName }, `codex-plugin:${pluginKey}`, baseDir)
        }
      }
    }
    if (this.includeConfigServers) {
      for (const [serverName, raw] of this.codexConfigServers()) {
        add({ ...raw, name: serverName }, 'codex-config', this.codexHome)
      }
    }
    // Explicit entries win over every discovered source: this is the escape
    // hatch for servers Codex does not know about (a local endpoint, a server
    // whose config lives elsewhere).
    for (const raw of this.extraServers) {
      add({ ...raw }, 'bridge-config', undefined)
    }
    return [...byName.values()]
  }

  /** Parse `[mcp_servers.*]` from `$CODEX_HOME/config.toml`. */
  codexConfigServers() {
    let text
    try {
      text = readFileSync(join(this.codexHome, 'config.toml'), 'utf8')
    } catch {
      return []
    }
    return parseCodexMcpServers(text)
  }

  /** Map a Codex MCP server declaration onto the official client's config shape. */
  mapServer(raw, baseDir, serverName) {
    const timeout = secondsToMs(raw.tool_timeout_sec ?? raw.toolTimeoutSec) ?? this.toolCallTimeoutMs
    if (typeof raw.url === 'string' && raw.url.length > 0) {
      const headers = {}
      for (const [key, value] of Object.entries(stringDict(raw.headers))) headers[key] = expandEnv(value)
      const bearerVar = typeof raw.bearer_token_env_var === 'string' ? raw.bearer_token_env_var : undefined
      const bearer = bearerVar === undefined ? undefined : process.env[bearerVar]
      if (bearerVar !== undefined && typeof bearer === 'string' && bearer.length > 0) {
        headers.Authorization = `Bearer ${bearer}`
      }
      // The official client speaks static headers only: an OAuth-protected
      // server, or a bearer token that is not in this process environment,
      // would register nothing and only delay startup.
      if (this.skipUnauthenticated && Object.keys(headers).length === 0) {
        if (typeof raw.oauth_resource === 'string') {
          const proxied = this.oauthProxyConfig(serverName, raw.url, timeout)
          if (proxied !== undefined) return { config: proxied }
          return { skipReason: `requires OAuth (${raw.oauth_resource}); set oauthProxy.enabled to reach it through mcp-remote` }
        }
        if (bearerVar !== undefined) return { skipReason: `requires ${bearerVar}, which is not set in this process` }
      }
      return {
        config: {
          transport: 'streamable-http',
          serverName,
          url: raw.url,
          headers,
          toolCallTimeoutMs: timeout,
          failOnStartupError: false
        }
      }
    }
    if (typeof raw.command !== 'string' || raw.command.length === 0) return undefined
    return {
      config: {
        transport: 'stdio',
        serverName,
        command: resolveRelative(raw.command, baseDir),
        args: (raw.args ?? []).map(String),
        env: { ...stringDict(raw.env), ...this.forwardedEnv(raw.env_vars ?? raw.envVars) },
        cwd: typeof raw.cwd === 'string' && raw.cwd.length > 0 ? resolveRelative(raw.cwd, baseDir) : '',
        toolCallTimeoutMs: timeout,
        failOnStartupError: false
      }
    }
  }

  /**
   * Wrap an OAuth-protected HTTP server in `mcp-remote`, which performs the
   * browser flow once and keeps refreshing tokens on disk (`~/.mcp-auth`).
   * The official client then only ever sees an ordinary stdio child.
   * @param {string} serverName - namespace for the tools.
   * @param {string} url - remote MCP endpoint.
   * @param {number} timeout - per-tool-call timeout.
   */
  oauthProxyConfig(serverName, url, timeout) {
    const proxy = this.oauthProxy ?? {}
    if (proxy.enabled !== true) return undefined
    if (Array.isArray(proxy.servers) && proxy.servers.length > 0 && !proxy.servers.includes(serverName)) return undefined
    return {
      transport: 'stdio',
      serverName,
      command: proxy.command ?? 'npx',
      args: ['-y', proxy.package ?? DEFAULT_OAUTH_PROXY_PACKAGE, url, ...(proxy.args ?? []).map(String)],
      env: stringDict(proxy.env),
      cwd: '',
      toolCallTimeoutMs: timeout,
      failOnStartupError: false
    }
  }

  /** Copy named ambient variables, which is what Codex's `env_vars` means. */
  forwardedEnv(names) {
    if (!this.envPassthrough) return {}
    const env = {}
    for (const name of names ?? []) {
      const value = process.env[String(name)]
      if (typeof value === 'string') env[String(name)] = value
    }
    return env
  }

  /** Plugin keys Codex itself disables via `[plugins."<name>@<market>"]`. */
  disabledPlugins() {
    let text
    try {
      text = readFileSync(join(this.codexHome, 'config.toml'), 'utf8')
    } catch {
      return new Set()
    }
    const disabled = new Set()
    let current
    for (const line of text.split(/\r?\n/)) {
      const trimmed = stripTomlComment(line).trim()
      const header = /^\[plugins\."([^"]+)"\]$/.exec(trimmed)
      if (header !== null) {
        current = header[1]
        continue
      }
      if (trimmed.startsWith('[')) {
        current = undefined
        continue
      }
      if (current !== undefined && /^enabled\s*=\s*false$/.test(trimmed)) disabled.add(current)
    }
    return disabled
  }

  /**
   * `.mcp.json` of the plugins Codex actually has installed.
   *
   * Reading `plugins/cache` directly reports dead marketplaces (content the
   * Codex UI shows as "not installed") and misses the live copy of a local
   * marketplace, which lives under its configured root.
   */
  async pluginMcpFiles() {
    const files = []
    for (const plugin of await listLivePlugins(this.codexHome)) {
      for (const file of await mcpFilesOfPlugin(plugin.pluginDir)) {
        files.push({ path: file.path, baseDir: file.baseDir, pluginKey: plugin.key })
      }
    }
    return files
  }

  selected(serverName) {
    if (this.excludeServers.includes(serverName)) return false
    if (this.onlyServers.length > 0 && !this.onlyServers.includes(serverName)) return false
    return true
  }

  log(message) {
    this.ctx?.logger?.info?.(`mcp-codex: ${message}`)
  }

  warn(message) {
    this.ctx?.logger?.warn?.(`mcp-codex: ${message}`)
  }
}

async function readMcpJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return {}
  }
  try {
    const parsed = JSON.parse(text)
    return typeof parsed?.mcpServers === 'object' && parsed.mcpServers !== null ? parsed.mcpServers : {}
  } catch {
    return {}
  }
}

async function listDirectories(path) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  const result = []
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.isDirectory()) result.push(join(path, entry.name))
  }
  return result
}

function baseName(path) {
  const index = path.lastIndexOf('/')
  return index < 0 ? path : path.slice(index + 1)
}

/**
 * Tolerant `[mcp_servers.*]` reader for Codex's `config.toml`.
 * Handles the base table, its `.env` sub-table, and ignores `.tools.*`.
 * @param {string} toml - raw config text.
 * @returns {Map<string, object>} server name → declaration.
 */
export function parseCodexMcpServers(toml) {
  const servers = new Map()
  let table = []
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = stripTomlComment(line).trim()
    if (trimmed === '') continue
    if (trimmed.startsWith('[')) {
      const header = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(trimmed)
      if (header === null) {
        table = []
        continue
      }
      table = splitTomlKey(header[1])
      if (table[0] === 'mcp_servers' && table.length >= 2 && !servers.has(table[1])) {
        servers.set(table[1], { name: table[1], env: {} })
      }
      continue
    }
    if (table[0] !== 'mcp_servers' || table.length < 2) continue
    const server = servers.get(table[1])
    if (server === undefined) continue
    const separator = trimmed.indexOf('=')
    if (separator < 0) continue
    const key = unquote(trimmed.slice(0, separator).trim())
    const value = parseTomlValue(trimmed.slice(separator + 1).trim())
    if (value === undefined) continue
    if (table.length === 2) {
      if (key === 'command' || key === 'cwd' || key === 'url') server[key] = String(value)
      else if (key === 'args' || key === 'env_vars') server[key] = asStringArray(value)
      else if (key === 'enabled') server.enabled = value === true || value === 'true'
      else if (key === 'tool_timeout_sec' || key === 'startup_timeout_sec') server[key] = Number(value)
      else if (key === 'env' && typeof value === 'object' && value !== null) Object.assign(server.env, stringDict(value))
      else if (key === 'headers' && typeof value === 'object' && value !== null) server.headers = stringDict(value)
    } else if (table.length === 3 && table[2] === 'env') {
      if (typeof value === 'string' || typeof value === 'number') server.env[key] = String(value)
    }
  }
  return servers
}

function stripTomlComment(line) {
  let quote
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]
    if (quote !== undefined) {
      if (char === '\\' && quote === '"') index += 1
      else if (char === quote) quote = undefined
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '#') return line.slice(0, index)
  }
  return line
}

function splitTomlKey(key) {
  const parts = []
  let current = ''
  let quote
  for (const char of key.trim()) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === '.') {
      parts.push(current)
      current = ''
    } else current += char
  }
  parts.push(current)
  return parts
}

function parseTomlValue(value) {
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value)
    } catch {
      return undefined
    }
  }
  if (value.startsWith("'")) {
    const end = value.lastIndexOf("'")
    return end > 0 ? value.slice(1, end) : undefined
  }
  if (value.startsWith('[')) return parseTomlArray(value)
  if (value.startsWith('{')) return parseInlineTable(value)
  if (value === 'true') return true
  if (value === 'false') return false
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function parseTomlArray(value) {
  const inner = value.slice(1, value.lastIndexOf(']') < 0 ? value.length : value.lastIndexOf(']'))
  const items = []
  let current = ''
  let quote
  for (const char of inner) {
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else current += char
      continue
    }
    if (char === '"' || char === "'") quote = char
    else if (char === ',') {
      if (current.trim() !== '') items.push(unquote(current.trim()))
      current = ''
    } else current += char
  }
  if (current.trim() !== '') items.push(unquote(current.trim()))
  return items
}

function parseInlineTable(value) {
  const inner = value.slice(1, value.lastIndexOf('}') < 0 ? value.length : value.lastIndexOf('}'))
  const table = {}
  for (const pair of inner.split(',')) {
    const separator = pair.indexOf('=')
    if (separator < 0) continue
    const key = unquote(pair.slice(0, separator).trim())
    const parsed = parseTomlValue(pair.slice(separator + 1).trim())
    if (parsed !== undefined) table[key] = parsed
  }
  return table
}

function unquote(value) {
  if (value.length >= 2 && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))) {
    return value.slice(1, -1)
  }
  return value
}

function asStringArray(value) {
  return Array.isArray(value) ? value.map(String) : []
}

function stringDict(value) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {}
  const result = {}
  for (const [key, item] of Object.entries(value)) {
    if (typeof item === 'string') result[key] = item
    else if (typeof item === 'number' || typeof item === 'boolean') result[key] = String(item)
  }
  return result
}

function sanitizeServerName(name) {
  const cleaned = String(name ?? '').replace(/[^A-Za-z0-9_-]/g, '-').slice(0, MAX_SERVER_NAME_LENGTH)
  return SERVER_NAME_PATTERN.test(cleaned) ? cleaned : undefined
}

function secondsToMs(value) {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : undefined
}

function resolveRelative(path, baseDir) {
  if (isAbsolute(path)) return path
  return resolve(baseDir ?? process.cwd(), path)
}

/** Expand `${VAR}` references the way Codex does for header and env values. */
function expandEnv(value) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name) => process.env[name] ?? '')
}

function findProjectRoot(cwd) {
  let current = cwd
  while (true) {
    if (existsSync(join(current, '.git'))) return current
    const parent = dirname(current)
    if (parent === current) return cwd
    current = parent
  }
}

function expandHome(path) {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * Import the official MCP client, falling back to the running Harness install
 * when this package cannot resolve it from its own location.
 */
async function loadMcpClient() {
  const candidates = ['@deepseek-ai/dsh-mcp-client']
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  for (const root of [join(dshHome, 'profiles'), join(dshHome, 'profiles/web')]) {
    candidates.push(pathToFileURL(join(root, 'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js')).href)
  }
  let lastError
  for (const specifier of candidates) {
    try {
      return await import(specifier)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError
}
