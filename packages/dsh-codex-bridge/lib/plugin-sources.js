/**
 * Which Codex plugins are actually live.
 *
 * Codex keeps plugin content in more than one place, and `~/.codex/plugins/cache`
 * is *not* the installed set: it holds leftovers from earlier marketplace
 * layouts next to the current remote cache. Enumerating it blindly reports dead
 * plugins (a marketplace that no longer exists) and misses the live copies of
 * local marketplaces, which live under the marketplace root.
 *
 * The rules here mirror what `codex plugin list` reports:
 *
 *   1. A marketplace configured in `config.toml` as `source_type = "local"`
 *      resolves its plugins through its own
 *      `<root>/.agents/plugins/marketplace.json` manifest, with each entry's
 *      `source.path` relative to `<root>`. The manifest lists everything the
 *      marketplace *offers*, so only entries recorded as installed in
 *      `config.toml` (`[plugins."<name>@<marketplace>"]`) count.
 *   2. Any other marketplace under `plugins/cache` counts only when the plugin
 *      directory carries the remote install marker
 *      (`.codex-remote-plugin-install.json`).
 *
 * @module dsh-codex-bridge/plugin-sources
 */
import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

/**
 * List every live Codex plugin directory.
 * @param {string} codexHome - resolved Codex home.
 * @returns {Promise<Array<{ pluginDir: string, key: string, marketplace: string, name: string }>>}
 */
export async function listLivePlugins(codexHome) {
  const configured = readConfiguredMarketplaces(codexHome)
  const installed = readInstalledPluginKeys(codexHome)
  const found = []
  for (const [marketplace, root] of configured) {
    const manifest = readJson(join(root, '.agents/plugins/marketplace.json'))
    for (const entry of manifest?.plugins ?? []) {
      const relative = entry?.source?.path
      const name = entry?.name
      if (typeof relative !== 'string' || typeof name !== 'string' || relative.length === 0) continue
      if (!installed.has(`${name}@${marketplace}`)) continue
      found.push({ pluginDir: resolve(root, relative), key: `${name}@${marketplace}`, marketplace, name })
    }
  }
  const cache = join(codexHome, 'plugins/cache')
  for (const marketplaceDir of await listDirectories(cache)) {
    const marketplace = basename(marketplaceDir)
    if (configured.has(marketplace)) continue
    for (const pluginDir of await listDirectories(marketplaceDir)) {
      if (!existsSync(join(pluginDir, '.codex-remote-plugin-install.json'))) continue
      const name = basename(pluginDir)
      found.push({ pluginDir, key: `${name}@${marketplace}`, marketplace, name })
    }
  }
  return found
}

/**
 * Skill roots (`skills/` directories) of a live plugin, covering both the flat
 * `<plugin>/skills` and the versioned `<plugin>/<version>/skills` layouts.
 * @param {string} pluginDir - live plugin directory.
 * @returns {Promise<string[]>}
 */
export async function pluginSkillRoots(pluginDir) {
  const direct = join(pluginDir, 'skills')
  if (existsSync(direct)) return [direct]
  const roots = []
  for (const versionDir of await listDirectories(pluginDir)) {
    const versioned = join(versionDir, 'skills')
    if (existsSync(versioned)) roots.push(versioned)
  }
  return roots
}

/**
 * `.mcp.json` files of a live plugin, paired with the directory their relative
 * `cwd` values resolve against.
 * @param {string} pluginDir - live plugin directory.
 * @returns {Promise<Array<{ path: string, baseDir: string }>>}
 */
export async function pluginMcpFiles(pluginDir) {
  const direct = join(pluginDir, '.mcp.json')
  if (existsSync(direct)) return [{ path: direct, baseDir: pluginDir }]
  const files = []
  for (const versionDir of await listDirectories(pluginDir)) {
    const versioned = join(versionDir, '.mcp.json')
    if (existsSync(versioned)) files.push({ path: versioned, baseDir: versionDir })
  }
  return files
}

/** `[plugins."<name>@<marketplace>"]` keys — Codex's installed-plugin ledger. */
export function readInstalledPluginKeys(codexHome) {
  const keys = new Set()
  for (const line of readConfigLines(codexHome)) {
    const header = /^\[plugins\."([^"]+)"\]$/.exec(line)
    if (header !== null) keys.add(header[1])
  }
  return keys
}

/** `[marketplaces.<name>]` entries with a local `source`. */
export function readConfiguredMarketplaces(codexHome) {
  const marketplaces = new Map()
  let current
  let sourceType
  let source
  const commit = () => {
    if (current !== undefined && sourceType === 'local' && typeof source === 'string') {
      marketplaces.set(current, resolve(source))
    }
    current = undefined
    sourceType = undefined
    source = undefined
  }
  for (const line of readConfigLines(codexHome)) {
    const header = /^\[marketplaces\.(?:"([^"]+)"|([^\]]+))\]$/.exec(line)
    if (header !== null) {
      commit()
      current = header[1] ?? header[2]
      continue
    }
    if (line.startsWith('[')) {
      commit()
      continue
    }
    if (current === undefined) continue
    const match = /^([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*$/.exec(line)
    if (match === null) continue
    const value = match[2].replace(/^"|"$/g, '')
    if (match[1] === 'source_type') sourceType = value
    else if (match[1] === 'source') source = value
  }
  commit()
  return marketplaces
}

/** `config.toml` lines with comments stripped and blanks removed. */
function readConfigLines(codexHome) {
  let text
  try {
    text = readFileSync(join(codexHome, 'config.toml'), 'utf8')
  } catch {
    return []
  }
  return text
    .split(/\r?\n/)
    .map((line) => line.split('#')[0].trim())
    .filter((line) => line !== '')
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

async function listDirectories(path) {
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true, encoding: 'utf8' })
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
    .map((entry) => join(path, entry.name))
}
