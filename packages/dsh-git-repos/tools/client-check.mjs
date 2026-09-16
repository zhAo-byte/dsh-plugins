#!/usr/bin/env node
/**
 * Client-bundle self-check for `dsh-git-repos`.
 *
 * The browser half has no bundler and no test runner, so this harness supplies
 * both halves of its contract by hand: a `window.__ModuleLoader__` that captures
 * the factory, a minimal React-compatible hook runtime, and a fake `fetch`.
 * It then asserts the activation path (three registrations) and exercises the
 * pure render helpers against synthetic git data.
 *
 *     node tools/client-check.mjs
 */

import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const source = await readFile(join(here, '..', 'lib', 'client.js'), 'utf8')

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

/** A tiny React stand-in: element objects plus a hook runtime with state. */
function createReact() {
  let cursor = 0
  let cells = []
  const react = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat(Infinity).filter((c) => c !== null && c !== undefined) }
    },
    useState(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = typeof initial === 'function' ? initial() : initial
      return [cells[index], (next) => { cells[index] = typeof next === 'function' ? next(cells[index]) : next }]
    },
    useEffect() { cursor += 1 },
    useCallback(fn) { cursor += 1; return fn },
    useRef(initial) {
      const index = cursor++
      if (!(index in cells)) cells[index] = { current: initial }
      return cells[index]
    },
  }
  return {
    react,
    reset() { cursor = 0 },
    /** Force one state cell, so a later render sees loaded data. */
    seed(index, value) { cells[index] = value },
    /** Re-run a component with the same cells, as a real re-render would. */
    rerender(component, props) { cursor = 0; return component(props) },
  }
}

/**
 * Run the bundle in this realm with the browser globals it touches injected.
 *
 * `new Function` is deliberate: the bundle is a browser script, not a Node
 * module, so Node's module-format detection must not see it.
 */
function loadBundle(globals) {
  const names = Object.keys(globals)
  // eslint-disable-next-line no-new-func
  const run = new Function(...names, source)
  run(...names.map((name) => globals[name]))
}

const hooks = createReact()

/** The captured bundle factory result. */
let bundle

const browserWindow = {
  __ModuleLoader__: {
    load(entry) {
      bundle = entry
    },
  },
  localStorage: {
    store: new Map(),
    getItem(key) { return this.store.has(key) ? this.store.get(key) : null },
    setItem(key, value) { this.store.set(key, String(value)) },
  },
  setInterval: () => 1,
  clearInterval: () => {},
  confirm: () => false,
}

const documentStub = {
  head: { appendChild() {} },
  createElement: () => ({ dataset: {}, style: {}, textContent: '' }),
  querySelector: () => null,
}

console.log('\n# bundle shape')
loadBundle({
  window: browserWindow,
  document: documentStub,
  localStorage: browserWindow.localStorage,
  fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, value: {} }) }),
  setInterval: () => 1,
  clearInterval: () => {},
})
check('bundle registers under the package name', bundle?.id === 'dsh-git-repos', String(bundle?.id))

const moduleExports = bundle.factory((request) => {
  if (request === 'react') return hooks.react
  throw new Error(`unexpected module request: ${request}`)
})
check('exports apply', typeof moduleExports.apply === 'function')
check('exports inject', Array.isArray(moduleExports.inject) && moduleExports.inject.includes('slots')
  && moduleExports.inject.includes('sidebarRightTabs'), JSON.stringify(moduleExports.inject))
check('exports the body component', typeof moduleExports.GitReposBody === 'function')
check('tab id namespaced', String(moduleExports.TAB_ID).startsWith('dsh-git-repos:'), moduleExports.TAB_ID)

console.log('\n# activation')
const registrations = { tabs: [], slots: [], effects: 0 }
const ctx = {
  sidebarRightTabs: { register: (definition) => { registrations.tabs.push(definition); return () => {} } },
  slots: {
    inject: (_name, factory) => { factory(); return () => {} },
    register: (seat, component) => { registrations.slots.push({ seat: seat?.name, component }); return () => {} },
  },
  effect: (fn) => { registrations.effects += 1; fn(); return () => {} },
}
moduleExports.apply(ctx)

check('registered one tab type', registrations.tabs.length === 1, JSON.stringify(registrations.tabs.map((t) => t.kind)))
const tab = registrations.tabs[0]
check('tab kind is git-repos', tab?.kind === 'git-repos')
check('tab is an extension registration', tab?.priority === 'extension')
check('tab contributes a guide entry', Array.isArray(tab?.guide) && tab.guide.length === 1)
check('title resolves', typeof tab?.title === 'function' && tab.title() === 'Git 仓库')
check('registered two slot seats', registrations.slots.length === 2,
  JSON.stringify(registrations.slots.map((s) => s.seat)))
check('seats are the pane tab and its title',
  registrations.slots.map((s) => s.seat).sort().join(',') === 'sidebar.right.pane.tab,sidebar.right.pane.tab.title')
check('every registration is owned by an effect', registrations.effects === 3, String(registrations.effects))

console.log('\n# first render (no session, no data)')
const useSessions = (selector) => selector({ byId: {} })
hooks.reset()
let tree
try {
  tree = moduleExports.GitReposBody({ sessionId: 's1', useSessions, useTabInfo: () => ({ tab: { visible: true, actions: {} } }) })
  check('body renders without throwing', tree?.type === 'div' && tree.props.className === 'gr-root')
} catch (error) {
  check('body renders without throwing', false, error?.message ?? String(error))
}
check('body shows the empty state before any data', JSON.stringify(tree).includes('没有可管理的仓库')
  || JSON.stringify(tree).includes('等待会话工作目录'))

console.log('\n# helpers')
const { asArray, unpackDetail, statusLetter, splitPath, diffLineClass, renderChanges, renderDiff, gitlabUrl, pipelineStyle, formatDate } = moduleExports.internals

check('asArray accepts arrays', asArray([1, 2]).length === 2)
check('asArray rejects objects', asArray({ remotes: [] }).length === 0)
check('asArray rejects undefined', asArray(undefined).length === 0)

// The host envelopes every list; a mismatch here already shipped once as a
// render crash (`object.find is not a function`), so the exact envelopes from
// `lib/index.js` are asserted to normalize into arrays.
const unpacked = unpackDetail({
  status: { branch: 'main', counts: { changed: 1 } },
  branches: { current: 'main', local: [{ name: 'main' }], remote: [] },
  history: { commits: [{ short: 'abc', subject: 'x', refs: [] }] },
  remotes: { remotes: [{ name: 'origin', described: { gitlab: true } }] },
  worktrees: { worktrees: [{ path: '/tmp/x', branch: 'main' }] },
  stashes: { stashes: [{ ref: 'stash@{0}', subject: 'wip' }] },
})
check('unpackDetail keeps the status object', unpacked.detail.status.branch === 'main')
check('unpackDetail unwraps remotes', Array.isArray(unpacked.detail.remotes) && unpacked.detail.remotes.length === 1)
check('unpackDetail unwraps worktrees', Array.isArray(unpacked.detail.worktrees) && unpacked.detail.worktrees.length === 1)
check('unpackDetail unwraps stashes', Array.isArray(unpacked.detail.stashes) && unpacked.detail.stashes.length === 1)
check('unpackDetail unwraps commits', Array.isArray(unpacked.commits) && unpacked.commits.length === 1)
check('unpackDetail keeps branches', unpacked.detail.branches.local.length === 1)
const emptyUnpack = unpackDetail(undefined)
check('unpackDetail tolerates a total failure',
  emptyUnpack.detail.remotes.length === 0 && emptyUnpack.commits.length === 0
  && emptyUnpack.detail.branches.local.length === 0)

check('untracked maps to U', statusLetter({ untracked: true }).letter === 'U')
check('conflict maps to C', statusLetter({ conflicted: true }).letter === 'C')
check('staged add maps to A', statusLetter({ staged: true, index: 'A', worktree: '.' }).letter === 'A')
check('staged delete maps to D', statusLetter({ staged: true, index: 'D', worktree: '.' }).letter === 'D')
check('rename maps to R', statusLetter({ renamed: true, index: 'R', worktree: '.' }).letter === 'R')
check('modified maps to M', statusLetter({ staged: true, index: 'M', worktree: '.' }).letter === 'M')

check('path split keeps the trailing slash on the dir', splitPath('a/b/c.ts').dir === 'a/b/'
  && splitPath('a/b/c.ts').base === 'c.ts')
check('root-level file has an empty dir', splitPath('c.ts').dir === '')

check('hunk lines classified', diffLineClass('@@ -1,2 +1,3 @@') === 'gr-line--hunk')
check('added lines classified', diffLineClass('+hello') === 'gr-line--add')
check('removed lines classified', diffLineClass('-hello') === 'gr-line--del')
check('file headers classified', diffLineClass('diff --git a/x b/x') === 'gr-line--file')
check('context lines unclassified', diffLineClass(' hello') === '')

console.log('\n# change list')
const status = {
  entries: [
    { path: 'src/a.ts', index: 'M', worktree: '.', staged: true, unstaged: false, untracked: false, conflicted: false, renamed: false, deleted: false },
    { path: 'src/b.ts', index: '.', worktree: 'M', staged: false, unstaged: true, untracked: false, conflicted: false, renamed: false, deleted: false },
    { path: 'new.ts', index: '?', worktree: '?', staged: false, unstaged: false, untracked: true, conflicted: false, renamed: false, deleted: false },
    { path: 'conflict.ts', index: 'U', worktree: 'U', staged: false, unstaged: true, untracked: false, conflicted: true, renamed: false, deleted: false },
  ],
}
const noop = () => {}
const children = renderChanges({ status, busy: false, activePath: 'src/b.ts', onOpen: noop, onStage: noop, onUnstage: noop, onDiscard: noop })
const flat = JSON.stringify(children)
check('change list renders a row per file', (flat.match(/gr-file"/g) ?? []).length === 4, String((flat.match(/gr-file"/g) ?? []).length))
check('conflicts get their own group', flat.includes('冲突 (1)'))
check('staged get their own group', flat.includes('已暂存 (1)'))
check('unstaged group counts tracked changes', flat.includes('未暂存 (2)'))
check('clean tree shows the empty message', JSON.stringify(renderChanges({
  status: { entries: [] }, busy: false, onOpen: noop, onStage: noop, onUnstage: noop, onDiscard: noop,
})).includes('工作区是干净的'))

console.log('\n# diff rendering')
const diffSample = 'diff --git a/x b/x\nindex 1..2 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new\n'
const diffNodes = renderDiff(diffSample)
// Seven content lines plus the empty line after the trailing newline.
check('one node per diff line', diffNodes.length === 8, String(diffNodes.length))
check('the added line is coloured', diffNodes.some((node) => node.props.className.includes('gr-line--add')))
check('the removed line is coloured', diffNodes.some((node) => node.props.className.includes('gr-line--del')))
check('huge diffs are capped', renderDiff(Array.from({ length: 5000 }, () => 'x').join('\n')).length === 4001)

console.log('\n# GitLab links')
const remote = { webBase: 'https://gitlab.com', project: 'group/proj', host: 'gitlab.com' }
check('repository link', gitlabUrl(remote, 'repository') === 'https://gitlab.com/group/proj')
check('branch link escapes the ref',
  gitlabUrl(remote, 'tree', 'feature/x') === 'https://gitlab.com/group/proj/-/tree/feature%2Fx',
  gitlabUrl(remote, 'tree', 'feature/x'))
check('new MR link carries the source branch',
  gitlabUrl(remote, 'new-merge-request', 'feature/x').includes('merge_request%5Bsource_branch%5D=feature%2Fx'))
check('missing project yields no link', gitlabUrl({}, 'tree', 'main') === undefined)
check('pipeline colours by status', pipelineStyle('failed').color.includes('error'))
check('date formats', formatDate('2026-09-16T08:30:00.000Z').startsWith('2026-09-16'))

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
