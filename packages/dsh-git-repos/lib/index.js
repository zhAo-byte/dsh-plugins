/**
 * `dsh-git-repos` — host half.
 *
 * Publishes one JSON RPC surface, `POST /dsh-git-repos/api/<method>`, that the
 * browser half (the right-sidebar Git tool window) calls. Nothing here is
 * model-facing: no tool is registered, no prompt context is injected.
 *
 * Two guards stand in front of every request, because a loopback HTTP endpoint
 * is otherwise reachable by anything running in the browser:
 *
 * 1. **Cross-site refusal** — the request must carry a JSON content type and
 *    may not be `Sec-Fetch-Site: cross-site`, with any `Origin` restricted to a
 *    loopback host. A drive-by page therefore cannot drive git.
 * 2. **Containment** — every path in a payload must resolve inside a DSH
 *    registered workspace, inside a configured extra root, or (by default)
 *    inside `$HOME`. Paths are canonicalized with `realpath` first, so a
 *    symlink cannot be used to escape.
 *
 * @module dsh-git-repos
 */

import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

import * as gitEngine from './git.js'
import * as gitlab from './gitlab.js'

/** Cordis plugin name. */
export const name = 'dsh-git-repos'

/**
 * The HTTP transport is the only hard dependency.
 *
 * `workspaceRegistry` is read through {@link registryOf} instead of `inject`,
 * because a profile without the registry (a headless one, say) must still be
 * able to load this plugin and fall back to its configured roots.
 */
export const inject = ['webServer']

/**
 * Read the workspace registry without making it an activation requirement.
 *
 * Cordis' context proxy throws on an ungated service read, so this asks the
 * reflection layer for a non-strict lookup and reports absence as `undefined`.
 *
 * @param ctx - host context.
 * @returns the registry, or undefined when this profile has none.
 */
function registryOf(ctx) {
  try {
    if (typeof ctx?.get === 'function') return ctx.get('workspaceRegistry', false)
  } catch {
    // A profile without the registry simply has no registered workspaces.
  }
  return undefined
}

/** Route prefix owned by this plugin. */
const PREFIX = '/dsh-git-repos/api/'

/** Loopback spellings an `Origin` header may carry. */
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])

/* ── Guards ───────────────────────────────────────────────────────────────── */

/**
 * Whether `child` is `parent` or sits underneath it.
 *
 * @param parent - absolute canonical directory.
 * @param child - absolute canonical candidate.
 * @returns true when the candidate is contained.
 */
function isInside(parent, child) {
  const base = parent.endsWith(sep) ? parent.slice(0, -1) : parent
  return child === base || child.startsWith(`${base}${sep}`)
}

/**
 * Canonicalize a path, tolerating a missing leaf by canonicalizing its parent.
 *
 * @param target - path to resolve.
 * @returns the canonical absolute path, or the resolved spelling when nothing
 *   on disk matches.
 */
async function canonical(target) {
  const absolute = isAbsolute(target) ? target : resolve(target)
  try {
    return await realpath(absolute)
  } catch {
    const parent = resolve(absolute, '..')
    try {
      return resolve(await realpath(parent), absolute.split(sep).pop() ?? '')
    } catch {
      return absolute
    }
  }
}

/**
 * Normalize the plugin config.
 *
 * @param raw - config object from the patch layer, possibly empty.
 * @returns every field with its default applied.
 */
function normalizeConfig(raw) {
  const config = raw && typeof raw === 'object' ? raw : {}
  const discover = config.discover && typeof config.discover === 'object' ? config.discover : {}
  const timeouts = config.timeouts && typeof config.timeouts === 'object' ? config.timeouts : {}
  return {
    // Covers the ordinary container layouts; the ceiling lets a deeper monorepo
    // be scanned deliberately, and either budget is reported when it bites.
    maxDepth: clamp(Number(discover.maxDepth) || gitEngine.DEFAULT_MAX_DEPTH, 1, 24),
    limit: clamp(Number(discover.limit) || 60, 1, 400),
    maxEntries: clamp(Number(discover.maxEntries) || gitEngine.DEFAULT_MAX_ENTRIES, 1_000, 2_000_000),
    extraRoots: Array.isArray(config.extraRoots) ? config.extraRoots.filter((v) => typeof v === 'string') : [],
    allowHome: config.allowHome !== false,
    gitlabHosts: Array.isArray(config.gitlabHosts) ? config.gitlabHosts.filter((v) => typeof v === 'string') : [],
    readTimeoutMs: clamp(Number(timeouts.read) || 20_000, 1_000, 300_000),
    networkTimeoutMs: clamp(Number(timeouts.network) || 180_000, 5_000, 900_000),
    token: gitlab.resolveToken(config),
  }
}

/**
 * Clamp a number into a range.
 *
 * @param value - candidate.
 * @param low - inclusive minimum.
 * @param high - inclusive maximum.
 * @returns the clamped value.
 */
function clamp(value, low, high) {
  return Math.min(Math.max(value, low), high)
}

/**
 * Every root the API is allowed to touch.
 *
 * @param ctx - host context, read for the workspace registry.
 * @param config - normalized plugin config.
 * @returns canonical absolute roots.
 */
async function allowedRoots(ctx, config) {
  const roots = new Set()

  const registry = registryOf(ctx)
  if (registry && typeof registry.list === 'function') {
    try {
      for (const workspace of registry.list()) {
        if (typeof workspace?.path === 'string' && workspace.path !== '') roots.add(workspace.path)
      }
    } catch {
      // A failing registry must not take the panel down; extra roots still apply.
    }
  }

  for (const extra of config.extraRoots) roots.add(await canonical(extra))
  if (config.allowHome) {
    const home = process.env.HOME || homedir()
    if (home) roots.add(await canonical(home))
  }
  return [...roots]
}

/**
 * Refuse a payload path that escapes every allowed root.
 *
 * @param target - path from the payload.
 * @param roots - allowed canonical roots.
 * @param label - field name, used in the error.
 * @returns the canonical path.
 * @throws {Error} when the path is empty or outside every root.
 */
async function assertContained(target, roots, label) {
  if (typeof target !== 'string' || target.trim() === '') {
    throw new HttpError(400, `missing ${label}`)
  }
  if (roots.length === 0) {
    throw new HttpError(403, 'no workspace is registered and no extra root is configured, so no path may be touched')
  }
  const absolute = await canonical(target)
  if (!roots.some((root) => isInside(root, absolute))) {
    throw new HttpError(403, `${label} is outside every allowed root: ${target}`)
  }
  return absolute
}

/** An error carrying an HTTP status for the RPC envelope. */
class HttpError extends Error {
  /**
   * @param status - HTTP status to answer with.
   * @param message - human-readable reason.
   */
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/* ── RPC methods ──────────────────────────────────────────────────────────── */

/**
 * Build the method table bound to one host context.
 *
 * @param ctx - host context.
 * @param config - normalized plugin config.
 * @returns method name to handler.
 */
function buildMethods(ctx, config) {
  const read = { timeoutMs: config.readTimeoutMs }
  const net = { timeoutMs: config.networkTimeoutMs }

  /** Resolve a payload's repo root against the allowlist. */
  const repo = async (payload, label = 'root') => assertContained(payload.root, await allowedRoots(ctx, config), label)

  return {
    /** Liveness plus the roots this plugin may touch. */
    'health': async () => {
      const roots = await allowedRoots(ctx, config)
      return {
        plugin: 'dsh-git-repos',
        version: 1,
        roots,
        gitlab: { hosts: config.gitlabHosts, tokenConfigured: Boolean(config.token) },
        discover: { maxDepth: config.maxDepth, limit: config.limit, maxEntries: config.maxEntries },
      }
    },

    /** The registered workspaces, for the panel's root switcher. */
    'workspaces': async () => {
      const registry = registryOf(ctx)
      const list = []
      if (registry && typeof registry.list === 'function') {
        try {
          for (const workspace of registry.list()) {
            list.push({ id: workspace.id, path: workspace.path, title: workspace.title })
          }
        } catch {
          // Reported as an empty list; health still exposes the raw roots.
        }
      }
      return { workspaces: list, extraRoots: config.extraRoots }
    },

    /** Enumerate repositories under a root and summarize each one. */
    'repos.list': async (payload) => {
      const root = await repo(payload)
      const info = await stat(root).catch(() => undefined)
      if (!info?.isDirectory()) throw new HttpError(400, `not a directory: ${root}`)

      // A root that is itself a repository is not a reason to stop looking —
      // it is exactly where nested ones live: sibling checkouts under a Unity
      // `Assets/`, vendored clones, submodules. This used to short-circuit on
      // "the root is a repo" and return the root alone, which is why a
      // workspace like a game project showed one row and none of its modules.
      const scan = await gitEngine.discoverRepositoriesDetailed(root, {
        maxDepth: config.maxDepth,
        limit: config.limit,
        maxEntries: config.maxEntries,
      })
      let roots = scan.roots
      // Nothing under the root carries its own `.git`. Then the root is either
      // a bare repository (no `.git` entry to find) or a directory inside a
      // working tree; one row is right for both, and git resolves the
      // enclosing repository itself.
      let single = false
      if (roots.length === 0) {
        const top = await gitEngine.findRepoRoot(root)
        if (top !== undefined || await gitEngine.isRepository(root)) {
          roots = [root]
          single = true
        }
      }

      // Carried to the panel so an incomplete list can say why it is short.
      const discovery = {
        single,
        visited: scan.visited,
        maxDepth: scan.maxDepth,
        maxEntries: scan.maxEntries,
        depthLimited: scan.depthLimited,
        entryLimited: scan.entryLimited,
      }

      const repos = await mapLimit(roots, 6, async (repoRoot) => {
        const row = await gitEngine.summary(repoRoot, read)
        row.relPath = repoRoot === root ? '.' : repoRoot.slice(root.length + 1)
        row.remotes = (row.remotes ?? []).map((remote) => {
          const described = gitlab.describeRemote(remote.fetch ?? remote.push, config.gitlabHosts)
          return { ...remote, hosting: described.gitlab ? 'gitlab' : (described.local ? 'local' : 'other'), described }
        })
        return row
      })

      return {
        root,
        repos,
        scanned: roots.length,
        truncated: roots.length >= config.limit,
        discovery,
        generatedAt: new Date().toISOString(),
      }
    },

    /** One repository's summary. */
    'repo.summary': async (payload) => {
      const root = await repo(payload)
      const row = await gitEngine.summary(root, read)
      row.remotes = (row.remotes ?? []).map((remote) => ({
        ...remote,
        described: gitlab.describeRemote(remote.fetch ?? remote.push, config.gitlabHosts),
      }))
      return row
    },

    /** Working-tree status with every changed path. */
    'repo.status': async (payload) => gitEngine.status(await repo(payload), read),

    /** Local and remote branches with tracking state. */
    'repo.branches': async (payload) => gitEngine.branches(await repo(payload)),

    /** Recent commits. */
    'repo.log': async (payload) => ({
      commits: await gitEngine.log(await repo(payload), {
        limit: payload.limit,
        skip: payload.skip,
        ref: payload.ref,
      }),
    }),

    /** Remotes with hosting classification and deep links. */
    'repo.remotes': async (payload) => {
      const root = await repo(payload)
      const rows = await gitEngine.remotes(root)
      return {
        remotes: rows.map((remote) => {
          const described = gitlab.describeRemote(remote.fetch ?? remote.push, config.gitlabHosts)
          return {
            ...remote,
            described,
            links: described.gitlab ? gitlabLinks(described) : undefined,
          }
        }),
      }
    },

    /** Linked worktrees. */
    'repo.worktrees': async (payload) => ({ worktrees: await gitEngine.worktrees(await repo(payload)) }),

    /** Stash entries. */
    'repo.stashes': async (payload) => ({ stashes: await gitEngine.stashes(await repo(payload)) }),

    /** One unified diff: a working-tree path, an untracked file, or a commit. */
    'repo.diff': async (payload) => gitEngine.diff(await repo(payload), {
      path: payload.path,
      staged: payload.staged === true,
      untracked: payload.untracked === true,
      commit: payload.commit,
      context: payload.context,
    }),

    /** Fetch one remote. */
    'repo.fetch': async (payload) => {
      const root = await repo(payload)
      const output = await gitEngine.fetch(root, payload.remote || 'origin', net)
      return { output }
    },

    /** Fetch every named repository at once. */
    'repo.fetchAll': async (payload) => bulk(ctx, config, payload, 'fetch', net),

    /**
     * Run one network operation across many repositories.
     *
     * Kept as one method rather than three near-identical ones because the
     * interesting behaviour is shared: the allow-list check per root, bounded
     * concurrency, and a per-repository outcome so one failure never hides the
     * rest. `fetch`/`pull`/`push` only differ in which engine call runs.
     *
     * A `pull` that stops on a conflict is reported as `conflict` rather than as
     * a failure, and the repository is left mid-merge on purpose — that is how a
     * bulk pull is supposed to end when the base diverged, and the panel's merge
     * banner is what finishes it.
     */
    'repo.bulk': async (payload) => bulk(ctx, config, payload, payload.action, net),

    /**
     * Pre-flight for a bulk branch switch, across many repositories.
     *
     * Read-only on purpose, and deliberately a separate call: on a workbench of
     * twenty checkouts the useful question before switching them all is not "does
     * this repository have the branch" but "which of them are dirty, and would
     * this refuse there" — and that answer belongs on screen *before* the action,
     * not in a failure list afterwards.
     */
    'repo.bulkLoad': async (payload) => {
      const roots = await allowedRoots(ctx, config)
      const requested = Array.isArray(payload.roots) ? payload.roots : []
      if (requested.length === 0) throw new HttpError(400, 'roots must name at least one repository')
      const requestedBranch = typeof payload.branch === 'string' ? payload.branch.trim() : ''
      const targets = []
      for (const candidate of requested) targets.push(await assertContained(candidate, roots, 'roots[]'))

      const results = await mapLimit(targets, 6, async (root) => {
        try {
          const [state, load, names] = await Promise.all([
            gitEngine.status(root, read),
            gitEngine.workingTreeLoad(root),
            requestedBranch === '' ? Promise.resolve([]) : gitEngine.localBranchNames(root).catch(() => []),
          ])
          return {
            root,
            ok: true,
            branch: state.branch,
            detached: state.detached === true,
            load,
            hasBranch: requestedBranch === '' ? undefined : names.includes(requestedBranch),
            operation: state.operation,
          }
        } catch (error) {
          return { root, ok: false, error: error?.message ?? String(error) }
        }
      })
      return { results }
    },

    /**
     * Switch many repositories to one branch.
     *
     * The target is validated by the engine's ref rules, so every worker parses
     * the same name. `merge` decides whether local changes are carried across:
     * without it a dirty repository refuses and is reported as `blocked`, with it
     * the switch performs a three-way merge and a clash comes back as `conflict`
     * with the files listed — the repository is left holding those conflicts for
     * the changes tab, exactly like a stopped merge.
     */
    'repo.bulkSwitch': async (payload) => {
      const branch = typeof payload.branch === 'string' ? payload.branch.trim() : ''
      if (branch === '') throw new HttpError(400, 'branch is required')
      try {
        gitEngine.assertRefName(branch, 'branch')
      } catch (error) {
        throw new HttpError(400, error.message)
      }
      const roots = await allowedRoots(ctx, config)
      const requested = Array.isArray(payload.roots) ? payload.roots : []
      if (requested.length === 0) throw new HttpError(400, 'roots must name at least one repository')
      const merge = payload.merge === true
      const targets = []
      for (const candidate of requested) targets.push(await assertContained(candidate, roots, 'roots[]'))

      const results = await mapLimit(targets, 4, async (root) => {
        const result = await gitEngine.switchBranch(root, branch, { merge })
        return { root, ...result }
      })
      return { branch, merge, results }
    },

    /** The merge/rebase/cherry-pick/revert state that owns this working tree, if any. */
    'repo.operation': async (payload) => ({
      operation: await gitEngine.operationState(await repo(payload)),
    }),

    /** Merge one ref into the current branch. */
    'repo.merge': async (payload) => {
      const root = await repo(payload)
      const result = await gitEngine.merge(root, payload.target, {
        noFf: payload.noFf === true,
        ffOnly: payload.ffOnly === true,
        timeoutMs: config.networkTimeoutMs,
      })
      return result
    },

    /** Abandon the merge in progress. */
    'repo.mergeAbort': async (payload) => ({ output: await gitEngine.mergeAbort(await repo(payload)) }),

    /** Finish the merge in progress by committing the resolved index. */
    'repo.mergeContinue': async (payload) => ({
      output: await gitEngine.mergeContinue(await repo(payload), payload.message),
    }),

    /** Replay the current branch onto another ref. */
    'repo.rebase': async (payload) => {
      const root = await repo(payload)
      return await gitEngine.rebaseOnto(root, payload.onto, { timeoutMs: config.networkTimeoutMs })
    },

    /** Abandon the rebase in progress. */
    'repo.rebaseAbort': async (payload) => ({ output: await gitEngine.rebaseAbort(await repo(payload)) }),

    /** Continue the rebase in progress. */
    'repo.rebaseContinue': async (payload) => ({ output: await gitEngine.rebaseContinue(await repo(payload)) }),

    /** Pull the current branch. */
    'repo.pull': async (payload) => {
      const output = await gitEngine.pull(await repo(payload), { rebase: payload.rebase === true, ...net })
      return { output }
    },

    /** Push the current branch, optionally setting upstream. */
    'repo.push': async (payload) => {
      const output = await gitEngine.push(await repo(payload), {
        remote: payload.remote,
        branch: payload.branch,
        setUpstream: payload.setUpstream === true,
        force: payload.force === true,
        ...net,
      })
      return { output }
    },

    /** Switch to, or create, a branch. */
    'repo.checkout': async (payload) => {
      const output = await gitEngine.checkout(await repo(payload), payload.branch, {
        create: payload.create === true,
        startPoint: payload.startPoint,
      })
      return { output }
    },

    /** Delete a local branch. */
    'repo.branchDelete': async (payload) => {
      const output = await gitEngine.deleteBranch(await repo(payload), payload.branch, { force: payload.force === true })
      return { output }
    },

    /** Stage paths, or everything. */
    'repo.stage': async (payload) => {
      const output = await gitEngine.stage(await repo(payload), Array.isArray(payload.paths) ? payload.paths : [])
      return { output }
    },

    /** Unstage paths, or everything. */
    'repo.unstage': async (payload) => {
      const output = await gitEngine.unstage(await repo(payload), Array.isArray(payload.paths) ? payload.paths : [])
      return { output }
    },

    /** Commit the index. */
    'repo.commit': async (payload) => gitEngine.commit(await repo(payload), payload.message, { amend: payload.amend === true }),

    /** Discard changes for explicit paths. */
    'repo.discard': async (payload) => {
      const output = await gitEngine.discard(await repo(payload), Array.isArray(payload.paths) ? payload.paths : [], {
        staged: payload.staged === true,
        includeUntracked: payload.includeUntracked === true,
        untracked: Array.isArray(payload.untracked) ? payload.untracked : [],
      })
      return { output }
    },

    /** Stash the working tree. */
    'repo.stashPush': async (payload) => {
      const output = await gitEngine.stashPush(await repo(payload), {
        message: payload.message,
        includeUntracked: payload.includeUntracked !== false,
      })
      return { output }
    },

    /** Apply or pop a stash entry. */
    'repo.stashPop': async (payload) => {
      const output = await gitEngine.stashPop(await repo(payload), {
        index: payload.index,
        applyOnly: payload.applyOnly === true,
      })
      return { output }
    },

    /** Drop a stash entry. */
    'repo.stashDrop': async (payload) => {
      const output = await gitEngine.stashDrop(await repo(payload), { index: payload.index })
      return { output }
    },

    /** Initialize a repository. */
    'repo.init': async (payload) => {
      const root = await repo(payload)
      const output = await gitEngine.init(root, { initialBranch: payload.initialBranch })
      return { output }
    },

    /** Add or retarget a remote. */
    'repo.setRemote': async (payload) => {
      const root = await repo(payload)
      return gitEngine.setRemote(root, payload.name, payload.url)
    },

    /** Classify a remote URL and build its GitLab links, with no network call. */
    'gitlab.describe': async (payload) => {
      const described = gitlab.describeRemote(payload.url, config.gitlabHosts)
      return {
        described,
        links: described.gitlab ? gitlabLinks(described) : undefined,
        tokenConfigured: Boolean(config.token),
      }
    },

    /** Open merge requests for a branch. */
    'gitlab.mrs': async (payload) => {
      if (!config.token) return { ok: false, error: 'no GitLab token configured', items: [] }
      return gitlab.listMergeRequests({
        host: payload.host,
        project: payload.project,
        sourceBranch: payload.sourceBranch,
        state: payload.state,
        limit: payload.limit,
        token: config.token,
        timeoutMs: 25_000,
      })
    },

    /** Pipelines for a ref. */
    'gitlab.pipelines': async (payload) => {
      if (!config.token) return { ok: false, error: 'no GitLab token configured', items: [] }
      return gitlab.listPipelines({
        host: payload.host,
        project: payload.project,
        ref: payload.ref,
        limit: payload.limit,
        token: config.token,
        timeoutMs: 25_000,
      })
    },

    /** Project facts. */
    'gitlab.project': async (payload) => {
      if (!config.token) return { ok: false, error: 'no GitLab token configured' }
      return gitlab.projectInfo({
        host: payload.host,
        project: payload.project,
        token: config.token,
        timeoutMs: 25_000,
      })
    },
  }
}

/**
 * Every deep link the panel can offer for one GitLab remote.
 *
 * @param described - a {@link gitlab.describeRemote} result.
 * @returns link map, resolved lazily by the browser with the current ref.
 */
function gitlabLinks(described) {
  return {
    repository: gitlab.webUrl(described, { kind: 'repository' }),
    branches: gitlab.webUrl(described, { kind: 'branches' }),
    mergeRequests: gitlab.webUrl(described, { kind: 'merge-requests' }),
    pipelines: gitlab.webUrl(described, { kind: 'pipelines' }),
    settings: gitlab.webUrl(described, { kind: 'settings' }),
  }
}

/**
 * Map a list through an async function with bounded concurrency, preserving order.
 *
 * @param items - input list.
 * @param limit - maximum in flight.
 * @param fn - async mapper.
 * @returns results in input order.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/** The network actions `repo.bulk` knows how to run. */
const BULK_ACTIONS = new Set(['fetch', 'pull', 'push'])

/**
 * Run one network action across many repositories, reporting each one.
 *
 * Concurrency is bounded because these are network calls against the same
 * remote, and the per-repository outcome is the point: a bulk action that
 * aborted on the first failure would hide which repositories were never
 * attempted. A `pull` that stops on a conflict is reported as `conflict` rather
 * than as an error, because that is a state the panel can finish.
 *
 * @param ctx - host context.
 * @param config - normalized plugin config.
 * @param payload - `{ roots, remote?, rebase?, setUpstream? }`.
 * @param action - `'fetch'`, `'pull'`, or `'push'`.
 * @param net - network timeout options.
 * @returns `{ action, results }` with one row per requested root.
 * @throws {HttpError} when the action or a root is not admissible.
 */
async function bulk(ctx, config, payload, action, net) {
  if (!BULK_ACTIONS.has(action)) {
    throw new HttpError(400, `unknown bulk action: ${JSON.stringify(action)}; use fetch, pull, or push`)
  }
  const roots = await allowedRoots(ctx, config)
  const requested = Array.isArray(payload.roots) ? payload.roots : []
  if (requested.length === 0) throw new HttpError(400, 'roots must name at least one repository')
  const targets = []
  for (const candidate of requested) {
    targets.push(await assertContained(candidate, roots, 'roots[]'))
  }

  const results = await mapLimit(targets, 4, async (root) => {
    try {
      if (action === 'fetch') {
        return { root, ok: true, outcome: 'fetched', output: await gitEngine.fetch(root, payload.remote || 'origin', net) }
      }
      if (action === 'pull') {
        const rebase = payload.rebase === true
        const output = await gitEngine.pull(root, { rebase, ...net })
        // A fast-forward and a rebase are different enough to name apart: one
        // moved the branch, the other rewrote local commits.
        return { root, ok: true, outcome: rebase ? 'rebased' : 'pulled', output }
      }
      const output = await gitEngine.push(root, {
        remote: payload.remote,
        setUpstream: payload.setUpstream === true,
        ...net,
      })
      return { root, ok: true, outcome: 'pushed', output }
    } catch (error) {
      const stderr = typeof error?.stderr === 'string' ? error.stderr : ''
      // `pull --ff-only` refuses a divergence by exiting non-zero, and that
      // refusal is exactly what a bulk pull is most likely to hit. Naming it
      // `diverged` is what lets the panel say "run merge here" instead of
      // showing a raw git message.
      const diverged = /not possible to fast-forward|divergent branches|need to specify how to reconcile/i.test(stderr)
        || /not possible to fast-forward|divergent branches|need to specify how to reconcile/i.test(String(error?.message ?? ''))
      // A pull that stopped on conflicts leaves the repository mid-merge, which
      // is a different report from one that simply refused to fast-forward: the
      // first needs the user in the working tree, the second needs a merge.
      const operation = action === 'pull' ? (await gitEngine.operationState(root)).kind : 'none'
      if (operation === 'merge' || operation === 'rebase') {
        return { root, ok: false, outcome: 'conflict', error: error?.message ?? String(error) }
      }
      return {
        root,
        ok: false,
        outcome: diverged ? 'diverged' : 'failed',
        error: error?.message ?? String(error),
      }
    }
  })
  return { action, results }
}

/* ── Transport ────────────────────────────────────────────────────────────── */

/**
 * Read a request body with a hard cap.
 *
 * @param req - Node request.
 * @param limit - maximum bytes accepted.
 * @returns the raw body.
 * @throws {HttpError} when the body exceeds the cap.
 */
function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolvePromise, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new HttpError(413, 'request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolvePromise(Buffer.concat(chunks).toString('utf8')))
    req.on('error', (error) => reject(error))
  })
}

/**
 * Answer with JSON.
 *
 * @param res - Node response.
 * @param status - HTTP status.
 * @param body - serializable payload.
 */
function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store',
  })
  res.end(text)
}

/**
 * Whether the request may drive git at all.
 *
 * @param req - Node request.
 * @returns undefined when acceptable, otherwise the reason to refuse.
 */
function crossSiteReason(req) {
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase()
  if (fetchSite === 'cross-site') return 'cross-site request refused'

  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      const host = new URL(origin).hostname
      if (!LOOPBACK_HOSTS.has(host)) return `origin not on loopback: ${origin}`
    } catch {
      return `unparseable origin: ${origin}`
    }
  }

  const contentType = String(req.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    return 'content-type must be application/json'
  }
  return undefined
}

/**
 * Host plugin body: claim the RPC route.
 *
 * @param ctx - host context carrying `webServer`.
 * @param rawConfig - config from the bundle patch or the user patch layer.
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig)
  const methods = buildMethods(ctx, config)

  const handler = async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = url.pathname.startsWith(PREFIX) ? url.pathname.slice(PREFIX.length) : ''

    if (req.method === 'GET' && method === 'health') {
      try {
        sendJson(res, 200, { ok: true, value: await methods.health({}) })
      } catch (error) {
        sendJson(res, 500, { ok: false, error: { message: error?.message ?? String(error) } })
      }
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
      return
    }

    const reason = crossSiteReason(req)
    if (reason !== undefined) {
      sendJson(res, 403, { ok: false, error: { message: reason } })
      return
    }
    if (!Object.prototype.hasOwnProperty.call(methods, method)) {
      sendJson(res, 404, { ok: false, error: { message: `unknown method: ${method}` } })
      return
    }

    let payload = {}
    try {
      const raw = await readBody(req)
      payload = raw === '' ? {} : JSON.parse(raw)
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new HttpError(400, 'payload must be a JSON object')
      }
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 400
      sendJson(res, status, { ok: false, error: { message: error?.message ?? 'invalid JSON body' } })
      return
    }

    try {
      const value = await methods[method](payload)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      const status = error instanceof HttpError ? error.status : (error instanceof gitEngine.GitError ? 409 : 500)
      sendJson(res, status, {
        ok: false,
        error: {
          message: error?.message ?? String(error),
          code: error?.code,
          command: error?.command,
        },
      })
    }
  }

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: '/dsh-git-repos/api',
    handler,
  }), 'dsh-git-repos: /dsh-git-repos/api routes')
}
