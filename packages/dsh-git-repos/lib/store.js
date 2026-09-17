/**
 * Repository registry for `dsh-git-repos` — the local database the panel lists.
 *
 * The tool window used to re-walk the working directory on every open, which is
 * the wrong shape for the workload it actually has: the *inventory* (which
 * checkouts exist under a root) changes once a week, while the thing the user
 * looks at twenty times a day is the working tree, which `git status` answers
 * per repository. The walk is also by far the expensive half — thousands of
 * `readdir` calls on a 200 GB Unity workbench.
 *
 * So the inventory lives here, in SQLite (via `node:sqlite`, dynamically
 * imported so a Node without it degrades to "no registry" instead of failing to
 * load the plugin), and opening the panel only syncs status against it.
 * Discovery runs when a root has no record yet, when the record was produced
 * with different scan budgets, or when the user asks for it explicitly
 * (`repos.rescan`).
 *
 * Three tables, and the reason each exists:
 *
 * - `workspace` — one scan record per scanned root: what the walk looked at,
 *   how it ended, and the budgets it used. The budgets are stored so a config
 *   change can invalidate the record instead of silently serving a list that a
 *   different `maxDepth` produced.
 * - `repository` — the inventory, keyed by canonical path.
 * - `membership` — which repositories a root's walk found, and their path
 *   relative to that root. This is a table rather than a column on
 *   `repository` because the roots overlap: the panel can be pointed at a
 *   workspace *and* at a subdirectory of it, and both walks legitimately see the
 *   same checkout. A single `workspace` column would let the nested listing
 *   steal the row from the outer one, and the outer list would lose a
 *   repository that is still right there on disk.
 *
 * Nothing about a repository's *status* is cached. `git status` is cheap, live
 * and never stale; the inventory is the part worth remembering.
 *
 * @module dsh-git-repos/store
 */

import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * Schema version, bumped whenever the tables change shape.
 *
 * It is not a migration mechanism: the data is a rebuildable cache of what is
 * on disk, so an older file is simply dropped and re-scanned.
 */
export const SCHEMA_VERSION = 1

/**
 * Discovery-policy version, mixed into every scan fingerprint.
 *
 * Bump this when a change to {@link discoverRepositoriesDetailed} would make an
 * existing record wrong (a new prune rule, a different definition of "found"),
 * because the fingerprint is what decides whether a stored list may be reused.
 */
const SCAN_POLICY_VERSION = 1

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace (
  root          TEXT PRIMARY KEY,
  scanned_at    TEXT NOT NULL,
  visited       INTEGER NOT NULL DEFAULT 0,
  max_depth     INTEGER NOT NULL DEFAULT 0,
  max_entries   INTEGER NOT NULL DEFAULT 0,
  depth_limited INTEGER NOT NULL DEFAULT 0,
  entry_limited INTEGER NOT NULL DEFAULT 0,
  truncated     INTEGER NOT NULL DEFAULT 0,
  single        INTEGER NOT NULL DEFAULT 0,
  found         INTEGER NOT NULL DEFAULT 0,
  fingerprint   TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repository (
  root          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS membership (
  workspace    TEXT NOT NULL,
  repo_root    TEXT NOT NULL,
  rel_path     TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  PRIMARY KEY (workspace, repo_root)
);
CREATE INDEX IF NOT EXISTS membership_repo ON membership (repo_root);
`

/**
 * Resolve the registry file path from plugin config.
 *
 * @param value - configured `store.path`, or undefined for the default.
 * @returns an absolute path; `:memory:` is passed through for tests.
 */
export function resolveStorePath(value) {
  const raw = typeof value === 'string' ? value.trim() : ''
  if (raw === '') return join(homedir(), '.dsh', 'git-repos', 'registry.db')
  if (raw === ':memory:') return raw
  if (raw.startsWith('~/')) return join(homedir(), raw.slice(2))
  return raw
}

/**
 * The identity of a scan's inputs.
 *
 * Two scans with the same fingerprint are interchangeable, so a stored record
 * may be reused; a different one means the list on disk was produced under
 * rules the current configuration no longer matches, and the root is re-scanned
 * rather than shown with the wrong budgets.
 *
 * @param config - normalized plugin config.
 * @returns a stable string.
 */
export function scanFingerprint(config) {
  return JSON.stringify({
    policy: SCAN_POLICY_VERSION,
    maxDepth: config.maxDepth,
    limit: config.limit,
    maxEntries: config.maxEntries,
  })
}

/**
 * Open the registry, degrading to an inert one when SQLite is unavailable.
 *
 * Failure is reported, never thrown: a plugin that cannot persist its inventory
 * must still work, it just goes back to walking the tree every time — and says
 * so in `health`, on the API envelope, and in the panel.
 *
 * @param options - `path` (absolute, or `:memory:`).
 * @returns the registry, or an unavailable stand-in carrying `error`.
 */
export async function openRegistry(options = {}) {
  const path = options.path ?? ':memory:'
  let db
  try {
    const { DatabaseSync } = await import('node:sqlite')
    if (path !== ':memory:') await mkdir(dirname(path), { recursive: true })
    db = new DatabaseSync(path)
    // WAL keeps a reader (the panel's poll) from blocking the writer (a scan),
    // and the busy timeout covers the reverse overlap between two requests.
    db.exec('PRAGMA journal_mode = WAL;')
    db.exec('PRAGMA busy_timeout = 4000;')
    const version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0)
    if (version !== 0 && version !== SCHEMA_VERSION) {
      // A cache, not a source of truth: rebuild rather than migrate.
      for (const table of ['membership', 'repository', 'workspace']) db.exec(`DROP TABLE IF EXISTS ${table};`)
    }
    db.exec(SCHEMA)
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION};`)
    return makeRegistry(db, path)
  } catch (error) {
    // Never leave a half-open handle behind: the caller has already decided to
    // carry on without a registry.
    try {
      db?.close()
    } catch {
      // Nothing useful to do about a close that fails right after an open did.
    }
    return unavailable(path, error?.message ?? String(error))
  }
}

/**
 * A registry that stores nothing, for the environments without `node:sqlite`.
 *
 * @param path - the path that was requested.
 * @param error - why it could not be opened.
 * @returns a registry-shaped object whose reads are empty and whose writes are
 *   no-ops, so every caller keeps one code path.
 */
function unavailable(path, error) {
  return {
    available: false,
    path,
    error,
    getWorkspace: async () => undefined,
    listRepos: async () => [],
    applyScan: async () => {},
    stats: async () => ({ workspaces: 0, repositories: 0 }),
    close: () => {},
  }
}

/**
 * Wrap a live handle in the registry API.
 *
 * Every method is async-shaped even though `node:sqlite` is synchronous: the
 * callers await their storage, and a backend that later needs real IO must not
 * force them to change.
 *
 * @param db - an open `DatabaseSync`.
 * @param path - the file backing it.
 * @returns the registry.
 */
function makeRegistry(db, path) {
  const selectWorkspace = db.prepare('SELECT * FROM workspace WHERE root = ?')
  const selectRepos = db.prepare(`
    SELECT m.repo_root AS root, m.rel_path AS rel_path, r.name AS name
    FROM membership m JOIN repository r ON r.root = m.repo_root
    WHERE m.workspace = ?
    ORDER BY m.repo_root
  `)
  const upsertWorkspace = db.prepare(`
    INSERT INTO workspace (root, scanned_at, visited, max_depth, max_entries,
                           depth_limited, entry_limited, truncated, single, found, fingerprint)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET
      scanned_at = excluded.scanned_at, visited = excluded.visited,
      max_depth = excluded.max_depth, max_entries = excluded.max_entries,
      depth_limited = excluded.depth_limited, entry_limited = excluded.entry_limited,
      truncated = excluded.truncated, single = excluded.single,
      found = excluded.found, fingerprint = excluded.fingerprint
  `)
  const upsertRepo = db.prepare(`
    INSERT INTO repository (root, name, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(root) DO UPDATE SET name = excluded.name, last_seen_at = excluded.last_seen_at
  `)
  const upsertMembership = db.prepare(`
    INSERT INTO membership (workspace, repo_root, rel_path, last_seen_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(workspace, repo_root) DO UPDATE SET
      rel_path = excluded.rel_path, last_seen_at = excluded.last_seen_at
  `)
  const selectMembers = db.prepare('SELECT repo_root FROM membership WHERE workspace = ?')
  const deleteMembership = db.prepare('DELETE FROM membership WHERE workspace = ? AND repo_root = ?')
  const deleteOrphans = db.prepare('DELETE FROM repository WHERE root NOT IN (SELECT repo_root FROM membership)')
  const countWorkspaces = db.prepare('SELECT COUNT(*) AS n FROM workspace')
  const countRepos = db.prepare('SELECT COUNT(*) AS n FROM repository')

  /** Run `fn` inside one transaction, rolling back on any failure. */
  const transaction = (fn) => {
    db.exec('BEGIN')
    try {
      fn()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  return {
    available: true,
    path,

    /** One root's scan record, or undefined when it has never been scanned. */
    getWorkspace: async (root) => {
      const row = selectWorkspace.get(root)
      return row === undefined ? undefined : normalizeWorkspace(row)
    },

    /** The inventory one root's last walk found, in path order. */
    listRepos: async (root) => selectRepos.all(root).map((row) => ({
      root: String(row.root),
      relPath: String(row.rel_path),
      name: String(row.name),
    })),

    /**
     * Record one scan: its budgets, its outcome, and the repositories it found.
     *
     * `prune` is the caller's verdict on whether the walk was trustworthy. A
     * scan cut short by the entry budget or the repository limit cannot tell
     * "this checkout was deleted" from "this checkout is past where I stopped",
     * so it is not allowed to remove anything — a list that is briefly long is a
     * much smaller problem than a list that silently drops a repository.
     *
     * @param input - `{ root, rows, meta, prune }`.
     */
    applyScan: async ({ root, rows, meta, prune }) => {
      const now = new Date().toISOString()
      transaction(() => {
        upsertWorkspace.run(
          root, meta.scannedAt ?? now, meta.visited ?? 0, meta.maxDepth ?? 0, meta.maxEntries ?? 0,
          meta.depthLimited ? 1 : 0, meta.entryLimited ? 1 : 0, meta.truncated ? 1 : 0, meta.single ? 1 : 0,
          rows.length, meta.fingerprint ?? '',
        )
        for (const row of rows) {
          upsertRepo.run(row.root, row.name ?? basename(row.root), now, now)
          upsertMembership.run(root, row.root, row.relPath ?? '.', now)
        }
        if (prune) {
          const keep = new Set(rows.map((row) => row.root))
          for (const existing of selectMembers.all(root)) {
            if (!keep.has(String(existing.repo_root))) deleteMembership.run(root, String(existing.repo_root))
          }
          deleteOrphans.run()
        }
      })
    },

    /** Cheap counts, for `health` and the settings panel. */
    stats: async () => ({
      workspaces: Number(countWorkspaces.get()?.n ?? 0),
      repositories: Number(countRepos.get()?.n ?? 0),
    }),

    /** Close the handle; the host calls this from its effect disposer. */
    close: () => {
      try {
        db.close()
      } catch {
        // Already closed, or the process is going away anyway.
      }
    },
  }
}

/**
 * Shape one `workspace` row for callers, with SQLite's 0/1 integers restored to
 * booleans so nothing above this module has to know how they are stored.
 *
 * @param row - raw row.
 * @returns the scan record.
 */
function normalizeWorkspace(row) {
  return {
    root: String(row.root),
    scannedAt: String(row.scanned_at),
    visited: Number(row.visited),
    maxDepth: Number(row.max_depth),
    maxEntries: Number(row.max_entries),
    depthLimited: Number(row.depth_limited) === 1,
    entryLimited: Number(row.entry_limited) === 1,
    truncated: Number(row.truncated) === 1,
    single: Number(row.single) === 1,
    found: Number(row.found),
    fingerprint: String(row.fingerprint),
  }
}

/**
 * The last path segment, used when a scan row does not carry a name.
 *
 * @param path - absolute path.
 * @returns the basename.
 */
function basename(path) {
  const parts = String(path).split('/').filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : String(path)
}
