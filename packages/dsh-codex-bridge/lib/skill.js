/**
 * `dsh-skill-codex` — a DeepSeek Harness skill provider for the Codex ecosystem.
 *
 * DSH's built-in provider (`@deepseek-ai/dsh-skill-filesystem`) scans DSH roots
 * (`<project>/.dsh/skills`, `<project>/.agents/skills`, `~/.dsh/skills`,
 * `~/.agents/skills`). It does not know about Codex's own roots, so every skill
 * you accumulated under `~/.codex` is invisible to a DSH agent.
 *
 * This plugin closes that gap from the DSH side: it registers one provider on
 * `ctx.skills` that discovers skills from the Codex ecosystem —
 *
 *   1. `<cwd>/.codex/skills`            (repo-scoped Codex skills, nearest `.git` ancestor)
 *   2. `$CODEX_HOME/skills`             (your user skills, `.system` included)
 *   3. `$CODEX_HOME/plugins/cache/.../skills` (skills shipped inside installed Codex plugins)
 *   4. explicit `[[skills.config]]` paths from `$CODEX_HOME/config.toml`
 *      (and their `enabled = false` entries are honoured as exclusions)
 *   5. any extra `skillDirs` from this plugin's own config
 *
 * Discovery is read-only. Skill bodies are re-read on every load, and a
 * lightweight fs watcher calls the registration-scoped `invalidate()` so a new
 * or edited Codex skill reaches the next agent step without a restart.
 *
 * @module dsh-skill-codex
 */
import { existsSync, watch as watchFs } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { listLivePlugins, pluginSkillRoots as skillRootsOfPlugin } from './plugin-sources.js'

/** Cordis plugin name (also the default provider name in `ctx.skills`). */
export const name = 'skill-codex'
/** The skill registry service this provider registers into. */
export const inject = ['skills']

/** Public skill-name grammar, identical to `@deepseek-ai/dsh-skill`. */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Precedence ranks. Lower wins a duplicate name inside one registry layer. */
const PROJECT_RANK = 150 // between project-dsh (100) and project-agents (200)
const CUSTOM_RANK = 300 // same slot as the built-in customSkillDirs
const CONFIG_RANK = 350 // explicit Codex config paths, just above custom roots
const USER_RANK = 450 // between user-dsh (400) and user-agents (500)
const SYSTEM_RANK = 460 // Codex's own `~/.codex/skills/.system` set
const PLUGIN_RANK = 550 // plugin-packaged skills, below bundled (600)

const DEFAULT_WATCH_DEBOUNCE_MS = 400
const DEFAULT_PROVIDER_NAME = 'codex'

/**
 * Register the Codex skill provider on `ctx.skills`.
 * @param {object} ctx - Cordis context carrying the skill registry.
 * @param {object} [config] - provider configuration; see the README.
 */
export function apply(ctx, config = {}) {
  let provider
  ctx.skills.registerProvider((control) => {
    provider = new CodexSkillProvider(ctx, control, config)
    return provider
  })
  ctx.effect(function* () {
    yield async () => {
      await provider?.dispose()
    }
  }, 'skill-codex watcher')
}

/** Skill provider that maps Codex-ecosystem roots into `ctx.skills`. */
export class CodexSkillProvider {
  /**
   * @param {object} ctx - Cordis context (uses `ctx.logger` when present).
   * @param {{ signal: AbortSignal, invalidate: () => void }} control - registration-scoped lifecycle.
   * @param {object} [config] - provider configuration.
   */
  constructor(ctx, control, config = {}) {
    this.ctx = ctx
    this.control = control
    this.name = config.providerName ?? DEFAULT_PROVIDER_NAME
    this.codexHome = resolve(expandHome(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')))
    this.includeUserSkills = config.includeUserSkills ?? true
    this.includeSystemSkills = config.includeSystemSkills ?? true
    this.includePluginSkills = config.includePluginSkills ?? true
    this.includeRepoSkills = config.includeRepoSkills ?? true
    this.includeConfigEntries = config.includeConfigEntries ?? true
    /** Honour `enabled = false` entries in Codex's own `[[skills.config]]`. */
    this.respectConfigDisables = config.respectConfigDisables ?? true
    this.skillDirs = (config.skillDirs ?? []).map((dir) => resolve(expandHome(dir)))
    /** Plugin names (`<plugin>`) or `<marketplace>/<plugin>` pairs to skip. */
    this.excludePlugins = config.excludePlugins ?? []
    this.watch = config.watch ?? true
    this.watchDebounceMs = config.watchDebounceMs ?? DEFAULT_WATCH_DEBOUNCE_MS
    /** @type {Map<string, import('node:fs').FSWatcher>} */
    this.watchers = new Map()
    this.timer = undefined
    this.disposal = undefined
    /** Skill files that were seen but rejected, with the reason (panel/debug). */
    this.rejections = []
    control.signal.addEventListener('abort', () => {
      void this.dispose()
    }, { once: true })
  }

  /**
   * Discover Codex-ecosystem skills for the current workspace.
   * @param {{ cwd?: string, signal?: AbortSignal }} options - lookup options.
   * @returns {Promise<object[]>} provider candidates.
   */
  async list(options = {}) {
    options.signal?.throwIfAborted()
    this.rejections = []
    const roots = await this.roots(options.cwd)
    if (this.watch) this.syncWatchers(roots)
    /** @type {Map<string, object>} */
    const byPath = new Map()
    for (const root of roots) {
      options.signal?.throwIfAborted()
      for (const candidate of await discoverRoot(root, this)) {
        if (this.isDisabled(candidate.path)) {
          this.reject(candidate.path, 'enabled = false in Codex config')
          continue
        }
        const existing = byPath.get(candidate.path)
        if (existing === undefined || candidate.rank < existing.rank) byPath.set(candidate.path, candidate)
      }
    }
    return [...byPath.values()]
  }

  /**
   * Whether Codex's own config disables this skill file.
   * @param {string} path - absolute `SKILL.md` path.
   */
  isDisabled(path) {
    if (!this.respectConfigDisables || this.disabledPaths === undefined) return false
    return this.disabledPaths.has(resolve(path))
  }

  /**
   * Load one skill body from the candidate's file locator.
   * @param {object} candidate - winning candidate previously returned by `list()`.
   * @param {{ signal?: AbortSignal }} options - lookup options.
   * @returns {Promise<object|undefined>} the full skill, or `undefined` when it disappeared.
   */
  async get(candidate, options = {}) {
    const locator = candidate.locator
    const parsed = await parseSkillFile(this, locator.path, options.signal)
    if (parsed === undefined) return undefined
    return {
      name: parsed.name,
      description: parsed.description,
      ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
      invocation: parsed.invocation,
      source: candidate.source,
      provider: this.name,
      resourceBase: { kind: 'directory', path: locator.directory },
      path: locator.path,
      ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {}),
      content: parsed.content
    }
  }

  /**
   * Build the cwd-sensitive root list, including Codex `[[skills.config]]` handling.
   * @param {string|undefined} cwd - session working directory.
   * @returns {Promise<Array<{ path: string, source: string, rank: number, skipSystem?: boolean, trustedHost?: boolean }>>}
   */
  async roots(cwd) {
    const roots = []
    const config = await this.readCodexConfig()
    const pathOf = (entry) => resolve(expandHome(entry.path))
    this.disabledPaths = this.respectConfigDisables
      ? new Set(config.filter((entry) => entry.enabled === false && entry.path).map(pathOf))
      : new Set()

    if (this.includeRepoSkills && cwd !== undefined) {
      const projectRoot = findProjectRoot(resolve(cwd))
      roots.push({ path: join(projectRoot, '.codex/skills'), source: 'project-codex', rank: PROJECT_RANK })
    }
    for (const dir of this.skillDirs) {
      roots.push({ path: dir, source: 'custom', rank: CUSTOM_RANK })
    }
    if (this.includeUserSkills) {
      roots.push({
        path: join(this.codexHome, 'skills'),
        source: 'codex-user',
        rank: USER_RANK,
        skipSystem: !this.includeSystemSkills
      })
      // `.system` is a container of skills, not a skill root entry itself:
      // `<root>/<name>/SKILL.md` discovery never descends into it, so the
      // Codex-shipped skills (imagegen, skill-creator, review-agent, …) need
      // their own root.
      if (this.includeSystemSkills) {
        roots.push({ path: join(this.codexHome, 'skills/.system'), source: 'codex-system', rank: SYSTEM_RANK })
      }
    }
    if (this.includeConfigEntries) {
      for (const entry of config) {
        if (entry.enabled === false || entry.path === undefined) continue
        if (this.coveredByScannedRoot(entry.path)) continue
        roots.push({
          path: dirname(pathOf(entry)),
          source: 'codex-config',
          rank: CONFIG_RANK,
          only: pathOf(entry)
        })
      }
    }
    if (this.includePluginSkills) {
      for (const path of await this.pluginSkillRoots()) {
        roots.push({ path, source: 'codex-plugin', rank: PLUGIN_RANK })
      }
    }
    return roots
  }

  /** @param {string} path - skill file or directory path. */
  coveredByScannedRoot(path) {
    const target = resolve(expandHome(path))
    return this.skillDirs.some((dir) => target.startsWith(`${dir}/`))
      || target.startsWith(`${join(this.codexHome, 'skills')}/`)
  }

  /**
   * `skills/` directories of the plugins Codex actually has installed.
   *
   * Enumerating `plugins/cache` directly is wrong: it still holds content from
   * marketplaces that no longer exist (a plugin Codex's UI shows as "not
   * installed" can sit there for months), and the live copy of a local
   * marketplace lives under its configured root instead. `listLivePlugins`
   * applies the same rules `codex plugin list` reports.
   * @returns {Promise<string[]>}
   */
  async pluginSkillRoots() {
    const found = []
    for (const plugin of await listLivePlugins(this.codexHome)) {
      if (this.isPluginExcluded(plugin.marketplace, plugin.name)) continue
      for (const path of await skillRootsOfPlugin(plugin.pluginDir)) found.push(path)
    }
    return found
  }

  /**
   * Whether a Codex plugin's skill bundle is excluded by configuration.
   * @param {string} marketplace - marketplace name.
   * @param {string} pluginName - plugin name.
   */
  isPluginExcluded(marketplace, pluginName) {
    if (this.excludePlugins.length === 0) return false
    return this.excludePlugins.includes(pluginName) || this.excludePlugins.includes(`${marketplace}/${pluginName}`)
  }

  /** Read `[[skills.config]]` entries from the Codex config file. */
  async readCodexConfig() {
    if (this.configEntries !== undefined) return this.configEntries
    let raw
    try {
      raw = await readFile(join(this.codexHome, 'config.toml'), 'utf8')
    } catch {
      this.configEntries = []
      return this.configEntries
    }
    this.configEntries = parseSkillsConfig(raw)
    return this.configEntries
  }

  /** Watch every existing root once, so Codex-side edits invalidate the catalog. */
  syncWatchers(roots) {
    for (const root of roots) {
      if (this.watchers.has(root.path) || !existsSync(root.path)) continue
      try {
        const watcher = watchFs(root.path, { recursive: true, persistent: false }, () => this.scheduleInvalidate())
        watcher.on?.('error', () => this.closeWatcher(root.path))
        this.watchers.set(root.path, watcher)
      } catch (error) {
        this.warn(`skill-codex: cannot watch ${root.path}: ${String(error)}`)
      }
    }
  }

  scheduleInvalidate() {
    if (this.timer !== undefined) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = undefined
      try {
        this.control.invalidate()
      } catch (error) {
        this.warn(`skill-codex: invalidate failed: ${String(error)}`)
      }
    }, this.watchDebounceMs)
    this.timer.unref?.()
  }

  closeWatcher(path) {
    const watcher = this.watchers.get(path)
    if (watcher === undefined) return
    this.watchers.delete(path)
    try {
      watcher.close()
    } catch {
      /* the watcher is already gone */
    }
  }

  /** Close every watcher and contain late callbacks. */
  async dispose() {
    this.disposal ??= (async () => {
      if (this.timer !== undefined) {
        clearTimeout(this.timer)
        this.timer = undefined
      }
      for (const path of [...this.watchers.keys()]) this.closeWatcher(path)
    })()
    return this.disposal
  }

  warn(message) {
    this.ctx?.logger?.warn?.(message)
  }

  /**
   * Record a rejected skill file and log it, once per file.
   *
   * Deduplicated because the recorder sits inside the root loop, ahead of the
   * per-path candidate dedup: the same file reachable from two roots (a
   * `[[skills.config]]` directory also covered by a scanned root, a skill dir
   * listed twice) would otherwise be reported twice, and every consumer of
   * `rejections` — the panel card, its reason lines, the log — would double it.
   * A file is rejected for exactly one structural reason, so first wins.
   * @param {string} path - absolute `SKILL.md` path (already normalized by `resolve`).
   * @param {string} reason - why DSH will not register it.
   */
  reject(path, reason) {
    if (this.rejections.some((rejection) => rejection.path === path)) return
    this.rejections.push({ path, reason })
    this.warn(`skill file ${path} ignored: ${reason}`)
  }
}

/** Discover every skill reachable from one root. */
async function discoverRoot(root, provider) {
  if (root.disabled === true) return []
  if (root.only !== undefined) {
    const parsed = await parseSkillFile(provider, root.only, undefined)
    if (parsed === undefined) return []
    return [candidateFor(parsed, root, { path: root.only, directory: dirname(root.only) }, provider)]
  }
  const skills = []
  for (const entry of (await listEntries(root.path)).sort((a, b) => a.name.localeCompare(b.name))) {
    if (root.skipSystem === true && entry.name === '.system') continue
    const locator = entry.type === 'directory'
      ? { path: join(entry.path, 'SKILL.md'), directory: entry.path }
      : entry.type === 'file' && entry.name.endsWith('.md')
        ? { path: entry.path, directory: root.path }
        : undefined
    if (locator === undefined) continue
    const parsed = await parseSkillFile(provider, locator.path, undefined)
    if (parsed === undefined) continue
    skills.push(candidateFor(parsed, root, locator, provider))
  }
  return skills
}

function candidateFor(parsed, root, locator, provider) {
  return {
    name: parsed.name,
    description: parsed.description,
    ...(parsed.whenToUse !== undefined ? { whenToUse: parsed.whenToUse } : {}),
    invocation: parsed.invocation,
    source: root.source,
    provider: provider.name,
    rank: root.rank,
    locator,
    resourceBase: { kind: 'directory', path: locator.directory },
    path: locator.path,
    ...(parsed.metadata !== undefined ? { metadata: parsed.metadata } : {})
  }
}

async function listEntries(path) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  } catch (error) {
    if (isAbsent(error)) return []
    throw error
  }
  const result = []
  for (const entry of entries) {
    const path_ = join(path, entry.name)
    result.push({ name: entry.name, type: await entryKind(path_, entry), path: path_ })
  }
  return result
}

async function listDirectories(path) {
  return (await listEntries(path)).filter((entry) => entry.type === 'directory').map((entry) => entry.path)
}

async function entryKind(path, entry) {
  if (entry.isDirectory()) return 'directory'
  if (entry.isFile()) return 'file'
  if (!entry.isSymbolicLink()) return 'other'
  try {
    const info = await stat(path)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
  } catch {
    /* dangling symlink */
  }
  return 'other'
}

/** Parse one skill file with the same frontmatter contract as `dsh-skill-filesystem`. */
async function parseSkillFile(provider, path, signal) {
  let raw
  try {
    raw = await readFile(path, { encoding: 'utf8', signal })
  } catch (error) {
    if (isAbsent(error)) return undefined
    signal?.throwIfAborted()
    throw error
  }
  signal?.throwIfAborted()
  let parsed
  try {
    parsed = parseFrontmatter(raw)
  } catch (error) {
    provider.reject(path, `invalid YAML frontmatter: ${String(error)}`)
    return undefined
  }
  if (parsed === undefined) {
    provider.reject(path, 'missing YAML frontmatter')
    return undefined
  }
  const skillName = stringField(parsed.data, 'name')
  const description = stringField(parsed.data, 'description')
  if (skillName === undefined || description === undefined) {
    provider.reject(path, 'frontmatter requires name and description')
    return undefined
  }
  if (!SKILL_NAME_PATTERN.test(skillName)) {
    provider.reject(path, `invalid skill name "${skillName}"`)
    return undefined
  }
  let invocation
  try {
    invocation = parseInvocationPolicy(parsed.data)
  } catch (error) {
    provider.reject(path, `invalid invocation frontmatter: ${String(error)}`)
    return undefined
  }
  return {
    name: skillName,
    description,
    ...optionalString(parsed.data, 'whenToUse'),
    invocation,
    ...optionalMetadata(parsed.data),
    content: parsed.body.trim()
  }
}

function parseFrontmatter(raw) {
  const firstLineEnd = raw.indexOf('\n')
  if (firstLineEnd < 0) return undefined
  if (raw.slice(0, firstLineEnd).replace(/\r$/, '') !== '---') return undefined
  const start = firstLineEnd + 1
  const closing = findClosingFrontmatter(raw, start)
  if (closing === undefined) return undefined
  const parsed = parseYaml(raw.slice(start, closing.start))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  return { data: parsed, body: raw.slice(closing.bodyStart) }
}

function findClosingFrontmatter(raw, start) {
  let lineStart = start
  while (lineStart <= raw.length) {
    const nextNewline = raw.indexOf('\n', lineStart)
    const lineEnd = nextNewline < 0 ? raw.length : nextNewline
    if (raw.slice(lineStart, lineEnd).replace(/\r$/, '') === '---') {
      return { start: lineStart, bodyStart: nextNewline < 0 ? raw.length : nextNewline + 1 }
    }
    if (nextNewline < 0) return undefined
    lineStart = nextNewline + 1
  }
  return undefined
}

function stringField(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

function optionalString(data, key) {
  const value = data[key]
  return typeof value === 'string' && value.length > 0 ? { [key]: value } : {}
}

function optionalMetadata(data) {
  const value = data.metadata
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return { metadata: value }
  return {}
}

function parseInvocationPolicy(data) {
  rejectLegacyInvocationKey(data, 'disableModelInvocation', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'modelInvocable', 'disable-model-invocation')
  rejectLegacyInvocationKey(data, 'userInvocable', 'user-invocable')
  const disableModelInvocation = frontmatterBoolean(data, 'disable-model-invocation')
  const userInvocable = frontmatterBoolean(data, 'user-invocable')
  return {
    modelInvocable: disableModelInvocation !== true,
    userInvocable: userInvocable !== false
  }
}

function rejectLegacyInvocationKey(data, legacy, canonical) {
  if (Object.hasOwn(data, legacy)) throw new Error(`frontmatter field "${legacy}" is unsupported; use "${canonical}"`)
}

function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    switch (value.toLowerCase()) {
      case 'true':
      case 'yes':
      case 'on':
        return true
      case 'false':
      case 'no':
      case 'off':
        return false
      default:
        break
    }
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/**
 * Tolerant `[[skills.config]]` reader for `$CODEX_HOME/config.toml`.
 * Only the `path` and `enabled` keys of Codex skill entries matter here.
 * @param {string} toml - raw config text.
 * @returns {Array<{ path?: string, enabled?: boolean }>}
 */
export function parseSkillsConfig(toml) {
  const entries = []
  let current
  for (const line of toml.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (trimmed.startsWith('#')) continue
    if (trimmed === '[[skills.config]]') {
      current = {}
      entries.push(current)
      continue
    }
    if (trimmed.startsWith('[')) {
      current = undefined
      continue
    }
    if (current === undefined) continue
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/.exec(trimmed)
    if (match === null) continue
    const key = match[1]
    let value = match[2].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (key === 'path') current.path = value
    else if (key === 'enabled') current.enabled = value !== 'false'
  }
  return entries
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

function isAbsent(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}
