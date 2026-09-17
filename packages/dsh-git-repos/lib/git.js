/**
 * Git engine for `dsh-git-repos` — the Node host half's whole command surface.
 *
 * Every invocation goes through {@link runGit}, which shells out to the system
 * `git` with an **argv array** (never a composed command string) so no branch
 * name, path, or commit message can ever be reinterpreted by a shell. Reads use
 * machine-stable formats (`--porcelain=v2 -z`, `for-each-ref` with `%1f`
 * separators, `%x1e`-terminated logs) so parsing survives any locale.
 *
 * Mutating helpers are all narrow: one intent per function, every path passed
 * after `--`, every ref validated by {@link assertRefName}. Callers (the HTTP
 * layer) own the workspace containment guard; this module only insists on
 * well-formed arguments.
 *
 * @module dsh-git-repos/git
 */

import { spawn } from 'node:child_process'
import { access, readdir, realpath } from 'node:fs/promises'
import { constants } from 'node:fs'
import { isAbsolute, join, normalize, relative, sep } from 'node:path'

/** Field separator inside one `for-each-ref`/`log` record. */
const US = '\u001f'
/** Record separator between log records. */
const RS = '\u001e'

/** One git failure, carrying the intent so the panel can show something useful. */
export class GitError extends Error {
  /**
   * @param message - human-readable failure.
   * @param options - `code` is a stable slug, `command` the argv that failed.
   */
  constructor(message, options = {}) {
    super(message)
    this.name = 'GitError'
    this.code = options.code ?? 'git-error'
    this.command = options.command ?? ''
    this.stderr = options.stderr ?? ''
  }
}

/** Directories never worth descending into while enumerating repositories. */
const PRUNE = new Set([
  '.git', '.hg', '.svn', '.Trash', '.cache', '.cargo', '.gradle', '.idea',
  '.m2', '.next', '.nuxt', '.nx', '.parcel-cache', '.pnpm-store', '.svelte-kit',
  '.terraform', '.tox', '.venv', '.yarn', '__pycache__', 'build', 'DerivedData',
  'dist', 'Library', 'node_modules', 'out', 'Pods', 'target', 'temp', 'tmp',
  'venv', 'vendor',
])

/**
 * Run one git command.
 *
 * @param cwd - directory to run in (must exist; git resolves the repo itself).
 * @param args - argv array, passed verbatim.
 * @param options - `timeoutMs` bounds the process; `maxBytes` bounds stdout;
 *   `env` adds variables for this call only (applied after the fixed defaults).
 * @returns the exit code plus both streams, decoded as UTF-8.
 * @throws {GitError} when the timeout fires or the process cannot be spawned.
 */
export function runGit(cwd, args, options = {}) {
  const timeoutMs = options.timeoutMs ?? 20_000
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024

  return new Promise((resolvePromise, reject) => {
    const child = spawn('git', args, {
      cwd,
      env: {
        ...process.env,
        // Never block on an interactive prompt, never page, and keep messages
        // in the C locale so our own error text is stable and parseable.
        GIT_TERMINAL_PROMPT: '0',
        GIT_PAGER: 'cat',
        GIT_OPTIONAL_LOCKS: '1',
        LC_ALL: 'C',
        ...(options.env ?? {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    const out = []
    const err = []
    let outBytes = 0
    let settled = false
    let timer

    const finish = (fn, value) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn(value)
    }

    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        child.kill('SIGKILL')
        finish(reject, new GitError(`git ${args[0] ?? ''} timed out after ${timeoutMs} ms`, {
          code: 'timeout',
          command: `git ${args.join(' ')}`,
        }))
      }, timeoutMs)
      if (typeof timer.unref === 'function') timer.unref()
    }

    child.stdout.on('data', (chunk) => {
      outBytes += chunk.length
      if (outBytes > maxBytes) {
        child.kill('SIGKILL')
        finish(reject, new GitError('git produced more output than the plugin will buffer', {
          code: 'output-too-large',
          command: `git ${args.join(' ')}`,
        }))
        return
      }
      out.push(chunk)
    })
    child.stderr.on('data', (chunk) => err.push(chunk))

    child.on('error', (error) => {
      finish(reject, new GitError(`git could not be started: ${error.message}`, {
        code: 'git-missing',
        command: `git ${args.join(' ')}`,
      }))
    })

    child.on('close', (code) => {
      finish(resolvePromise, {
        code: code ?? -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        argv: `git ${args.join(' ')}`,
      })
    })
  })
}

/**
 * Run one git command and fail loudly on a non-zero exit.
 *
 * @param cwd - directory to run in.
 * @param args - argv array.
 * @param options - forwarded to {@link runGit}.
 * @returns stdout, trimmed of the trailing newline git adds.
 * @throws {GitError} when git exits non-zero.
 */
export async function git(cwd, args, options = {}) {
  const result = await runGit(cwd, args, options)
  if (result.code !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`
    throw new GitError(detail.split('\n')[0], {
      code: 'git-failed',
      command: result.argv,
      stderr: result.stderr,
    })
  }
  return result.stdout.replace(/\n+$/, '')
}

/**
 * Reject anything that could be read as an option or that escapes the repo.
 *
 * @param value - candidate ref (branch, tag, remote).
 * @param label - what to call it in the error message.
 * @returns the same value, when it is safe.
 * @throws {GitError} on an empty, option-like, or malformed ref.
 */
export function assertRefName(value, label = 'ref') {
  const ref = String(value ?? '')
  if (ref === '') throw new GitError(`empty ${label}`, { code: 'bad-argument' })
  if (ref.startsWith('-')) throw new GitError(`${label} may not start with "-": ${ref}`, { code: 'bad-argument' })
  // Conservative: git's own ref rules are looser, but branches people type are not.
  if (!/^[A-Za-z0-9._][A-Za-z0-9._/@+-]*$/.test(ref)) {
    throw new GitError(`invalid ${label}: ${ref}`, { code: 'bad-argument' })
  }
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) {
    throw new GitError(`invalid ${label}: ${ref}`, { code: 'bad-argument' })
  }
  return ref
}

/**
 * Reject a repo-relative path that is absolute, empty, or walks upward.
 *
 * @param value - candidate path as written in `git status`.
 * @param label - what to call it in the error message.
 * @returns the normalized, repo-relative path.
 * @throws {GitError} when the path escapes the repository.
 */
export function assertRepoPath(value, label = 'path') {
  const raw = String(value ?? '')
  if (raw === '') throw new GitError(`empty ${label}`, { code: 'bad-argument' })
  if (isAbsolute(raw)) throw new GitError(`${label} must be repo-relative: ${raw}`, { code: 'bad-argument' })
  const normalized = normalize(raw)
  if (normalized === '..' || normalized.startsWith(`..${sep}`) || normalized.split(sep).includes('..')) {
    throw new GitError(`${label} escapes the repository: ${raw}`, { code: 'bad-argument' })
  }
  return normalized.split(sep).join('/')
}

/**
 * Whether a directory is the root of a git working tree or a bare repository.
 *
 * @param dir - absolute directory to test.
 * @returns true when git itself agrees this path belongs to a repository.
 */
export async function isRepository(dir) {
  try {
    const top = await git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8_000 })
    return top !== ''
  } catch {
    // A bare repo has no toplevel; fall back to the bare check.
    try {
      const bare = await git(dir, ['rev-parse', '--is-bare-repository'], { timeoutMs: 8_000 })
      return bare === 'true'
    } catch {
      return false
    }
  }
}

/**
 * Resolve the working-tree root that owns a directory.
 *
 * @param dir - any directory inside (or above) a working tree.
 * @returns the absolute repo root, or undefined when there is none.
 */
export async function findRepoRoot(dir) {
  try {
    const top = await git(dir, ['rev-parse', '--show-toplevel'], { timeoutMs: 8_000 })
    return top === '' ? undefined : await realpath(top).catch(() => top)
  } catch {
    return undefined
  }
}

/**
 * Default walk depth.
 *
 * Four levels is enough for a flat multi-repo workbench, but not for layouts
 * where a checkout lives under a group directory: a Unity project keeps its
 * sibling repositories at `Assets/<Group>/<Module>`, which is depth 5. At the
 * old default of 4 that whole layer was invisible, and nothing in the result
 * said the list had been cut — the bug this constant exists to prevent.
 *
 * Eight is a *policy* boundary, not a claim of completeness, and the caller is
 * told when it bites so the panel can say so. That distinction is deliberate:
 * a 200 GB Unity workbench measures deeper than 24 levels and ~139k
 * directories, so no affordable fixed depth finishes it, and pretending
 * otherwise would only hide the boundary again. Eight instead covers every
 * ordinary container layout (Unity 5, monorepo `packages/<group>/<pkg>` 3,
 * most others 2–4) for ~0.6s, and anything past it is reported.
 */
export const DEFAULT_MAX_DEPTH = 8

/**
 * Directories visited before the walk gives up.
 *
 * This is the safety valve for a pathological tree (or a workspace that is
 * `$HOME`), and tripping it is an anomaly rather than a policy — the panel
 * shows it as a warning, unlike the depth boundary. Measured: the 200 GB
 * workbench above needs ~6.5k directories at the default depth.
 */
export const DEFAULT_MAX_ENTRIES = 40_000

/**
 * Whether an entry is a directory the walk would descend into.
 *
 * Keeping this in one place is what makes {@link discoverRepositoriesDetailed}
 * able to say "the depth budget hid something" instead of just stopping: the
 * same predicate that would have enqueued a child decides whether skipping it
 * was a real omission.
 *
 * @param entry - one `readdir(..., { withFileTypes: true })` entry.
 * @returns true when the entry should be descended into.
 */
function descendable(entry) {
  if (!entry.isDirectory() && !entry.isSymbolicLink()) return false
  if (entry.name.startsWith('.') && entry.name !== '.config') return false
  return !PRUNE.has(entry.name)
}

/**
 * Enumerate every repository at or under a root, breadth-first and bounded.
 *
 * A repository is recorded and still descended into: nested repositories
 * (submodules, vendored checkouts, sibling clones) are reported separately,
 * because a Rider-style tool window is expected to show each one.
 *
 * Two budgets can cut the walk short, and both are reported rather than
 * silently applied — a list that is quietly incomplete is the failure mode
 * this exists to avoid:
 *
 * - `maxDepth` stops descending below that level, so deeper repositories are
 *   never seen (`depthLimited`).
 * - `maxEntries` stops reading directories altogether (`entryLimited`).
 *
 * @param root - absolute directory to scan.
 * @param options - `maxDepth`, `limit`, and `maxEntries` bound the walk.
 * @returns the absolute repo roots (path-ordered) plus the budget facts.
 */
export async function discoverRepositoriesDetailed(root, options = {}) {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH
  const limit = options.limit ?? 60
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
  const found = []
  const seen = new Set()
  let visited = 0
  let depthLimited = false
  let entryLimited = false

  /** @type {Array<{ dir: string, depth: number }>} */
  let frontier = [{ dir: root, depth: 0 }]

  const done = () => ({
    // Order by path so the list is stable across scans.
    roots: found.sort(),
    visited,
    depthLimited,
    entryLimited,
    maxDepth,
    maxEntries,
    limit,
  })

  while (frontier.length > 0) {
    const next = []
    // One level at a time, entries read in parallel but results applied in order.
    const listings = await Promise.all(frontier.map(async (node) => {
      visited += 1
      if (visited > maxEntries) {
        entryLimited = true
        return { node, entries: [] }
      }
      try {
        const entries = await readdir(node.dir, { withFileTypes: true })
        return { node, entries }
      } catch {
        return { node, entries: [] }
      }
    }))

    for (const { node, entries } of listings) {
      const hasGit = entries.some((entry) => entry.name === '.git')
      if (hasGit && !seen.has(node.dir)) {
        seen.add(node.dir)
        found.push(node.dir)
        if (found.length >= limit) return done()
      }
      if (node.depth >= maxDepth) {
        // Only children we would really have visited count as hidden.
        if (entries.some(descendable)) depthLimited = true
        continue
      }
      for (const entry of entries) {
        if (!descendable(entry)) continue
        next.push({ dir: join(node.dir, entry.name), depth: node.depth + 1 })
      }
    }
    frontier = next
  }

  return done()
}

/**
 * Array-only form of {@link discoverRepositoriesDetailed}.
 *
 * @param root - absolute directory to scan.
 * @param options - forwarded to the detailed variant.
 * @returns absolute repo roots, path-ordered.
 */
export async function discoverRepositories(root, options = {}) {
  const result = await discoverRepositoriesDetailed(root, options)
  return result.roots
}

/**
 * Parse one `git status --porcelain=v2 --branch -z` stream.
 *
 * @param output - the raw NUL-separated stream.
 * @returns branch facts plus one entry per changed path.
 */
export function parseStatus(output) {
  const tokens = output.split('\0')
  const result = {
    branch: '',
    oid: '',
    upstream: undefined,
    ahead: 0,
    behind: 0,
    detached: false,
    entries: [],
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '' || token === undefined) continue

    if (token.startsWith('# ')) {
      const [key, ...rest] = token.slice(2).split(' ')
      const value = rest.join(' ')
      if (key === 'branch.oid') result.oid = value === '(initial)' ? '' : value
      else if (key === 'branch.head') {
        result.branch = value
        result.detached = value === '(detached)'
      } else if (key === 'branch.upstream') result.upstream = value
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value)
        if (match) {
          result.ahead = Number(match[1])
          result.behind = Number(match[2])
        }
      }
      continue
    }

    const kind = token[0]
    if (kind === '1' || kind === '2') {
      const fields = token.split(' ')
      const xy = fields[1] ?? '..'
      const start = kind === '1' ? 8 : 9
      const path = fields.slice(start).join(' ')
      let origPath
      if (kind === '2') {
        const candidate = tokens[index + 1]
        if (candidate !== undefined && candidate !== '') {
          origPath = candidate
          index += 1
        }
      }
      result.entries.push(makeEntry(xy, path, origPath))
      continue
    }
    if (kind === 'u') {
      const fields = token.split(' ')
      const xy = fields[1] ?? 'UU'
      result.entries.push(makeEntry(xy, fields.slice(10).join(' '), undefined, true))
      continue
    }
    if (kind === '?') {
      result.entries.push(makeEntry('??', token.slice(2)))
      continue
    }
    // '!' ignored entries are deliberately dropped.
  }

  return result
}

/**
 * Classify one porcelain XY pair into the shape the panel renders.
 *
 * @param xy - the two status letters.
 * @param path - repo-relative path.
 * @param origPath - previous path for a rename or copy.
 * @param forceConflict - set for `u` records, which are always conflicts.
 * @returns the entry.
 */
function makeEntry(xy, path, origPath, forceConflict = false) {
  const indexStatus = xy[0] ?? '.'
  const worktreeStatus = xy[1] ?? '.'
  const untracked = xy === '??'
  const ignored = xy === '!!'
  const conflicted = forceConflict || (indexStatus === 'U' || worktreeStatus === 'U'
    || (indexStatus === 'A' && worktreeStatus === 'A')
    || (indexStatus === 'D' && worktreeStatus === 'D'))
  return {
    path,
    origPath,
    index: indexStatus,
    worktree: worktreeStatus,
    untracked,
    ignored,
    conflicted,
    staged: !untracked && !ignored && indexStatus !== '.' && indexStatus !== ' ',
    unstaged: !untracked && !ignored && worktreeStatus !== '.' && worktreeStatus !== ' ',
    deleted: indexStatus === 'D' || worktreeStatus === 'D',
    renamed: indexStatus === 'R' || worktreeStatus === 'R',
    added: indexStatus === 'A' || untracked,
  }
}

/**
 * Read one repository's working-tree state.
 *
 * @param root - repo root.
 * @param options - forwarded to git for the timeout.
 * @returns branch facts, change entries, and counts derived from them.
 */
export async function status(root, options = {}) {
  // `--untracked-files=all` lists every untracked file instead of collapsing a
  // new directory into one entry: a tool window needs the files, because a
  // directory has no diff and cannot be staged individually.
  const raw = await git(root, [
    'status', '--porcelain=v2', '--branch', '--untracked-files=all', '-z',
  ], { timeoutMs: options.timeoutMs ?? 20_000, maxBytes: 16 * 1024 * 1024 })

  const parsed = parseStatus(raw)
  const counts = { changed: 0, staged: 0, unstaged: 0, untracked: 0, conflicted: 0, deleted: 0, renamed: 0 }
  for (const entry of parsed.entries) {
    counts.changed += 1
    if (entry.staged) counts.staged += 1
    if (entry.unstaged) counts.unstaged += 1
    if (entry.untracked) counts.untracked += 1
    if (entry.conflicted) counts.conflicted += 1
    if (entry.deleted) counts.deleted += 1
    if (entry.renamed) counts.renamed += 1
  }

  const operation = await operationState(root)
  return { ...parsed, counts, clean: parsed.entries.length === 0, operation }
}

/**
 * Whether a path exists, without caring why it might not.
 *
 * @param path - absolute path.
 * @returns true when it can be stat'ed.
 */
async function exists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Detect an operation that is in progress and therefore owns the working tree.
 *
 * A conflict is not just a dirty file: merge, rebase, cherry-pick and revert all
 * leave the repository in a state where the next `git commit` finishes *their*
 * work rather than the user's, and the panel has to say so or every button it
 * offers is a trap. The paths come from `git rev-parse --git-dir`, so a linked
 * worktree (where `.git` is a file, not a directory) is handled by git's own
 * answer instead of by guessing.
 *
 * @param root - repo root.
 * @returns `{ kind, rebaseKind }`; `kind` is `none` for an ordinary working tree.
 */
export async function operationState(root) {
  let gitDir = ''
  try {
    const raw = (await git(root, ['rev-parse', '--absolute-git-dir'], { timeoutMs: 10_000 })).trim()
    if (raw !== '') gitDir = raw
  } catch {
    // An unreadable git dir means "not a repository" for every caller of this
    // helper; the surrounding status call reports the real failure.
    return { kind: 'none' }
  }
  if (gitDir === '') return { kind: 'none' }

  const [rebaseMerge, rebaseApply, cherryPick, revert] = await Promise.all([
    exists(join(gitDir, 'rebase-merge')),
    exists(join(gitDir, 'rebase-apply')),
    exists(join(gitDir, 'CHERRY_PICK_HEAD')),
    exists(join(gitDir, 'REVERT_HEAD')),
  ])
  // Checked before rebase: an interactive rebase stops on a conflict with the
  // apply directory present too, and naming it `rebase` is the useful answer.
  if (rebaseMerge || rebaseApply) {
    const kind = await rebaseKindOf(gitDir)
    return { kind: 'rebase', rebaseKind: kind }
  }
  if (cherryPick) return { kind: 'cherry-pick' }
  if (revert) return { kind: 'revert' }
  if (await exists(join(gitDir, 'MERGE_HEAD'))) return { kind: 'merge' }
  return { kind: 'none' }
}

/**
 * Whether the rebase in progress is replaying onto a new base or rewording.
 *
 * `rebase-apply` is what a plain `git rebase` leaves behind when it stops, and
 * `rebase-merge` is interactive/merge-backed; the distinction decides which verb
 * the panel offers to finish it.
 *
 * @param gitDir - absolute git directory.
 * @returns `'merge'`, `'apply'`, or `undefined` when neither is readable.
 */
async function rebaseKindOf(gitDir) {
  if (await exists(join(gitDir, 'rebase-merge'))) return 'merge'
  if (await exists(join(gitDir, 'rebase-apply'))) return 'apply'
  return undefined
}

/**
 * The set of paths git currently reports as unmerged.
 *
 * Used after a merge attempt to tell "merged cleanly" from "stopped on
 * conflicts", which is the difference between a finished action and one that
 * needs the user in the working tree.
 *
 * @param root - repo root.
 * @returns repo-relative conflicted paths.
 */
async function conflictedPaths(root) {
  let raw = ''
  try {
    raw = await git(root, ['diff', '--name-only', '--diff-filter=U', '-z'], { timeoutMs: 20_000 })
  } catch {
    return []
  }
  return raw.split('\0').filter((path) => path !== '')
}

/**
 * Merge one ref into the current branch.
 *
 * Both non-fast-forward policies are deliberate rather than defaults borrowed
 * from git: a fast-forward is reported as its own outcome so the panel can say
 * "moved the branch" instead of "created a commit", and a conflict comes back as
 * a result instead of a thrown error, because stopping on a conflict is the
 * normal way this operation ends in a tool window. The repository is left in the
 * merge state on purpose — resolving and committing is the user's next step, and
 * `mergeAbort` is the way out.
 *
 * @param root - repo root.
 * @param target - branch, tag, or commit to merge in.
 * @param options - `noFf` forces a merge commit; `ffOnly` refuses anything else.
 * @returns how the merge ended, plus the conflicted paths when it stopped.
 */
export async function merge(root, target, options = {}) {
  const ref = assertRefName(target, 'merge target')
  const args = ['merge']
  if (options.ffOnly) args.push('--ff-only')
  else if (options.noFf) args.push('--no-ff')
  args.push(ref)
  let output = ''
  try {
    output = await git(root, args, { timeoutMs: options.timeoutMs ?? 120_000 })
  } catch (error) {
    // `git merge` exits non-zero on a conflict and prints what to do next; the
    // files it names are read from the index rather than parsed out of stderr.
    const conflicts = await conflictedPaths(root)
    if (conflicts.length === 0) throw error
    return { ok: false, merged: 'conflict', target: ref, conflicts, output: error.stderr || error.message }
  }
  const conflicts = await conflictedPaths(root)
  if (conflicts.length > 0) return { ok: false, merged: 'conflict', target: ref, conflicts, output }
  // Three distinct endings, and the panel words all three differently: a moved
  // branch is not a merge commit, and neither is a no-op.
  if (/already up to date/i.test(output)) return { ok: true, merged: 'up-to-date', target: ref, conflicts: [], output }
  if (/^Fast-forward/m.test(output)) return { ok: true, merged: 'fast-forward', target: ref, conflicts: [], output }
  return { ok: true, merged: 'merged', target: ref, conflicts: [], output }
}

/**
 * Abort the merge in progress, restoring the pre-merge state.
 *
 * @param root - repo root.
 * @returns git's own output.
 */
export async function mergeAbort(root) {
  return git(root, ['merge', '--abort'], { timeoutMs: 60_000 })
}

/**
 * Finish the merge in progress by committing the resolved index.
 *
 * @param root - repo root.
 * @param message - optional message override; git's prepared `MERGE_MSG` is used when omitted.
 * @returns git's own output.
 */
export async function mergeContinue(root, message) {
  const text = String(message ?? '').trim()
  const args = ['commit', '--no-edit']
  if (text !== '') args.splice(1, 1, '-m', text)
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Rebase the current branch onto another ref.
 *
 * Conflicts are returned rather than thrown for the same reason as `merge`: a
 * stopped rebase is a state the panel renders and the user finishes. `onto`
 * names the new base, which is also what a plain `git rebase <base>` means.
 *
 * @param root - repo root.
 * @param onto - ref to replay onto.
 * @param options - `interactive` is rejected on purpose: this surface cannot drive an editor.
 * @returns how the rebase ended.
 */
export async function rebaseOnto(root, onto, options = {}) {
  const ref = assertRefName(onto, 'rebase target')
  let output = ''
  try {
    output = await git(root, ['rebase', ref], { timeoutMs: options.timeoutMs ?? 180_000 })
  } catch (error) {
    const state = await operationState(root)
    const conflicts = await conflictedPaths(root)
    if (state.kind !== 'rebase' && conflicts.length === 0) throw error
    return { ok: false, merged: 'conflict', target: ref, conflicts, output: error.stderr || error.message }
  }
  return { ok: true, merged: /up to date|up-to-date/i.test(output) ? 'up-to-date' : 'rebased', target: ref, conflicts: [], output }
}

/**
 * Abort the rebase in progress.
 *
 * @param root - repo root.
 * @returns git's own output.
 */
export async function rebaseAbort(root) {
  return git(root, ['rebase', '--abort'], { timeoutMs: 60_000 })
}

/**
 * Continue the rebase in progress.
 *
 * `GIT_EDITOR=true` matters: without it git opens the commit-message editor for
 * every stopped step, and this plugin has no terminal to show it in. Accepting
 * the prepared message is the only behaviour a web panel can honestly offer.
 *
 * @param root - repo root.
 * @returns git's own output.
 */
export async function rebaseContinue(root) {
  return git(root, ['rebase', '--continue'], { env: { GIT_EDITOR: 'true' }, timeoutMs: 180_000 })
}

/**
 * List every remote with its fetch and push URLs.
 *
 * @param root - repo root.
 * @returns one row per remote, fetch URL first.
 */
export async function remotes(root) {
  let raw = ''
  try {
    raw = await git(root, ['remote', '-v'], { timeoutMs: 10_000 })
  } catch {
    return []
  }
  /** @type {Map<string, { name: string, fetch?: string, push?: string }>} */
  const table = new Map()
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line.trim())
    if (!match) continue
    const [, name, url, kind] = match
    const row = table.get(name) ?? { name }
    if (kind === 'fetch') row.fetch = url
    else row.push = url
    table.set(name, row)
  }
  return [...table.values()]
}

/**
 * Read the local and remote branch inventory with upstream tracking.
 *
 * @param root - repo root.
 * @returns local branches, remote branches, and the current branch name.
 */
export async function branches(root) {
  const format = ['%(refname:short)', '%(objectname:short)', '%(upstream:short)',
    '%(upstream:track)', '%(committerdate:iso-strict)', '%(HEAD)'].join(US)

  const [localRaw, remoteRaw, statusResult] = await Promise.all([
    git(root, ['for-each-ref', `--format=${format}`, 'refs/heads'], { timeoutMs: 15_000 }),
    git(root, ['for-each-ref', `--format=${format}`, 'refs/remotes'], { timeoutMs: 15_000 }),
    status(root).catch(() => undefined),
  ])

  const parse = (raw, kind) => raw.split('\n').filter((line) => line !== '').map((line) => {
    const [name, sha, upstream, track, date, head] = line.split(US)
    const ahead = /ahead (\d+)/.exec(track ?? '')
    const behind = /behind (\d+)/.exec(track ?? '')
    return {
      kind,
      name,
      sha,
      upstream: upstream || undefined,
      ahead: ahead ? Number(ahead[1]) : 0,
      behind: behind ? Number(behind[1]) : 0,
      gone: (track ?? '').includes('gone'),
      date,
      current: head === '*',
    }
  })

  return {
    current: statusResult?.branch ?? '',
    detached: statusResult?.detached ?? false,
    local: parse(localRaw, 'local'),
    remote: parse(remoteRaw, 'remote'),
  }
}

/**
 * Read recent commits.
 *
 * @param root - repo root.
 * @param options - `limit` (default 40), `skip`, and an optional `ref`.
 * @returns newest-first commit rows.
 */
export async function log(root, options = {}) {
  const limit = Math.min(Math.max(Number(options.limit) || 40, 1), 500)
  const skip = Math.max(Number(options.skip) || 0, 0)
  const format = ['%H', '%h', '%an', '%aI', '%s', '%D'].join(US) + RS
  const args = ['log', `--max-count=${limit}`, `--skip=${skip}`, `--format=${format}`]
  if (options.ref) args.push(assertRefName(options.ref, 'revision'))
  args.push('--')

  let raw = ''
  try {
    raw = await git(root, args, { timeoutMs: 20_000, maxBytes: 4 * 1024 * 1024 })
  } catch (error) {
    // An unborn HEAD (fresh `git init`) has no commits; that is not an error.
    if (error instanceof GitError && /does not have any commits|unknown revision|bad revision/i.test(error.message)) {
      return []
    }
    throw error
  }

  return raw.split(RS).filter((record) => record.trim() !== '').map((record) => {
    const [hash, short, author, date, subject, refs] = record.split(US)
    return {
      hash,
      short,
      author,
      date,
      subject,
      refs: (refs ?? '').split(',').map((value) => value.trim()).filter(Boolean),
    }
  })
}

/**
 * Read the linked worktree inventory.
 *
 * @param root - repo root.
 * @returns one row per worktree, with its branch and HEAD.
 */
export async function worktrees(root) {
  let raw = ''
  try {
    raw = await git(root, ['worktree', 'list', '--porcelain'], { timeoutMs: 10_000 })
  } catch {
    return []
  }
  const rows = []
  let row = {}
  for (const line of raw.split('\n')) {
    if (line === '') {
      if (row.path) rows.push(row)
      row = {}
      continue
    }
    const [key, ...rest] = line.split(' ')
    const value = rest.join(' ')
    if (key === 'worktree') row.path = value
    else if (key === 'HEAD') row.head = value
    else if (key === 'branch') row.branch = value.replace(/^refs\/heads\//, '')
    else if (key === 'detached') row.detached = true
    else if (key === 'bare') row.bare = true
    else if (key === 'locked') row.locked = value || true
    else if (key === 'prunable') row.prunable = value || true
  }
  if (row.path) rows.push(row)
  return rows
}

/**
 * Read the stash list.
 *
 * @param root - repo root.
 * @returns stashes newest-first.
 */
export async function stashes(root) {
  let raw = ''
  try {
    raw = await git(root, ['stash', 'list', `--format=%gd${US}%gs${US}%cI`], { timeoutMs: 10_000 })
  } catch {
    return []
  }
  return raw.split('\n').filter((line) => line !== '').map((line) => {
    const [ref, subject, date] = line.split(US)
    return { ref, subject, date }
  })
}

/**
 * Read one diff as unified text.
 *
 * Exactly one of `path` / `commit` selects the target: a working-tree path
 * (staged or not), or a commit against its first parent.
 *
 * @param root - repo root.
 * @param options - `path`, `staged`, `commit`, `context`.
 * @returns the diff body and whether git reported any difference.
 */
export async function diff(root, options = {}) {
  const context = Math.min(Math.max(Number(options.context) || 3, 0), 20)
  const args = ['--no-pager', 'diff', '--no-color', `-U${context}`]

  if (options.commit) {
    const commit = assertRefName(options.commit, 'commit')
    args.push(`${commit}^..${commit}`)
    let text
    try {
      text = await git(root, args, { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
    } catch {
      // Root commit: diff against the empty tree instead of its missing parent.
      const emptyTree = await git(root, ['hash-object', '-t', 'tree', '/dev/null'], { timeoutMs: 10_000 })
      text = await git(root, ['--no-pager', 'diff', '--no-color', `-U${context}`, emptyTree, commit],
        { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
    }
    return { text, empty: text.trim() === '' }
  }

  const path = options.path ? assertRepoPath(options.path) : undefined

  // An untracked file has no diff against the index, so compare it with the
  // empty tree instead. `--no-index` exits 1 when the files differ, which is
  // the normal case here and not a failure.
  if (options.untracked) {
    if (!path) throw new GitError('an untracked diff needs a path', { code: 'bad-argument' })
    const result = await runGit(root, [
      '--no-pager', 'diff', '--no-color', `-U${context}`, '--no-index', '--', '/dev/null', path,
    ], { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
    if (result.code !== 0 && result.code !== 1) {
      throw new GitError(result.stderr.trim().split('\n')[0] || `git diff exited ${result.code}`, {
        code: 'git-failed',
        command: result.argv,
        stderr: result.stderr,
      })
    }
    const text = result.stdout
    return { text, empty: text.trim() === '', untracked: true }
  }

  if (options.staged) args.push('--cached')
  args.push('--')
  if (path) args.push(path)
  else args.push('.')
  const text = await git(root, args, { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024 })
  return { text, empty: text.trim() === '' }
}

/**
 * Compose the summary the repository list renders: state, remotes, head commit.
 *
 * @param root - repo root.
 * @param options - `timeoutMs` for the read commands.
 * @returns one repository row; `error` replaces the git facts on failure.
 */
export async function summary(root, options = {}) {
  const row = { root, name: root.split(sep).filter(Boolean).pop() ?? root }
  try {
    const [state, remoteRows, head] = await Promise.all([
      status(root, options),
      remotes(root),
      git(root, ['log', '-1', `--format=%h${US}%s${US}%an${US}%aI${US}%D`], { timeoutMs: 10_000 })
        .catch(() => ''),
    ])
    row.branch = state.branch
    row.detached = state.detached
    row.upstream = state.upstream
    row.ahead = state.ahead
    row.behind = state.behind
    row.counts = state.counts
    row.clean = state.clean
    // Every listed repository carries its in-progress operation, because that is
    // what decides whether a bulk pull may touch it at all.
    row.operation = state.operation
    row.remotes = remoteRows
    if (head !== '') {
      const [short, subject, author, date, refs] = head.split(US)
      row.head = { short, subject, author, date, refs: (refs ?? '').split(',').map((v) => v.trim()).filter(Boolean) }
    }
  } catch (error) {
    row.error = error instanceof GitError ? error.message : String(error?.message ?? error)
  }
  return row
}

/* ── Mutations ────────────────────────────────────────────────────────────────
 * Each one performs exactly one intent. Destructive operations (discard, stash
 * drop) are the caller's responsibility to confirm with the user first.
 */

/**
 * Stage paths, or everything when none are named.
 *
 * @param root - repo root.
 * @param paths - repo-relative paths; empty means `git add -A`.
 * @returns git's own stdout.
 */
export async function stage(root, paths = []) {
  const args = ['add', '--']
  if (paths.length === 0) args.splice(1, 0, '-A')
  else for (const path of paths) args.push(assertRepoPath(path))
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Unstage paths, or the whole index when none are named.
 *
 * @param root - repo root.
 * @param paths - repo-relative paths.
 * @returns git's own stdout.
 */
export async function unstage(root, paths = []) {
  const args = ['restore', '--staged', '--']
  if (paths.length === 0) args.push('.')
  else for (const path of paths) args.push(assertRepoPath(path))
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Commit the index.
 *
 * @param root - repo root.
 * @param message - commit message; must be non-empty.
 * @param options - `amend` rewrites the previous commit.
 * @returns the short hash and subject of the new commit.
 */
export async function commit(root, message, options = {}) {
  const text = String(message ?? '').trim()
  if (text === '') throw new GitError('commit message is empty', { code: 'bad-argument' })
  const args = ['commit', '-m', text]
  if (options.amend) args.push('--amend')
  const raw = await git(root, args, { timeoutMs: 60_000 })
  const head = await git(root, ['log', '-1', `--format=%h${US}%s`], { timeoutMs: 10_000 })
  const [short, subject] = head.split(US)
  return { short, subject, output: raw }
}

/**
 * Switch to an existing local branch, or check one out from a remote branch.
 *
 * @param root - repo root.
 * @param branch - target branch name.
 * @param options - `create` makes a new branch from `startPoint`.
 * @returns git's own output.
 */
export async function checkout(root, branch, options = {}) {
  const name = assertRefName(branch, 'branch')
  const args = ['switch']
  if (options.create) {
    args.push('-c', name)
    if (options.startPoint) args.push(assertRefName(options.startPoint, 'start point'))
  } else {
    args.push(name)
  }
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Delete a local branch.
 *
 * @param root - repo root.
 * @param branch - branch to delete.
 * @param options - `force` maps to `-D`.
 * @returns git's own output.
 */
export async function deleteBranch(root, branch, options = {}) {
  const name = assertRefName(branch, 'branch')
  return git(root, ['branch', options.force ? '-D' : '-d', name], { timeoutMs: 30_000 })
}

/**
 * Fetch from a remote, pruning deleted branches.
 *
 * @param root - repo root.
 * @param remote - remote name, defaults to `origin`.
 * @param options - `timeoutMs` for the network call.
 * @returns git's own output.
 */
export async function fetch(root, remote = 'origin', options = {}) {
  const name = assertRefName(remote, 'remote')
  return git(root, ['fetch', '--prune', name], { timeoutMs: options.timeoutMs ?? 180_000 })
}

/**
 * Pull the current branch, fast-forward only unless `rebase` is set.
 *
 * @param root - repo root.
 * @param options - `rebase` and `timeoutMs`.
 * @returns git's own output.
 */
export async function pull(root, options = {}) {
  const args = ['pull', '--ff-only']
  if (options.rebase) args.splice(1, 1, '--rebase')
  return git(root, args, { timeoutMs: options.timeoutMs ?? 180_000 })
}

/**
 * Push the current branch, setting upstream on the first push.
 *
 * @param root - repo root.
 * @param options - `remote`, `branch`, `setUpstream`, `force`, `timeoutMs`.
 * @returns git's own output.
 */
export async function push(root, options = {}) {
  const args = ['push']
  if (options.setUpstream) args.push('--set-upstream')
  if (options.force) args.push('--force-with-lease')
  if (options.remote) args.push(assertRefName(options.remote, 'remote'))
  if (options.branch) args.push(assertRefName(options.branch, 'branch'))
  return git(root, args, { timeoutMs: options.timeoutMs ?? 180_000 })
}

/**
 * Discard working-tree changes for paths.
 *
 * Tracked paths are restored from the index; untracked paths are removed only
 * when `includeUntracked` is set, so a caller that forgets the flag deletes
 * nothing it did not mean to.
 *
 * @param root - repo root.
 * @param paths - repo-relative paths.
 * @param options - `staged` also resets the index; `includeUntracked` removes
 *   untracked files.
 * @returns git's own output.
 */
export async function discard(root, paths = [], options = {}) {
  if (paths.length === 0) throw new GitError('refusing to discard without an explicit path', { code: 'bad-argument' })
  const safe = paths.map((path) => assertRepoPath(path))
  const notes = []
  if (options.staged) {
    notes.push(await git(root, ['restore', '--staged', '--', ...safe], { timeoutMs: 60_000 }))
  }
  const tracked = safe.filter((path) => !(options.untracked ?? []).includes(path))
  if (tracked.length > 0) {
    notes.push(await git(root, ['restore', '--worktree', '--', ...tracked], { timeoutMs: 60_000 }))
  }
  if (options.includeUntracked) {
    const removable = (options.untracked ?? safe).map((path) => assertRepoPath(path))
    if (removable.length > 0) {
      notes.push(await git(root, ['clean', '-f', '--', ...removable], { timeoutMs: 60_000 }))
    }
  }
  return notes.join('\n')
}

/**
 * Push the working tree onto the stash stack.
 *
 * @param root - repo root.
 * @param options - `message`, `includeUntracked` (default true).
 * @returns git's own output.
 */
export async function stashPush(root, options = {}) {
  const args = ['stash', 'push']
  if (options.includeUntracked !== false) args.push('--include-untracked')
  if (options.message) args.push('-m', String(options.message))
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Pop or apply one stash entry.
 *
 * @param root - repo root.
 * @param options - `index` selects `stash@{n}`; `drop` pops without keeping it
 *   (default true drops after a successful apply).
 * @returns git's own output.
 */
export async function stashPop(root, options = {}) {
  const index = Number.isInteger(options.index) ? options.index : 0
  const args = ['stash', options.applyOnly ? 'apply' : 'pop', `stash@{${index}}`]
  return git(root, args, { timeoutMs: 60_000 })
}

/**
 * Drop one stash entry.
 *
 * @param root - repo root.
 * @param options - `index` selects `stash@{n}`.
 * @returns git's own output.
 */
export async function stashDrop(root, options = {}) {
  const index = Number.isInteger(options.index) ? options.index : 0
  return git(root, ['stash', 'drop', `stash@{${index}}`], { timeoutMs: 30_000 })
}

/**
 * Create a repository at a directory.
 *
 * @param dir - directory to initialize.
 * @param options - `initialBranch` names the first branch.
 * @returns git's own output.
 */
export async function init(dir, options = {}) {
  const args = ['init']
  if (options.initialBranch) args.push('-b', assertRefName(options.initialBranch, 'branch'))
  return git(dir, args, { timeoutMs: 30_000 })
}

/**
 * Add or replace a remote.
 *
 * @param root - repo root.
 * @param name - remote name.
 * @param url - remote URL (validated only for shape, never executed).
 * @returns a confirmation row.
 */
export async function setRemote(root, name, url) {
  const remote = assertRefName(name, 'remote')
  const target = String(url ?? '').trim()
  if (target === '' || /[\s]/.test(target)) throw new GitError('invalid remote URL', { code: 'bad-argument' })
  const existing = await remotes(root)
  if (existing.some((row) => row.name === remote)) {
    await git(root, ['remote', 'set-url', remote, target], { timeoutMs: 15_000 })
    return { name: remote, url: target, created: false }
  }
  await git(root, ['remote', 'add', remote, target], { timeoutMs: 15_000 })
  return { name: remote, url: target, created: true }
}

/**
 * Turn a `git remote -v` URL into its hosting coordinates.
 *
 * Handles `https://host/group/proj.git`, `ssh://git@host:2222/group/proj.git`,
 * `git@host:group/proj.git`, and a bare filesystem path.
 *
 * @param url - remote URL as git reports it.
 * @returns host, project path, and web base URL; `local` for filesystem paths.
 */
export function parseRemoteUrl(url) {
  const raw = String(url ?? '').trim()
  if (raw === '') return { local: true, raw }

  let host
  let pathname
  let scheme

  const scp = /^(?:([^@/]+)@)?([^:/]+):(?!\/)(.+)$/.exec(raw)
  if (scp && !raw.includes('://')) {
    host = scp[2]
    pathname = scp[3]
    scheme = 'ssh'
  } else if (raw.includes('://')) {
    try {
      const parsed = new URL(raw)
      host = parsed.hostname
      pathname = parsed.pathname
      scheme = parsed.protocol.replace(':', '')
    } catch {
      return { local: true, raw }
    }
  } else {
    return { local: true, raw }
  }

  const project = pathname.replace(/^\/+/, '').replace(/\.git$/, '')
  const [namespace, ...rest] = project.split('/')
  const webScheme = scheme === 'http' ? 'http' : 'https'
  return {
    raw,
    local: false,
    scheme,
    host,
    namespace: rest.length > 0 ? namespace : undefined,
    project,
    webBase: `${webScheme}://${host}`,
  }
}
