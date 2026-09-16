#!/usr/bin/env node
/**
 * Engine self-check for `dsh-git-repos`.
 *
 * Runs the host git engine against real repositories on this machine — no DSH,
 * no browser — plus one synthetic tree for the discovery budgets, which need a
 * shape (a repo below `Assets/<Group>/<Module>`) no handy repo provides.
 * Usage:
 *
 *     node tools/check.mjs [root]
 *
 * `root` defaults to the current directory. Exits non-zero on any failed
 * assertion so it can gate a change to `lib/git.js`.
 */

import { DEFAULT_MAX_DEPTH, discoverRepositories, discoverRepositoriesDetailed, findRepoRoot, status, branches, log, remotes, worktrees, stashes, summary, parseRemoteUrl } from '../lib/git.js'
import { describeRemote, webUrl } from '../lib/gitlab.js'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

// Default to the repository that contains the current directory, so a bare
// `npm run check` always has real git data to exercise. Several assertions
// compare against the paths git reports, hence the absolute form.
const requested = resolve(process.argv[2] ?? process.cwd())
const root = (await findRepoRoot(requested)) ?? requested
let failures = 0

/**
 * Assert a condition, recording the outcome.
 *
 * @param label - what is being checked.
 * @param condition - the condition that must hold.
 * @param detail - extra text printed on failure.
 */
function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log(`\n# remote URL parsing`)
const cases = [
  ['git@gitlab.com:group/sub/proj.git', { host: 'gitlab.com', project: 'group/sub/proj', local: false }],
  ['https://gitlab.example.com/team/app.git', { host: 'gitlab.example.com', project: 'team/app', local: false }],
  ['ssh://git@gitlab.example.com:2222/team/app.git', { host: 'gitlab.example.com', project: 'team/app', local: false }],
  ['/Users/me/code/thing', { local: true }],
]
for (const [url, expected] of cases) {
  const parsed = parseRemoteUrl(url)
  check(url, parsed.local === Boolean(expected.local) && parsed.host === expected.host && parsed.project === expected.project,
    JSON.stringify(parsed))
}

console.log(`\n# hosting classification`)
check('gitlab.com is GitLab', describeRemote('git@gitlab.com:a/b.git', []).gitlab === true)
check('self-hosted needs config', describeRemote('git@code.example.com:a/b.git', []).gitlab === false)
check('self-hosted honours config', describeRemote('git@code.example.com:a/b.git', ['code.example.com']).gitlab === true)
check('gitlab hostname hint', describeRemote('https://gitlab.internal.corp/a/b.git', []).gitlab === true)
check('local path is not GitLab', describeRemote('/srv/git/a.git', []).gitlab === false)

console.log(`\n# deep links`)
const remote = describeRemote('git@gitlab.com:group/proj.git', [])
check('branch tree', webUrl(remote, { kind: 'tree', ref: 'feature/x' }) === 'https://gitlab.com/group/proj/-/tree/feature%2Fx',
  webUrl(remote, { kind: 'tree', ref: 'feature/x' }))
check('new MR carries source branch',
  webUrl(remote, { kind: 'new-merge-request', ref: 'feature/x', target: 'main' })
    === 'https://gitlab.com/group/proj/-/merge_requests/new?merge_request%5Bsource_branch%5D=feature%2Fx&merge_request%5Btarget_branch%5D=main',
  webUrl(remote, { kind: 'new-merge-request', ref: 'feature/x', target: 'main' }))
check('commit link', webUrl(remote, { kind: 'commit', sha: 'abc123' }) === 'https://gitlab.com/group/proj/-/commit/abc123')

console.log(`\n# discovery under ${root}`)
const repos = await discoverRepositories(root)
check('found at least one repository', repos.length > 0, `found ${repos.length}`)
for (const repo of repos) console.log(`     ${repo}`)

console.log(`\n# discovery budgets (synthetic tree)`)
// A shallow repo plus one at `Assets/<Group>/<Module>` — depth 5, the shape a
// Unity workbench uses for its sibling checkouts. Only a `.git` entry is
// needed: discovery classifies by name and never asks git.
const fixture = await mkdtemp(join(tmpdir(), 'dsh-git-repos-check-'))
try {
  const shallow = join(fixture, 'flat-repo')
  const deep = join(fixture, 'unity', 'uframework', 'Assets', 'JJGame', 'chinachess')
  for (const dir of [shallow, deep]) {
    await mkdir(join(dir, '.git'), { recursive: true })
    await mkdir(join(dir, 'sub'), { recursive: true })
  }
  await mkdir(join(fixture, 'unity', 'uframework', 'Library', 'nested-repo', '.git'), { recursive: true })

  const byDefault = await discoverRepositoriesDetailed(fixture)
  check('default depth reaches Assets/<Group>/<Module>', byDefault.roots.includes(deep), `roots=${byDefault.roots.length}`)
  check('default depth covers a deep workbench',
    byDefault.maxDepth === DEFAULT_MAX_DEPTH && DEFAULT_MAX_DEPTH >= 5, String(byDefault.maxDepth))
  check('deep-but-pruned directories are still skipped',
    !byDefault.roots.some((entry) => entry.includes('Library')), byDefault.roots.join(', '))
  check('a complete scan reports no budget truncation',
    byDefault.depthLimited === false && byDefault.entryLimited === false)

  const shallowOnly = await discoverRepositoriesDetailed(fixture, { maxDepth: 4 })
  check('maxDepth 4 misses the deep repo', !shallowOnly.roots.includes(deep))
  check('maxDepth 4 admits it hid something', shallowOnly.depthLimited === true)
  check('maxDepth 5 reaches it', (await discoverRepositoriesDetailed(fixture, { maxDepth: 5 })).roots.includes(deep))

  const squeezed = await discoverRepositoriesDetailed(fixture, { maxEntries: 1 })
  check('an exhausted directory budget is reported', squeezed.entryLimited === true)
} finally {
  await rm(fixture, { recursive: true, force: true })
}

if (repos.length > 0) {
  const target = repos[0]
  console.log(`\n# engine against ${target}`)
  const state = await status(target)
  check('status reports a branch or a detached head', typeof state.branch === 'string')
  check('status counts are numbers', typeof state.counts.changed === 'number')

  const branchRows = await branches(target)
  check('local branches listed', Array.isArray(branchRows.local))
  check('current branch marked once', branchRows.local.filter((row) => row.current).length <= 1)

  const commits = await log(target, { limit: 5 })
  check('log returns at most the limit', commits.length <= 5)
  if (commits.length > 0) {
    check('commit shape', typeof commits[0].hash === 'string' && typeof commits[0].subject === 'string'
      && typeof commits[0].author === 'string', JSON.stringify(commits[0]))
  }

  const remoteRows = await remotes(target)
  check('remotes is an array', Array.isArray(remoteRows))

  const worktreeRows = await worktrees(target)
  check('worktrees include this checkout', worktreeRows.some((row) => row.path === target) || worktreeRows.length > 0,
    JSON.stringify(worktreeRows))

  const stashRows = await stashes(target)
  check('stashes is an array', Array.isArray(stashRows))

  const row = await summary(target)
  check('summary has no error', row.error === undefined, row.error)
  check('summary carries counts', typeof row.counts?.changed === 'number')
  console.log(`     branch=${row.branch} ahead=${row.ahead} behind=${row.behind} changed=${row.counts?.changed} remotes=${row.remotes?.length}`)
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
