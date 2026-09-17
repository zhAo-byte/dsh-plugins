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

  // ── bulk branch switch: pre-flight, refusal, and carrying changes across ───
  // The two behaviours that matter are both real here: a dirty repository
  // refuses a plain switch without changing anything, and the same repository
  // with `--merge` comes back holding conflict entries instead.
  const preflight = await call('repo.bulkLoad', { roots: [alice, bob], branch: 'feature' })
  check('bulkLoad answers per repository',
    preflight.status === 200 && preflight.body?.value?.results?.length === 2, JSON.stringify(preflight.body?.value))
  const byName = (rows, name) => (Array.isArray(rows) ? rows : []).find((row) => String(row.root).endsWith(`/${name}`))
  const bobRow = byName(preflight.body?.value?.results, 'bob')
  const aliceRow = byName(preflight.body?.value?.results, 'alice')
  check('bulkLoad reports the current branch', typeof aliceRow?.branch === 'string', JSON.stringify(aliceRow))
  check('bulkLoad reports the working-tree load', typeof bobRow?.load?.changed === 'number', JSON.stringify(bobRow))
  check('bulkLoad says whether the target branch exists', bobRow?.hasBranch === false, JSON.stringify(bobRow))

  // The branch exists locally in both clones once one of them creates it, and a
  // clean tree switches without ceremony.
  fixtureGit(alice, ['switch', '-c', 'feature', '-q'])
  await writeFile(join(alice, 'feature.txt'), 'feature\n')
  fixtureGit(alice, ['add', '-A'])
  fixtureGit(alice, ['commit', '-m', 'feature work'])
  fixtureGit(alice, ['push', '-u', 'origin', 'feature'])
  // A clone only fetches the remote's default branch, so `origin/feature` does
  // not exist until it is asked for.
  fixtureGit(bob, ['fetch', 'origin'])
  fixtureGit(bob, ['switch', '-qc', 'feature'])
  fixtureGit(bob, ['branch', '-u', 'origin/feature', 'feature'])
  const preflightKnown = await call('repo.bulkLoad', { roots: [alice], branch: 'feature' })
  check('bulkLoad finds an existing branch', preflightKnown.body?.value?.results?.[0]?.hasBranch === true,
    JSON.stringify(preflightKnown.body?.value?.results?.[0]))

  // An untracked file that the target branch also has: both forms of the switch
  // must refuse. This is the collision `--merge` cannot resolve, and the reason
  // the plain form is the default rather than an optimisation.
  fixtureGit(alice, ['switch', 'main', '-q'])
  await writeFile(join(alice, 'feature.txt'), 'untracked local file\n')
  const untrackedPlain = await call('repo.bulkSwitch', { roots: [alice], branch: 'feature' })
  check('a plain switch refuses an untracked collision',
    untrackedPlain.body?.value?.results?.[0]?.outcome === 'failed', JSON.stringify(untrackedPlain.body?.value))
  const untrackedMerge = await call('repo.bulkSwitch', { roots: [alice], branch: 'feature', merge: true })
  check('a --merge switch also refuses an untracked collision',
    untrackedMerge.body?.value?.results?.[0]?.outcome === 'failed', JSON.stringify(untrackedMerge.body?.value))
  check('the untracked file survived both refusals',
    fixtureGit(alice, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main'
    && fixtureGit(alice, ['status', '--porcelain']).includes('?? feature.txt'),
    fixtureGit(alice, ['status', '--porcelain']))
  fixtureGit(alice, ['clean', '-fd'])

  // A *fresh* repository for this pair, because every switch below leaves the
  // working tree in a different shape and reusing one fixture is how the earlier
  // operation's leftovers get mistaken for this one's result.
  const carol = join(fixture, 'carol')
  fixtureGit(fixture, ['init', '-q', '-b', 'main', carol])
  fixtureGit(carol, ['config', 'user.email', 'check@example.com'])
  fixtureGit(carol, ['config', 'user.name', 'Check'])
  await writeFile(join(carol, 'clash.txt'), 'base\n')
  await writeFile(join(carol, 'local-only.txt'), 'base\n')
  fixtureGit(carol, ['add', '-A'])
  fixtureGit(carol, ['commit', '-m', 'tracked base'])
  fixtureGit(carol, ['switch', '-qc', 'feature'])
  await writeFile(join(carol, 'clash.txt'), 'from feature\n')
  fixtureGit(carol, ['commit', '-qam', 'feature edits clash'])
  fixtureGit(carol, ['switch', '-q', 'main'])
  await writeFile(join(carol, 'clash.txt'), 'local uncommitted\n')
  await writeFile(join(carol, 'local-only.txt'), 'local only\n')

  const refused = await call('repo.bulkSwitch', { roots: [carol], branch: 'feature' })
  check('a plain bulk switch refuses a dirty repository',
    refused.body?.value?.results?.[0]?.outcome === 'failed', JSON.stringify(refused.body?.value))
  check('the refusal changed nothing',
    fixtureGit(alice, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main',
    fixtureGit(alice, ['rev-parse', '--abbrev-ref', 'HEAD']).trim())

  const carried = await call('repo.bulkSwitch', { roots: [carol], branch: 'feature', merge: true })
  const carriedRow = carried.body?.value?.results?.[0]
  // Both endings are legitimate here, and which one happens depends on how git's
  // three-way merge reads the two versions. What must never happen is losing the
  // local work, so that is what is asserted rather than one particular outcome.
  check('a --merge switch either carries the edits across or reports the conflict',
    carriedRow?.outcome === 'switched' || carriedRow?.outcome === 'conflict', JSON.stringify(carriedRow))
  check('the merge switch did move the branch',
    fixtureGit(carol, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'feature',
    fixtureGit(carol, ['rev-parse', '--abbrev-ref', 'HEAD']).trim())
  const carriedStatus = await call('repo.status', { root: carol })
  const carriedEntries = carriedStatus.body?.value?.entries ?? []
  check('the local work survived the switch',
    carriedEntries.some((entry) => entry.path === 'clash.txt')
    && carriedEntries.some((entry) => entry.path === 'local-only.txt'),
    JSON.stringify(carriedEntries.map((entry) => entry.path)))
  if (carriedRow?.outcome === 'conflict') {
    // A switch conflict is *not* a merge in progress: there is no MERGE_HEAD, so
    // `merge --abort` is meaningless and the panel must not offer it. The files
    // are simply unmerged in the index, to be resolved and committed.
    const carriedOp = await call('repo.operation', { root: carol })
    check('a carried switch conflict reports no merge in progress',
      carriedOp.body?.value?.operation?.kind === 'none', JSON.stringify(carriedOp.body?.value))
    check('the carried conflict shows up as a conflict entry',
      carriedStatus.body?.value?.counts?.conflicted >= 1, JSON.stringify(carriedStatus.body?.value?.counts))
    const abortMeaningless = await call('repo.mergeAbort', { root: carol })
    check('aborting is refused when there is no merge to abort', abortMeaningless.status === 409,
      `${abortMeaningless.status} ${JSON.stringify(abortMeaningless.body)}`)
  } else {
    check('a clean carry leaves no operation behind',
      carriedStatus.body?.value?.operation?.kind === 'none', JSON.stringify(carriedStatus.body?.value?.operation))
    check('a clean carry leaves no conflict entry',
      carriedStatus.body?.value?.counts?.conflicted === 0, JSON.stringify(carriedStatus.body?.value?.counts))
  }

  // A bulk switch to a branch that does not exist fails per repository without
  // taking the others down with it.
  const missing = await call('repo.bulkSwitch', { roots: [alice, bob], branch: 'no-such-branch' })
  check('a missing branch fails per repository',
    missing.body?.value?.results?.every((row) => row.ok !== true), JSON.stringify(missing.body?.value))
  check('the failure names the branch',
    String(missing.body?.value?.results?.[0]?.output ?? '').includes('no-such-branch')
    || String(missing.body?.value?.results?.[0]?.output ?? '').length > 0, JSON.stringify(missing.body?.value?.results?.[0]))

  // ── conflict resolution: read the three stages, resolve block by block ─────
  // The merge above was already abandoned, so this section starts from the
  // committed tree and builds its own conflict: the same file changed on both
  // sides, merged for real and left stopped.
  fixtureGit(bob, ['reset', '-q', '--hard', 'HEAD'])
  fixtureGit(bob, ['fetch', 'origin'])
  await writeFile(join(alice, 'file.txt'), 'alice conflict side\n')
  fixtureGit(alice, ['commit', '-am', 'alice conflict side'])
  fixtureGit(alice, ['push'])
  await writeFile(join(bob, 'file.txt'), 'bob conflict side\n')
  fixtureGit(bob, ['commit', '-am', 'bob conflict side'])
  fixtureGit(bob, ['fetch', 'origin'])
  const seeded = await call('repo.merge', { root: bob, target: 'origin/main' })
  check('the resolver fixture is actually conflicted', seeded.body?.value?.merged === 'conflict',
    JSON.stringify(seeded.body?.value))

  const detail = await call('repo.conflict', { root: bob, path: 'file.txt' })
  check('repo.conflict answers for a conflicted file',
    detail.status === 200 && Array.isArray(detail.body?.value?.blocks), JSON.stringify(detail.body).slice(0, 200))
  const detailValue = detail.body?.value ?? {}
  check('the conflict is parsed into one block', detailValue.blocks?.length === 1, JSON.stringify(detailValue.blocks))
  check('both sides are captured',
    detailValue.blocks?.[0]?.ours?.join('') === 'bob conflict side'
    && detailValue.blocks?.[0]?.theirs?.join('') === 'alice conflict side',
    JSON.stringify(detailValue.blocks?.[0]))
  check('all three stages exist for a modify/modify conflict',
    detailValue.stages?.base === true && detailValue.stages?.ours === true && detailValue.stages?.theirs === true,
    JSON.stringify(detailValue.stages))
  check('the working tree still has its markers', String(detailValue.text).includes('<<<<<<<'))

  // Per-block choice: take theirs, which must rewrite the file and clear the
  // conflict from the index.
  const blockId = detailValue.blocks[0].id

  // The guards run first, while the file is still conflicted: a save whose text
  // puts a marker back must be refused, and so must a save with no decision at
  // all. Writing a half-resolved file under a "resolved" label is how a conflict
  // marker ends up committed.
  const reintroduce = await call('repo.conflictSave', {
    root: bob, path: 'file.txt', choices: { [blockId]: '<<<<<<< oops\n=======\n>>>>>>> oops' },
  })
  check('a resolution that still contains a marker is refused', reintroduce.status === 409,
    `${reintroduce.status} ${JSON.stringify(reintroduce.body)}`)
  const partial = await call('repo.conflictSave', { root: bob, path: 'file.txt', choices: {} })
  check('a save with no decision is refused', partial.status === 409,
    `${partial.status} ${JSON.stringify(partial.body)}`)
  check('the refused saves left the conflict in place',
    (await call('repo.status', { root: bob })).body?.value?.counts?.conflicted === 1,
    JSON.stringify((await call('repo.status', { root: bob })).body?.value?.counts))

  const saved = await call('repo.conflictSave', {
    root: bob, path: 'file.txt', choices: { [blockId]: 'theirs' },
  })
  check('saving a resolution answers', saved.status === 200, JSON.stringify(saved.body).slice(0, 200))
  const resolved = fixtureGit(bob, ['show', ':0:file.txt'])
  check('the resolved file has no conflict markers', !resolved.includes('<<<<<<<'), JSON.stringify(resolved))
  check('the chosen side is the content', resolved.trim() === 'alice conflict side', JSON.stringify(resolved))
  const clearedAfter = await call('repo.operation', { root: bob })
  check('the file is no longer conflicted',
    (await call('repo.status', { root: bob })).body?.value?.counts?.conflicted === 0,
    JSON.stringify(clearedAfter.body?.value))

  // ── whole-file take, including the side that deleted the file ──────────────
  // Its own repository, because this case needs a specific history — the file
  // present at the merge base, deleted on one side and edited on the other — and
  // reusing the fixture above kept inheriting whatever the last section left
  // staged.
  const dave = join(fixture, 'dave')
  fixtureGit(fixture, ['init', '-q', '-b', 'main', dave])
  fixtureGit(dave, ['config', 'user.email', 'check@example.com'])
  fixtureGit(dave, ['config', 'user.name', 'Check'])
  await writeFile(join(dave, 'base.txt'), 'base\n')
  await writeFile(join(dave, 'shared-delete.txt'), 'shared base\n')
  fixtureGit(dave, ['add', '-A'])
  fixtureGit(dave, ['commit', '-m', 'base with the shared file'])
  fixtureGit(dave, ['switch', '-qc', 'victim-side'])
  fixtureGit(dave, ['rm', '-q', 'shared-delete.txt'])
  fixtureGit(dave, ['commit', '-m', 'side deletes it'])
  fixtureGit(dave, ['switch', '-q', 'main'])
  await writeFile(join(dave, 'shared-delete.txt'), 'main edits it meanwhile\n')
  fixtureGit(dave, ['commit', '-am', 'main edits the file'])

  const deleteConflict = await call('repo.merge', { root: dave, target: 'victim-side' })
  check('a delete/modify conflict is reported', deleteConflict.body?.value?.merged === 'conflict',
    JSON.stringify(deleteConflict.body?.value))
  const victimDetail = await call('repo.conflict', { root: dave, path: 'shared-delete.txt' })
  check('a delete/modify conflict has no theirs stage',
    victimDetail.body?.value?.stages?.theirs === false, JSON.stringify(victimDetail.body?.value?.stages))
  check('the missing side is named', victimDetail.body?.value?.deletedOn === 'theirs',
    JSON.stringify(victimDetail.body?.value?.deletedOn))
  check('the surviving side is still shown as content',
    String(victimDetail.body?.value?.text ?? '').includes('main edits it meanwhile'),
    JSON.stringify(victimDetail.body?.value?.text))
  const takeMissing = await call('repo.conflictTake', { root: dave, path: 'shared-delete.txt', side: 'theirs' })
  check('taking a side that deleted the file is refused without the delete flag',
    takeMissing.status === 409, `${takeMissing.status} ${JSON.stringify(takeMissing.body)}`)
  const takeDelete = await call('repo.conflictTake', {
    root: dave, path: 'shared-delete.txt', side: 'theirs', deleteMissing: true,
  })
  check('taking the deleting side removes the file', takeDelete.body?.value?.deleted === true,
    JSON.stringify(takeDelete.body?.value))
  check('the removed file is no longer conflicted',
    (await call('repo.status', { root: dave })).body?.value?.counts?.conflicted === 0,
    JSON.stringify((await call('repo.status', { root: dave })).body?.value?.counts))
  const badSide = await call('repo.conflictTake', { root: dave, path: 'base.txt', side: 'nonsense' })
  check('an unknown side is refused', badSide.status === 400, `${badSide.status} ${JSON.stringify(badSide.body)}`)
  fixtureGit(dave, ['merge', '--abort'])

  // Argument guards the route must enforce before git sees anything.
  const badAction = await call('repo.bulk', { roots: [bob], action: 'rebase-everything' })
  check('an unknown bulk action is refused', badAction.status === 400, `${badAction.status} ${JSON.stringify(badAction.body)}`)
  const noRoots = await call('repo.bulk', { roots: [], action: 'fetch' })
  check('a bulk action with no roots is refused', noRoots.status === 400, String(noRoots.status))
  const escapedRoot = await call('repo.bulk', { roots: ['/etc'], action: 'fetch' })
  check('a bulk root outside every allowed root is refused', escapedRoot.status === 403, String(escapedRoot.status))
  const switchNoBranch = await call('repo.bulkSwitch', { roots: [bob] })
  check('a bulk switch without a branch is refused', switchNoBranch.status === 400, String(switchNoBranch.status))
  const switchBadBranch = await call('repo.bulkSwitch', { roots: [bob], branch: '--force' })
  check('an option-shaped branch name is refused', switchBadBranch.status === 400, `${switchBadBranch.status} ${JSON.stringify(switchBadBranch.body)}`)
  const loadNoRoots = await call('repo.bulkLoad', { roots: [] })
  check('a pre-flight with no roots is refused', loadNoRoots.status === 400, String(loadNoRoots.status))
  const optionTarget = await call('repo.merge', { root: bob, target: '--abort' })
  check('an option-shaped merge target is refused', optionTarget.status === 409, `${optionTarget.status} ${JSON.stringify(optionTarget.body)}`)
} finally {
  await rm(fixture, { recursive: true, force: true })
}

server.close()
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
