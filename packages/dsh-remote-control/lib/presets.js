/**
 * `dsh-remote-control` — install the agent presets this package ships.
 *
 * Guest mode drives the workspace with the `reader` agent (只读代码分析), and a
 * preset is not something DSH can fetch: the preset root takes a *path*
 * (`PresetRoot { path, trust }`), so "installing an agent" literally means
 * putting a directory at `$DSH_HOME/.agent-presets/<id>/`. A plugin that offered
 * guest mode but left the preset to be installed by hand would therefore be
 * broken by default — the first guest turn would fail resolving a preset nobody
 * installed, and the error would surface on a public page rather than here.
 *
 * So the snapshot lives in `presets/` inside this package and is written into
 * the DSH home when the plugin loads. Three properties are deliberate:
 *
 * 1. **Only directories this function created are ever rewritten.** Every
 *    install drops a stamp (`.dsh-bundled-preset.json`) recording the file
 *    hashes it wrote. A directory without that stamp belongs to somebody else —
 *    normally `dsh-agent`'s own `install.sh`, which is the upstream source of
 *    this snapshot — and is left completely untouched, with one log line saying
 *    so. Without this rule, a backend restart would silently revert a newer
 *    hand-installed preset to the snapshot frozen into the plugin, which is the
 *    kind of failure nobody would think to look for.
 * 2. **A rewrite is backed up first.** Anything replaced is copied to
 *    `.backup-<id>-<timestamp>` beside it, the same shape `install.sh` uses, so
 *    a bad snapshot is recoverable without git.
 * 3. **It never throws.** This runs during plugin load: a read-only home, a
 *    permission problem, or a full disk must degrade to a logged warning, not to
 *    a backend that will not start.
 *
 * @module dsh-remote-control/presets
 */

import { createHash } from 'node:crypto'
import { chmod, copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This package's `presets/` directory, one sub-directory per preset id. */
export const BUNDLED_PRESET_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', 'presets')

/** The stamp that marks a preset directory as managed by this plugin. */
export const PRESET_STAMP = '.dsh-bundled-preset.json'

/** Files that are never part of a preset, whatever the source directory holds. */
const IGNORED = new Set(['.DS_Store', '__pycache__'])

/**
 * Where DSH keeps user agent presets.
 *
 * `DSH_HOME` is honoured because that is the variable DSH itself uses, and the
 * self-checks point it at a throwaway directory: without it, a check would write
 * into the developer's real preset root.
 *
 * @param {object} [env] - environment to read; defaults to `process.env`.
 * @returns {string} the absolute `.agent-presets` directory.
 */
export function presetsRoot(env = process.env) {
  const home = typeof env?.DSH_HOME === 'string' && env.DSH_HOME.trim() !== '' ? env.DSH_HOME.trim() : join(homedir(), '.dsh')
  return join(home, '.agent-presets')
}

/**
 * List every file under one directory, relative and `/`-separated.
 *
 * The separator is normalized deliberately: the stamp keys are compared across
 * runs and platforms, and a Windows install would otherwise record `skills\\x`
 * where the next run computes `skills/x`.
 *
 * @param {string} root - directory to walk.
 * @returns {Promise<string[]>} sorted relative paths.
 */
async function listFiles(root) {
  const found = []
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (IGNORED.has(entry.name) || entry.name === PRESET_STAMP) continue
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (entry.isFile()) found.push(relative(root, absolute).split(sep).join('/'))
    }
  }
  await walk(root)
  return found.sort()
}

/**
 * Hash every regular file in a directory tree.
 *
 * @param {string} root - directory to hash.
 * @returns {Promise<Record<string, string>>} relative path → sha256.
 */
async function hashTree(root) {
  const files = await listFiles(root)
  const hashes = {}
  for (const rel of files) {
    hashes[rel] = await hashFile(join(root, rel.split('/').join(sep)))
  }
  return hashes
}

/**
 * Hash one file.
 *
 * @param {string} path - file to read.
 * @returns {Promise<string>} the sha256 hex digest.
 */
async function hashFile(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex')
}

/**
 * Whether two path→hash maps describe exactly the same content.
 *
 * @param {Record<string, string>} left - first map.
 * @param {Record<string, string>} right - second map.
 * @returns {boolean} true when both hold the same keys and the same hashes.
 */
function sameTree(left, right) {
  const keys = Object.keys(left)
  if (keys.length !== Object.keys(right).length) return false
  return keys.every((key) => right[key] === left[key])
}

/**
 * Read the ownership stamp of an installed preset.
 *
 * A directory with no stamp, or with a stamp that does not carry this preset's
 * id and a file table, is not ours to manage. Returning undefined there is the
 * whole handoff mechanism: once `install.sh` has rewritten the directory (which
 * removes the stamp, because it mirrors the source with `--delete`), this plugin
 * stops touching that preset for good.
 *
 * @param {string} dest - installed preset directory.
 * @param {string} id - preset id the stamp must name.
 * @returns {Promise<{ files: Record<string, string> }|undefined>} the stamp, when it is ours.
 */
async function readStamp(dest, id) {
  let parsed
  try {
    parsed = JSON.parse(await readFile(join(dest, PRESET_STAMP), 'utf8'))
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  if (parsed.id !== id) return undefined
  if (parsed.files === null || typeof parsed.files !== 'object' || Array.isArray(parsed.files)) return undefined
  return parsed
}

/**
 * Whether a directory is a preset at all: the two files the loader requires.
 *
 * @param {string} directory - candidate directory.
 * @returns {Promise<boolean>} true when it looks like a preset.
 */
async function isPreset(directory) {
  for (const required of ['agent.cordis.yml', 'preset.yml']) {
    try {
      const info = await stat(join(directory, required))
      if (!info.isFile()) return false
    } catch {
      return false
    }
  }
  return true
}

/**
 * Scripts keep their executable bit; everything else is world-readable.
 *
 * Modes are set explicitly rather than inherited: the snapshot in this package
 * may have been created by a tool that wrote `0600`, and a preset the backend
 * cannot read is indistinguishable from a missing one.
 *
 * @param {string} rel - relative path inside the preset.
 * @returns {number} the file mode to apply.
 */
function modeFor(rel) {
  return /(^|\/)scripts\/[^/]+\.(sh|py|mjs|js)$/.test(rel) ? 0o755 : 0o644
}

/**
 * Remove directories left empty by a prune, deepest first.
 *
 * Removing the files is not quite enough to mirror a source tree: an empty
 * `skills/<name>/` left behind is still a directory the loader walks, and the
 * next snapshot that adds a file to that name would silently inherit the old
 * path. The root itself is never removed.
 *
 * @param {string} root - the preset directory to tidy.
 * @returns {Promise<void>} resolves once the walk settled.
 */
async function pruneEmptyDirectories(root) {
  const walk = async (directory) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const child = join(directory, entry.name)
      await walk(child)
      const remaining = await readdir(child)
      if (remaining.length === 0) await rm(child, { recursive: true, force: true })
    }
  }
  await walk(root)
}

/**
 * A backup directory name, unique within the second.
 *
 * @param {string} targetRoot - the preset root.
 * @param {string} id - preset id.
 * @returns {Promise<string>} an unused absolute path.
 */
async function backupPath(targetRoot, id) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const candidate = join(targetRoot, `.backup-${id}-${stamp}${attempt === 0 ? '' : `-${String(attempt + 1)}`}`)
    try {
      await stat(candidate)
    } catch {
      return candidate
    }
  }
  throw new Error(`could not find a free backup name for preset "${id}"`)
}

/**
 * Write one preset directory from the bundled snapshot.
 *
 * @param {object} options - `{ source, dest, files, targetRoot, id, prune }`.
 * @returns {Promise<{ backup?: string }>} what happened on the way.
 */
async function writePreset({ source, dest, files, targetRoot, id, prune }) {
  const result = {}
  if (prune) {
    const backup = await backupPath(targetRoot, id)
    await cp(dest, backup, { recursive: true })
    result.backup = backup
  }
  await mkdir(dest, { recursive: true })
  const written = new Set(files)
  for (const rel of files) {
    const to = join(dest, rel.split('/').join(sep))
    await mkdir(dirname(to), { recursive: true })
    await copyFile(join(source, rel.split('/').join(sep)), to)
    await chmod(to, modeFor(rel))
  }
  if (prune) {
    // Mirror the snapshot, including removals: `install.sh` does the same with
    // `rsync --delete`, and a stale file left behind is a file the preset still
    // loads (a removed skill would keep appearing in the catalogue).
    for (const rel of await listFiles(dest)) {
      if (written.has(rel)) continue
      await rm(join(dest, rel.split('/').join(sep)), { force: true })
    }
    await pruneEmptyDirectories(dest)
  }
  const hashes = {}
  for (const rel of files) hashes[rel] = await hashFile(join(dest, rel.split('/').join(sep)))
  await writeFile(
    join(dest, PRESET_STAMP),
    `${JSON.stringify({ id, source: 'dsh-remote-control/presets', files: hashes, installedAt: new Date().toISOString() }, null, 2)}\n`,
    'utf8'
  )
  return result
}

/**
 * Install every preset this package ships, idempotently.
 *
 * @param {object} [options] - `{ sourceRoot?, targetRoot? }`.
 * @returns {Promise<Array<{ id: string, action: 'installed'|'updated'|'current'|'foreign'|'failed', detail: string, path: string }>>} one entry per preset.
 */
export async function ensureBundledPresets({ sourceRoot = BUNDLED_PRESET_ROOT, targetRoot = presetsRoot() } = {}) {
  const report = []
  let ids
  try {
    const entries = await readdir(sourceRoot, { withFileTypes: true })
    ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort()
  } catch (error) {
    return [{ id: '(none)', action: 'failed', detail: `cannot read the bundled presets at ${sourceRoot}: ${error.message}`, path: sourceRoot }]
  }
  for (const id of ids) {
    const source = join(sourceRoot, id)
    const dest = join(targetRoot, id)
    try {
      if (!(await isPreset(source))) continue
      const files = await listFiles(source)
      const bundled = {}
      for (const rel of files) bundled[rel] = await hashFile(join(source, rel.split('/').join(sep)))
      let installed = true
      try {
        installed = (await stat(dest)).isDirectory()
      } catch {
        installed = false
      }
      if (!installed) {
        await mkdir(targetRoot, { recursive: true })
        await writePreset({ source, dest, files, targetRoot, id, prune: false })
        report.push({ id, action: 'installed', detail: `${String(files.length)} file(s) → ${dest}`, path: dest })
        continue
      }
      const stamp = await readStamp(dest, id)
      if (stamp === undefined) {
        report.push({
          id,
          action: 'foreign',
          detail: `${dest} was not installed by this plugin; left untouched`
        })
        continue
      }
      const onDisk = await hashTree(dest)
      if (sameTree(bundled, stamp.files) && sameTree(onDisk, stamp.files)) {
        report.push({ id, action: 'current', detail: dest })
        continue
      }
      const { backup } = await writePreset({ source, dest, files, targetRoot, id, prune: true })
      report.push({
        id,
        action: 'updated',
        detail: `refreshed ${String(files.length)} file(s) in ${dest}${backup === undefined ? '' : ` (backup: ${backup})`}`,
        path: dest
      })
    } catch (error) {
      report.push({ id, action: 'failed', detail: `${error?.message ?? error}`, path: dest })
    }
  }
  return report
}
