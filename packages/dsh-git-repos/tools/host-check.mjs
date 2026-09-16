#!/usr/bin/env node
/**
 * Host-route self-check for `dsh-git-repos`.
 *
 * Boots the plugin's `apply()` against a stand-in `ctx.webServer` and a real
 * `node:http` server, then drives the RPC surface over HTTP. This is the layer
 * the browser half actually talks to, so the guards (cross-site refusal,
 * containment) are asserted here rather than assumed.
 *
 *     node tools/host-check.mjs [root]
 */

import http from 'node:http'

import { apply as applyHost } from '../lib/index.js'

const root = process.argv[2] ?? process.cwd()
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

applyHost(ctx, { discover: { maxDepth: 3, limit: 20 } })

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

server.close()
console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
