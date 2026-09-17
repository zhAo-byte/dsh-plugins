#!/usr/bin/env node
/**
 * Host-route self-check for `dsh-git-repos`.
 *
 * Boots the plugin's `apply()` against a stand-in `ctx.webServer` and a real
 * `node:http` server, then drives the RPC surface over HTTP. This is the layer
 * the browser half actually talks to, so the guards (cross-site refusal,
 * containment) are asserted here rather than assumed.
 *
 *     node tools/host-check.mjs [root] [expectedRepos]
 *
 * `root` defaults to the current directory. Pass `expectedRepos` to run the
 * same assertions against a real workbench and require at least that many
 * repositories — the way to prove that nested checkouts are actually listed:
 *
 *     node tools/host-check.mjs ~/Desktop/602 23
 */

import http from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { apply as applyHost } from '../lib/index.js'
import { DEFAULT_MAX_DEPTH, DEFAULT_MAX_ENTRIES } from '../lib/git.js'

const root = process.argv[2] ?? process.cwd()
// Optional floor for `repos.list`, so this harness can be pointed at a real
// workbench and assert how many repositories the panel would show.
const expectedRepos = process.argv[3] === undefined ? undefined : Number(process.argv[3])
let failures = 0

/**
 * Assert a condition.
 *
 * @param label - what is checked.
 * @param condition - must hold.
 * @param detail - printed on failure.
 */
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

/** One captured route. */
const routes = []
const effects = []

const registry = {
  list() {
    return [{ id: 'w1', path: root, title: 'test workspace' }]
  },
}

const ctx = {
  webServer: {
    register(route) {
      routes.push(route)
      return () => {}
    },
  },
  // Mirrors Cordis' non-strict service lookup, which is how the plugin reads a
  // registry it does not require.
  get(name, strict = true) {
    if (name === 'workspaceRegistry') return registry
    if (strict) throw new Error(`cannot get property "${name}" without inject`)
    return undefined
  },
  effect(fn) {
    effects.push(fn)
    fn()
    return () => {}
  },
}

// A non-default budget proves the echo is the config and not a coincidence;
// pointed at a real workbench, the shipped defaults are what the panel will
// really use, so the repository count means something.
// The fixture root has to exist (and be registered) before `apply()` runs: the
// containment guard reads the root set when the method table is built, so a
// directory created afterwards would be refused for reasons that look like a bug
// in the guard but are really an ordering mistake in this harness.
const fixtureRoot = await mkdtemp(resolve(tmpdir(), 'dsh-git-repos-host-'))
const pluginConfig = expectedRepos === undefined
  ? { discover: { maxDepth: 3, limit: 20 }, extraRoots: [fixtureRoot] }
  : { extraRoots: [fixtureRoot] }
applyHost(ctx, pluginConfig)

console.log('\n# registration')
check('one prefix route registered', routes.length === 1, JSON.stringify(routes.map((r) => r.path)))
check('route kind is prefix', routes[0]?.kind === 'prefix')
check('route path is the plugin prefix', routes[0]?.path === '/dsh-git-repos/api')
check('route is owned by an effect', effects.length === 1)

const server = http.createServer((req, res) => {
  const route = routes.find((row) => req.url.startsWith(row.path))
  if (!route) {
    res.writeHead(404).end()
    return
  }
  void route.handler(req, res)
})

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const base = `http://127.0.0.1:${server.address().port}/dsh-git-repos/api/`

/**
 * Call one RPC method with full control over the request shape.
 *
 * @param method - method name.
 * @param payload - JSON body.
 * @param options - `headers`, `raw`.
 * @returns `{ status, body }`.
 */
async function call(method, payload, options = {}) {
  const response = await fetch(base + method, {
    method: options.httpMethod ?? 'POST',
    headers: {
      'content-type': 'application/json',
      ...(options.headers ?? {}),
    },
    body: options.httpMethod === 'GET' ? undefined : (options.raw ?? JSON.stringify(payload ?? {})),
  })
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    body = text
  }
  return { status: response.status, body }
}

console.log('\n# health')
const health = await call('health', {}, { httpMethod: 'GET' })
check('GET health answers 200', health.status === 200, String(health.status))
check('health names the plugin', health.body?.value?.plugin === 'dsh-git-repos')
check('health lists the allowed root', (health.body?.value?.roots ?? []).includes(root), JSON.stringify(health.body?.value?.roots))
check('health reports the token state', typeof health.body?.value?.gitlab?.tokenConfigured === 'boolean')

console.log('\n# repository listing')
const listing = await call('repos.list', { root })
check('repos.list answers 200', listing.status === 200, JSON.stringify(listing.body).slice(0, 200))
const repos = listing.body?.value?.repos ?? []
check('found repositories', repos.length > 0, String(repos.length))
const first = repos[0]
check('each row carries a root and a name', typeof first?.root === 'string' && typeof first?.name === 'string')
check('each row carries change counts', typeof first?.counts?.changed === 'number')
check('remotes are classified', Array.isArray(first?.remotes)
  && first.remotes.every((remote) => ['gitlab', 'local', 'other'].includes(remote.hosting)),
  JSON.stringify(first?.remotes?.map((r) => r.hosting)))
// The panel reads `discovery` to explain a short list, so the envelope and the
// config that produced it must survive the route, not just the engine.
const discovery = listing.body?.value?.discovery
check('listing carries the discovery envelope',
  discovery && typeof discovery.visited === 'number'
  && typeof discovery.depthLimited === 'boolean' && typeof discovery.entryLimited === 'boolean',
  JSON.stringify(discovery))
check('discovery echoes the configured budgets',
  discovery?.maxDepth === (expectedRepos === undefined ? 3 : DEFAULT_MAX_DEPTH)
  && discovery?.maxEntries === DEFAULT_MAX_ENTRIES, JSON.stringify(discovery))
// `single` means the root was handed back without a walk (fewer than one row
// would be wrong; more would mean the fallback overrode the walk).
check('the envelope is consistent with the rows it describes',
  discovery?.single === true ? repos.length === 1 : repos.length >= 1, JSON.stringify(discovery))
if (expectedRepos !== undefined) {
  check(`listing reaches every repository (>= ${expectedRepos})`,
    repos.length >= expectedRepos, `found ${repos.length}`)
  check('the rows carry repo-relative paths',
    repos.every((row) => typeof row.relPath === 'string'), JSON.stringify(repos.map((row) => row.relPath)))
}

console.log('\n# repository detail')
const target = first?.root ?? root
const state = await call('repo.status', { root: target })
check('repo.status answers 200', state.status === 200, JSON.stringify(state.body).slice(0, 200))
check('status has counts', typeof state.body?.value?.counts?.changed === 'number')
const branchRows = await call('repo.branches', { root: target })
check('branches split local and remote', Array.isArray(branchRows.body?.value?.local) && Array.isArray(branchRows.body?.value?.remote))
const history = await call('repo.log', { root: target, limit: 3 })
check('log honours the limit', (history.body?.value?.commits ?? []).length <= 3)
const remoteRows = await call('repo.remotes', { root: target })
check('remotes list answers', Array.isArray(remoteRows.body?.value?.remotes))
const stashRows = await call('repo.stashes', { root: target })
check('stashes list answers', Array.isArray(stashRows.body?.value?.stashes))
const worktreeRows = await call('repo.worktrees', { root: target })
check('worktrees list answers', Array.isArray(worktreeRows.body?.value?.worktrees))

console.log('\n# gitlab description (no network)')
const described = await call('gitlab.describe', { url: 'git@gitlab.com:group/sub/proj.git' })
check('gitlab.describe answers 200', described.status === 200)
check('gitlab classified', described.body?.value?.described?.gitlab === true)
check('project parsed', described.body?.value?.described?.project === 'group/sub/proj')
check('links built', typeof described.body?.value?.links?.repository === 'string')
const mrWithoutToken = await call('gitlab.mrs', { host: 'gitlab.com', project: 'a/b' })
check('mrs without a token degrades to data, not an error', mrWithoutToken.status === 200
  && mrWithoutToken.body?.value?.ok === false, JSON.stringify(mrWithoutToken.body).slice(0, 160))

console.log('\n# guards')
const crossSite = await call('repos.list', { root }, { headers: { 'sec-fetch-site': 'cross-site' } })
check('cross-site requests are refused', crossSite.status === 403, `${crossSite.status} ${JSON.stringify(crossSite.body)}`)

const evilOrigin = await call('repos.list', { root }, { headers: { origin: 'https://evil.example.com' } })
check('non-loopback origins are refused', evilOrigin.status === 403, String(evilOrigin.status))

const loopbackOrigin = await call('repos.list', { root }, { headers: { origin: 'http://127.0.0.1:63968' } })
check('loopback origins pass', loopbackOrigin.status === 200, String(loopbackOrigin.status))

const formPost = await call('repos.list', { root }, { headers: { 'content-type': 'application/x-www-form-urlencoded' } })
check('non-JSON content types are refused', formPost.status === 403, String(formPost.status))

const escapes = await call('repos.list', { root: '/etc' })
check('paths outside every root are refused', escapes.status === 403, `${escapes.status} ${JSON.stringify(escapes.body)}`)

const traversal = await call('repo.status', { root: `${root}/../../etc` })
check('traversal spellings are refused', traversal.status === 403 || traversal.status === 409, String(traversal.status))

const unknown = await call('nope.nope', {})
check('unknown methods answer 404', unknown.status === 404, String(unknown.status))

const missingRoot = await call('repo.status', {})
check('a missing root is a 400', missingRoot.status === 400, String(missingRoot.status))

const badJson = await call('repos.list', undefined, { raw: '{not json' })
check('malformed JSON is a 400', badJson.status === 400, String(badJson.status))

const badPath = await call('repo.diff', { root: target, path: '../escape.txt' })
check('repo-relative escapes are rejected', badPath.status === 409, `${badPath.status} ${JSON.stringify(badPath.body)}`)

const getWrite = await call('repo.stage', {}, { httpMethod: 'GET' })
check('GET is refused for non-health methods', getWrite.status === 405, String(getWrite.status))

/* ── bulk operations and merge, over the real route ───────────────────────────
 * The engine has its own fixture in `check.mjs`; this section exists because the
 * *route* is where a bulk action's payload shape and its per-repository outcomes
 * are decided, and because `pull`/`push` cannot be exercised against the working
 * checkout this harness points at. Two clones of a local bare remote need no
 * network and still produce a real divergence, a real fast-forward, and a real
 * conflict.
 */

/**
 * Run git inside the fixture and fail the check on a non-zero exit.
 *
 * @param cwd - fixture directory.
 * @param args - argv array.
 * @returns stdout.
 */
function fixtureGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0) throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  return result.stdout
}

console.log('\n# bulk operations and merge')
const fixture = fixtureRoot
try {
  const origin = join(fixture, 'origin.git')
  const alice = join(fixture, 'alice')
  const bob = join(fixture, 'bob')
  fixtureGit(fixture, ['init', '--bare', '-b', 'main', origin])
  // alice is built locally and pushes first: a clone of an empty repository
  // cannot check out a branch that does not exist yet, so the remote has to be
  // seeded before bob exists at all.
  fixtureGit(fixture, ['init', '-b', 'main', alice])
  fixtureGit(alice, ['config', 'user.email', 'check@example.com'])
  fixtureGit(alice, ['config', 'user.name', 'Check'])
  fixtureGit(alice, ['remote', 'add', 'origin', origin])
  await writeFile(join(alice, 'file.txt'), 'one\n')
  fixtureGit(alice, ['add', '-A'])
  fixtureGit(alice, ['commit', '-m', 'first'])
  fixtureGit(alice, ['push', '-u', 'origin', 'main'])
  fixtureGit(fixture, ['clone', origin, bob])
  fixtureGit(bob, ['config', 'user.email', 'check@example.com'])
  fixtureGit(bob, ['config', 'user.name', 'Check'])

  // A clean tree reports no operation; the fixture has no conflict yet.
  const opClean = await call('repo.operation', { root: bob })
  check('repo.operation answers for a clean tree', opClean.status === 200 && opClean.body?.value?.operation?.kind === 'none',
    JSON.stringify(opClean.body?.value))

  // alice moves ahead, so bob's pull fast-forwards.
  await writeFile(join(alice, 'file.txt'), 'two\n')
  fixtureGit(alice, ['commit', '-am', 'second'])
  fixtureGit(alice, ['push'])
  const bulkFetch = await call('repo.bulk', { roots: [bob], action: 'fetch' })
  check('bulk fetch answers per repository', bulkFetch.status === 200 && bulkFetch.body?.value?.results?.[0]?.outcome === 'fetched',
    JSON.stringify(bulkFetch.body?.value))
  const bulkPull = await call('repo.bulk', { roots: [bob], action: 'pull' })
  check('bulk pull reports a per-repository outcome', bulkPull.body?.value?.results?.[0]?.outcome === 'pulled',
    JSON.stringify(bulkPull.body?.value))
  check('bulk pull actually moved the branch', fixtureGit(bob, ['log', '-1', '--format=%s']).trim() === 'second')

  // bob commits, so his push has something to send.
  await writeFile(join(bob, 'bob.txt'), 'bob\n')
  fixtureGit(bob, ['add', '-A'])
  fixtureGit(bob, ['commit', '-m', 'from bob'])
  const bulkPush = await call('repo.bulk', { roots: [bob], action: 'push' })
  check('bulk push reports a per-repository outcome', bulkPush.body?.value?.results?.[0]?.outcome === 'pushed',
    JSON.stringify(bulkPush.body?.value))
  check('bulk push reached the remote', fixtureGit(origin, ['log', '-1', '--format=%s', 'main']).trim() === 'from bob')

  // A divergence that `--ff-only` cannot reconcile is a named outcome, not a
  // raw git message: this is the case a bulk pull is most likely to hit.
  // alice syncs first so that the *only* divergence is the one being tested.
  fixtureGit(alice, ['pull', '--ff-only'])
  await writeFile(join(alice, 'file.txt'), 'alice again\n')
  fixtureGit(alice, ['commit', '-am', 'alice again'])
  fixtureGit(alice, ['push'])
  await writeFile(join(bob, 'other.txt'), 'bob again\n')
  fixtureGit(bob, ['add', '-A'])
  fixtureGit(bob, ['commit', '-m', 'bob again'])
  const diverged = await call('repo.bulk', { roots: [bob], action: 'pull' })
  check('a diverged bulk pull is named, not a bare failure',
    diverged.body?.value?.results?.[0]?.outcome === 'diverged', JSON.stringify(diverged.body?.value))
  check('a diverged pull leaves no half-merge behind', (await call('repo.operation', { root: bob })).body?.value?.operation?.kind === 'none')

  // A merge that stops on a conflict: reported as an outcome, the repository
  // stays in the merge state, and the route exposes the way out.
  fixtureGit(bob, ['fetch', 'origin'])
  await writeFile(join(alice, 'file.txt'), 'alice wins\n')
  fixtureGit(alice, ['commit', '-am', 'alice wins'])
  fixtureGit(alice, ['push'])
  await writeFile(join(bob, 'file.txt'), 'bob wins\n')
  fixtureGit(bob, ['commit', '-am', 'bob wins'])
  fixtureGit(bob, ['fetch', 'origin'])
  const conflict = await call('repo.merge', { root: bob, target: 'origin/main' })
  check('a conflicting merge answers with its conflicts',
    conflict.status === 200 && conflict.body?.value?.merged === 'conflict'
    && conflict.body.value.conflicts.includes('file.txt'), JSON.stringify(conflict.body?.value))
  const midMergeOp = await call('repo.operation', { root: bob })
  check('the route reports the merge in progress', midMergeOp.body?.value?.operation?.kind === 'merge',
    JSON.stringify(midMergeOp.body?.value))
  const abortRoute = await call('repo.mergeAbort', { root: bob })
  check('the merge can be abandoned over the route', abortRoute.status === 200, JSON.stringify(abortRoute.body).slice(0, 160))
  check('the abort cleared the merge state', (await call('repo.operation', { root: bob })).body?.value?.operation?.kind === 'none')

  // Argument guards the route must enforce before git sees anything.
  const badAction = await call('repo.bulk', { roots: [bob], action: 'rebase-everything' })
  check('an unknown bulk action is refused', badAction.status === 400, `${badAction.status} ${JSON.stringify(badAction.body)}`)
  const noRoots = await call('repo.bulk', { roots: [], action: 'fetch' })
  check('a bulk action with no roots is refused', noRoots.status === 400, String(noRoots.status))
  const escapedRoot = await call('repo.bulk', { roots: ['/etc'], action: 'fetch' })
  check('a bulk root outside every allowed root is refused', escapedRoot.status === 403, String(escapedRoot.status))
  const optionTarget = await call('repo.merge', { root: bob, target: '--abort' })
  check('an option-shaped merge target is refused', optionTarget.status === 409, `${optionTarget.status} ${JSON.stringify(optionTarget.body)}`)
} finally {
  await rm(fixture, { recursive: true, force: true })
}

server.close()
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
