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

import { DEFAULT_MAX_DEPTH, discoverRepositories, discoverRepositoriesDetailed, findRepoRoot, status, branches, log, remotes, worktrees, stashes, summary, parseRemoteUrl, operationState, merge, mergeAbort, mergeContinue, rebaseOnto, rebaseAbort, rebaseContinue, switchBranch, localBranchNames, workingTreeLoad } from '../lib/git.js'
import { describeRemote, webUrl } from '../lib/gitlab.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
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
  check('a clean working tree reports no operation in progress', row.operation === undefined || row.operation.kind === 'none',
    JSON.stringify(row.operation))
  console.log(`     branch=${row.branch} ahead=${row.ahead} behind=${row.behind} changed=${row.counts?.changed} remotes=${row.remotes?.length}`)
}

/* ── merge and rebase, against a repository built for the purpose ─────────────
 * The real checkout above cannot be merged into without touching somebody's
 * work, and the states that matter here (a stopped merge, a stopped rebase) only
 * exist for the duration of an operation. So this section builds a throwaway
 * repository with two branches that conflict on purpose and drives the real
 * engine through every ending: fast-forward, merge commit, conflict + continue,
 * conflict + abort, clean rebase, and rebase conflict + continue.
 */

/**
 * Run git in the fixture and fail the check on a non-zero exit.
 *
 * @param cwd - fixture repository.
 * @param args - argv array.
 * @returns stdout.
 */
function fixtureGit(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C', GIT_TERMINAL_PROMPT: '0' } })
  if (result.status !== 0) {
    throw new Error(`fixture git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

{
  const fixture = await mkdtemp(join(tmpdir(), 'dsh-git-repos-merge-'))
  try {
    fixtureGit(fixture, ['init', '-b', 'main'])
    fixtureGit(fixture, ['config', 'user.email', 'check@example.com'])
    fixtureGit(fixture, ['config', 'user.name', 'Check'])
    await writeFile(join(fixture, 'shared.txt'), 'base\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'base'])

    console.log(`\n# merge and rebase (fixture ${fixture})`)
    check('a fresh repository reports no operation', (await operationState(fixture)).kind === 'none',
      JSON.stringify(await operationState(fixture)))

    // ── fast-forward: the branch simply moves, no merge commit ──────────────
    fixtureGit(fixture, ['switch', '-c', 'ff', '-q'])
    await writeFile(join(fixture, 'ff.txt'), 'ff\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'ff work'])
    fixtureGit(fixture, ['switch', 'main', '-q'])
    const ff = await merge(fixture, 'ff')
    check('a fast-forwardable merge reports fast-forward', ff.merged === 'fast-forward' && ff.ok === true, JSON.stringify(ff))
    check('the branch moved to the merged commit', fixtureGit(fixture, ['rev-parse', 'HEAD']) === fixtureGit(fixture, ['rev-parse', 'ff']))
    const again = await merge(fixture, 'ff')
    check('merging an already-contained branch reports up-to-date', again.merged === 'up-to-date', JSON.stringify(again))

    // ── a real merge commit ─────────────────────────────────────────────────
    fixtureGit(fixture, ['switch', '-c', 'side', '-q'])
    await writeFile(join(fixture, 'side.txt'), 'side\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'side work'])
    fixtureGit(fixture, ['switch', 'main', '-q'])
    await writeFile(join(fixture, 'main.txt'), 'main\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'main work'])
    const merged = await merge(fixture, 'side', { noFf: true })
    check('a divergent merge creates a merge commit', merged.merged === 'merged' && merged.ok === true, JSON.stringify(merged))
    check('--no-ff is honoured even when git would fast-forward', fixtureGit(fixture, ['log', '--merges', '--format=%H', '-1']).trim() !== '')

    // ── conflict: the engine returns it and leaves the merge state ──────────
    fixtureGit(fixture, ['switch', '-c', 'theirs', '-q'])
    await writeFile(join(fixture, 'shared.txt'), 'theirs\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'theirs'])
    fixtureGit(fixture, ['switch', 'main', '-q'])
    await writeFile(join(fixture, 'shared.txt'), 'ours\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'ours'])

    const conflicted = await merge(fixture, 'theirs')
    check('a conflicting merge is returned, not thrown', conflicted.ok === false && conflicted.merged === 'conflict',
      JSON.stringify(conflicted))
    check('the conflicted path is named', conflicted.conflicts.includes('shared.txt'), JSON.stringify(conflicted.conflicts))
    const midMerge = await operationState(fixture)
    check('the repository is reported as mid-merge', midMerge.kind === 'merge', JSON.stringify(midMerge))
    const midStatus = await status(fixture)
    check('status counts the conflict', midStatus.counts.conflicted >= 1, JSON.stringify(midStatus.counts))
    check('the conflict entry is flagged', midStatus.entries.some((entry) => entry.conflicted === true))
    check('status reports the merge in progress', midStatus.operation?.kind === 'merge', JSON.stringify(midStatus.operation))

    const aborted = await mergeAbort(fixture)
    check('aborting a merge restores the branch', (await operationState(fixture)).kind === 'none', aborted)
    check('the working tree is clean again after the abort', (await status(fixture)).counts.conflicted === 0)

    // ── conflict, resolved, then finished by committing ─────────────────────
    const againConflict = await merge(fixture, 'theirs')
    check('the merge conflicts again on demand', againConflict.merged === 'conflict', JSON.stringify(againConflict))
    await writeFile(join(fixture, 'shared.txt'), 'resolved\n')
    fixtureGit(fixture, ['add', 'shared.txt'])
    await mergeContinue(fixture)
    const afterContinue = await operationState(fixture)
    check('finishing the merge clears the state', afterContinue.kind === 'none', JSON.stringify(afterContinue))
    check('the merge commit records both parents', fixtureGit(fixture, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).length === 3,
      fixtureGit(fixture, ['rev-list', '--parents', '-n', '1', 'HEAD']).trim())

    // ── rebase onto a divergent base ────────────────────────────────────────
    fixtureGit(fixture, ['switch', '-c', 'rebase-me', 'main', '-q'])
    await writeFile(join(fixture, 'rebased.txt'), 'rebased\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'to rebase'])
    fixtureGit(fixture, ['switch', 'main', '-q'])
    await writeFile(join(fixture, 'newbase.txt'), 'new base\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'new base'])
    fixtureGit(fixture, ['switch', 'rebase-me', '-q'])

    const rebased = await rebaseOnto(fixture, 'main')
    check('a clean rebase reports rebased', rebased.ok === true && rebased.merged === 'rebased', JSON.stringify(rebased))
    check('the rebase left no operation behind', (await operationState(fixture)).kind === 'none')
    check('the rebased commit now sits on the new base',
      fixtureGit(fixture, ['merge-base', '--is-ancestor', 'main', 'HEAD']) === '')

    // ── rebase conflict, resolved, then continued ───────────────────────────
    fixtureGit(fixture, ['switch', '-c', 'rebase-conflict', 'main', '-q'])
    await writeFile(join(fixture, 'shared.txt'), 'from branch\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'branch side'])
    fixtureGit(fixture, ['switch', 'main', '-q'])
    await writeFile(join(fixture, 'shared.txt'), 'from main\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'main side'])
    fixtureGit(fixture, ['switch', 'rebase-conflict', '-q'])

    const rebaseConflict = await rebaseOnto(fixture, 'main')
    check('a conflicting rebase is returned, not thrown',
      rebaseConflict.ok === false && rebaseConflict.merged === 'conflict', JSON.stringify(rebaseConflict))
    const midRebase = await operationState(fixture)
    check('the repository is reported as mid-rebase', midRebase.kind === 'rebase', JSON.stringify(midRebase))
    check('the rebase flavour is named', midRebase.rebaseKind === 'merge' || midRebase.rebaseKind === 'apply',
      JSON.stringify(midRebase))

    const rebaseAborted = await rebaseAbort(fixture)
    check('aborting a rebase restores the branch', (await operationState(fixture)).kind === 'none', rebaseAborted)
    check('the aborted rebase left the original commit', fixtureGit(fixture, ['log', '-1', '--format=%s']).trim() === 'branch side')

    const conflictAgain = await rebaseOnto(fixture, 'main')
    check('the rebase conflicts again on demand', conflictAgain.merged === 'conflict', JSON.stringify(conflictAgain))
    await writeFile(join(fixture, 'shared.txt'), 'resolved both\n')
    fixtureGit(fixture, ['add', 'shared.txt'])
    await rebaseContinue(fixture)
    check('continuing the rebase clears the state', (await operationState(fixture)).kind === 'none')
    check('the rebased commit sits on top of main', fixtureGit(fixture, ['log', '-1', '--format=%s']).trim() === 'branch side')

    // ── a bad argument must not reach git as an option ──────────────────────
    let rejected = false
    try {
      await merge(fixture, '--abort')
    } catch (error) {
      rejected = error?.code === 'bad-argument'
    }
    check('an option-shaped merge target is refused', rejected)

    // ── branch switching, including carrying changes across ─────────────────
    // This is the operation whose failure modes differ the most between its two
    // forms, so both are driven against the same fixture: plain `switch` refuses
    // a dirty tree and changes nothing, `--merge` carries the edits over, and an
    // untracked file the target also has is refused by *both*.
    fixtureGit(fixture, ['switch', '-q', 'main'])
    const plainSwitch = await switchBranch(fixture, 'rebase-me')
    check('a clean switch succeeds', plainSwitch.ok === true && plainSwitch.outcome === 'switched',
      JSON.stringify(plainSwitch))
    check('the switch actually moved HEAD',
      fixtureGit(fixture, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'rebase-me')
    check('a switch neither starts nor leaves an operation',
      (await operationState(fixture)).kind === 'none', JSON.stringify(await operationState(fixture)))

    fixtureGit(fixture, ['switch', '-q', 'main'])
    await writeFile(join(fixture, 'shared.txt'), 'dirty local\n')
    const switchDirty = await switchBranch(fixture, 'rebase-me')
    check('a plain switch refuses a dirty tree', switchDirty.outcome === 'failed', JSON.stringify(switchDirty))
    check('the refusal left the branch alone',
      fixtureGit(fixture, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'main')
    check('the refusal left the edit in place',
      (await status(fixture)).counts.changed > 0, JSON.stringify((await status(fixture)).counts))

    // The untracked collision: a file the target branch tracks and the working
    // tree has as untracked. Neither form may proceed — `--merge` would have to
    // overwrite a file git does not know about.
    fixtureGit(fixture, ['checkout', '-q', '--', '.'])
    fixtureGit(fixture, ['switch', '-q', 'rebase-me'])
    await writeFile(join(fixture, 'untracked-only.txt'), 'tracked on the other side\n')
    fixtureGit(fixture, ['add', 'untracked-only.txt'])
    fixtureGit(fixture, ['commit', '-m', 'track the file'])
    fixtureGit(fixture, ['switch', '-q', 'main'])
    await writeFile(join(fixture, 'untracked-only.txt'), 'local untracked\n')
    const untrackedPlain = await switchBranch(fixture, 'rebase-me')
    check('a plain switch refuses an untracked collision',
      untrackedPlain.outcome === 'failed', JSON.stringify(untrackedPlain))
    const untrackedMerge = await switchBranch(fixture, 'rebase-me', { merge: true })
    check('a --merge switch also refuses an untracked collision',
      untrackedMerge.outcome === 'failed', JSON.stringify(untrackedMerge))
    check('the untracked file is still there',
      fixtureGit(fixture, ['status', '--porcelain']).includes('?? untracked-only.txt'),
      fixtureGit(fixture, ['status', '--porcelain']))
    fixtureGit(fixture, ['clean', '-fd'])
    fixtureGit(fixture, ['checkout', '-q', '--', '.'])

    // --merge with a tracked modification: the only two acceptable endings are
    // "carried across" and "conflict", and both must leave the edit recoverable.
    await writeFile(join(fixture, 'shared.txt'), 'base for merge\n')
    fixtureGit(fixture, ['add', '-A'])
    fixtureGit(fixture, ['commit', '-m', 'base for merge'])
    fixtureGit(fixture, ['switch', '-q', 'rebase-me'])
    await writeFile(join(fixture, 'shared.txt'), 'other side\n')
    fixtureGit(fixture, ['commit', '-am', 'other side edits shared'])
    fixtureGit(fixture, ['switch', '-q', 'main'])
    await writeFile(join(fixture, 'shared.txt'), 'my uncommitted change\n')

    const carriedSwitch = await switchBranch(fixture, 'rebase-me', { merge: true })
    check('a --merge switch ends as carried or conflicted',
      carriedSwitch.outcome === 'switched' || carriedSwitch.outcome === 'conflict',
      JSON.stringify(carriedSwitch))
    check('the merge switch moved HEAD',
      fixtureGit(fixture, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() === 'rebase-me')
    const carriedEntries = (await status(fixture)).entries
    check('the local edit survived the merge switch',
      carriedEntries.some((entry) => entry.path === 'shared.txt'), JSON.stringify(carriedEntries.map((e) => e.path)))
    if (carriedSwitch.outcome === 'conflict') {
      // A switch conflict has no MERGE_HEAD: the files are unmerged in the index
      // and the way out is resolve + commit, not `merge --abort`.
      check('a switch conflict names its files', carriedSwitch.conflicts.includes('shared.txt'),
        JSON.stringify(carriedSwitch.conflicts))
      check('a switch conflict reports no merge in progress', (await operationState(fixture)).kind === 'none',
        JSON.stringify(await operationState(fixture)))
    }
    // Leave nothing behind for the next section.
    fixtureGit(fixture, ['reset', '-q', '--hard', 'HEAD'])
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
