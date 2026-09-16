#!/usr/bin/env node
/**
 * `runner-check` — the Harness-facing half of a remote turn.
 *
 * `RemoteRunner` is the only file that calls into the Harness API, and it is the
 * file where a mistake would be expensive: a wrong permission call means a
 * remote question quietly ran with more authority than configured, and a wrong
 * workspace call means a relay could name a directory the operator never
 * offered. So this check drives the real runner against a *fake* Harness whose
 * only job is to record what the runner asked for.
 *
 * The fake is deliberately a recorder rather than a simulator. It cannot prove
 * that `ctx.agents.create` behaves as documented — only a real backend can, and
 * `live-check` is where that happens. What it proves is the runner's side of the
 * bargain: which services it calls, in what order, with what arguments, and what
 * it does when they fail.
 *
 * @module dsh-remote-control/tools/runner-check
 */

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')

// Point the runner's profile-root resolution at this package's own
// `node_modules`, which is how an installed plugin resolves its peers.
process.env.DSH_REMOTE_CONTROL_PROFILE_DIR ??= PACKAGE_ROOT

let failures = 0
let checks = 0

/**
 * Record one assertion.
 *
 * @param {string} what - what is being asserted.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - extra context on failure.
 */
function check(what, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`  \u2713 ${what}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  \u2717 ${what}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/**
 * A session stand-in that records the events a real turn would commit.
 *
 * `summarizeTurn` only reads `seq` and `eventAt`, so this is enough surface to
 * exercise reply extraction without a model request.
 */
class FakeSession {
  /**
   * @param {string} id - session identity.
   */
  constructor(id) {
    this.id = id
    /** @type {Array<object>} */
    this.events = []
  }

  /** @returns {number} current log length. */
  get seq() {
    return this.events.length
  }

  /**
   * @param {number} index - position.
   * @returns {object|undefined} the event.
   */
  eventAt(index) {
    return this.events[index]
  }

  /**
   * Append one assistant message and close the turn.
   *
   * @param {string} text - assistant text.
   * @param {object} [reason] - turn outcome; defaults to completed.
   */
  commitReply(text, reason = { kind: 'completed' }) {
    this.events.push({ type: 'turn/start', data: {} })
    this.events.push({
      type: 'assistant/message',
      data: { message: { content: text === '' ? [] : [{ type: 'text', text }] } }
    })
    this.events.push({ type: 'turn/end', data: { reason } })
  }
}

/**
 * An AgentHandle stand-in that answers the next question when asked.
 *
 * The canned reply is set by the test, so a failure path and a success path use
 * exactly the same plumbing.
 */
class FakeHandle {
  /**
   * @param {string} sessionId - session identity.
   * @param {object} ledger - shared recorder.
   */
  constructor(sessionId, ledger) {
    this.session = new FakeSession(sessionId)
    this.ledger = ledger
    this.disposed = false
    /** Next reply to commit: `{ text, reason }`, or `{ silent: true }` for no events. */
    this.next = { text: 'answer' }
    this.agent = {
      session: this.session,
      whenIdle: () => Promise.resolve(),
      followup: (message) => {
        this.ledger.followups.push({ sessionId, message })
        if (this.next.silent === true) return
        this.session.commitReply(this.next.text ?? '', this.next.reason)
      }
    }
  }

  /** @returns {Promise<void>} resolves immediately. */
  dispose() {
    this.disposed = true
    return Promise.resolve()
  }
}

/**
 * Build a fake Harness context that records every call the runner makes.
 *
 * @param {object} [options] - `{ permissionThrows? }`.
 * @returns {object} `{ ctx, ledger }`.
 */
function fakeHarness(options = {}) {
  const ledger = {
    creates: [],
    resolvedPresets: [],
    mountedPresets: [],
    standingKeys: [],
    workspacesCreated: [],
    attached: [],
    detached: [],
    permissions: [],
    titles: [],
    flushed: [],
    followups: [],
    disposed: []
  }
  const handles = new Map()
  const ctx = {
    agentDefaultModel: {
      currentSelection: () => ({ provider: 'deepseek-official', model: 'deepseek-flash' })
    },
    agentPresets: {
      resolve: (id) => {
        ledger.resolvedPresets.push(id)
        return Promise.resolve({ id })
      },
      standingKeyFor: (id) => {
        ledger.standingKeys.push(id)
        return Promise.resolve(`standing:${id}`)
      },
      mount: (agentCtx, id) => {
        ledger.mountedPresets.push({ agentCtx, id })
        return Promise.resolve()
      }
    },
    workspaceRegistry: {
      create: (path) => {
        ledger.workspacesCreated.push(path)
        return Promise.resolve({
          path,
          attachSession: (id) => {
            ledger.attached.push({ path, id })
            return Promise.resolve()
          },
          detachSession: (id) => {
            ledger.detached.push({ path, id })
            return Promise.resolve()
          }
        })
      }
    },
    permissionPresets: {
      set: (session, preset) => {
        if (options.permissionThrows === true) throw new Error('unknown permission preset')
        ledger.permissions.push({ sessionId: session.id, preset })
      }
    },
    agents: {
      create: (request) => {
        ledger.creates.push(request)
        const handle = new FakeHandle(request.sessionId, ledger)
        handles.set(request.sessionId, handle)
        // Real creation composes the agent before publishing it, so the setup
        // callback must have run by the time create() resolves.
        return Promise.resolve(request.setup({ name: 'agent-scope' })).then(() => handle)
      }
    },
    sessionTitle: {
      rename: (session, title) => {
        ledger.titles.push({ sessionId: session.id, title })
      }
    },
    sessions: {
      flush: (session) => {
        ledger.flushed.push(session.id)
        return Promise.resolve()
      }
    },
    get: (name) => (name === 'sessions' ? ctx.sessions : undefined)
  }
  return { ctx, ledger, handles }
}

/**
 * Build a runner over a fake Harness.
 *
 * @param {object} [overrides] - config overrides.
 * @param {object} [harnessOptions] - fake Harness options.
 * @returns {Promise<{ runner: object, ledger: object, handles: Map<string, object>, warnings: string[] }>} the wired runner.
 */
async function makeRunner(overrides = {}, harnessOptions = {}) {
  const { RemoteRunner } = await import('../lib/runner.js')
  const { ctx, ledger, handles } = fakeHarness(harnessOptions)
  const warnings = []
  const config = {
    nodeId: 'node-test',
    workspaces: [{ name: 'proj', path: '/workspace/proj' }],
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    ...overrides
  }
  const runner = new RemoteRunner({ ctx, config, logger: { warn: (line) => warnings.push(line) } })
  return { runner, ledger, handles, warnings }
}

const command = (overrides = {}) => ({
  commandId: 'cmd-1',
  workspace: '/workspace/proj',
  prompt: 'what changed today?',
  ...overrides
})

// This check drives the real runner, and the runner's reply extraction calls into
// the Harness (`createUserMessage`, `SessionSeq`). The Harness facade below is
// fake, but those value helpers are not — so this file needs a real Harness
// installation to be reachable, exactly like `live-check` does.
//
// That requirement used to be implicit. It held on a developer machine because
// the `node_modules/@deepseek-ai` symlink made the packages visible, and it broke
// the moment the same command ran anywhere else. So it is now stated: absent a
// Harness the check reports a skip, and `npm test` no longer depends on it.
{
  const reachable = await (async () => {
    const { probePackageResolution } = await import('../lib/runner.js')
    try {
      await probePackageResolution()
      return true
    } catch {
      return false
    }
  })()
  if (!reachable) {
    process.stdout.write('runner-check\n')
    process.stdout.write('  \u25CB no Harness installation reachable; skipping.\n')
    process.stdout.write('     This check needs @deepseek-ai/* on disk, because the runner calls into it.\n')
    process.stdout.write('     Install the plugin into a profile (or link the packages) and run `npm run test:harness`.\n')
    process.stdout.write('runner-check: skipped\n')
    process.exit(0)
  }
}

try {
  process.stdout.write('runner-check\n')

  // ── Harness package resolution ───────────────────────────────────────────
  // This is the failure that has no other symptom: a plugin loaded by absolute
  // path cannot see `@deepseek-ai/*` through Node's own lookup, so if the root
  // walk is wrong the node connects, accepts a question, and then fails every
  // turn with the same MODULE_NOT_FOUND. The check resolves it in a *subprocess*
  // with the override unset, so it exercises the ancestor walk a real install
  // depends on rather than an environment variable set in this file.
  {
    const probe = spawn(
      process.execPath,
      [
        '-e',
        `import(${JSON.stringify(join(PACKAGE_ROOT, 'lib', 'runner.js'))})` +
          `.then((m) => m.probePackageResolution())` +
          `.then((r) => { console.log(r.llm); process.exit(0) })` +
          `.catch((e) => { console.error(e.message); process.exit(3) })`
      ],
      { env: { ...process.env, DSH_REMOTE_CONTROL_PROFILE_DIR: '' } }
    )
    let out = ''
    let err = ''
    probe.stdout.setEncoding('utf8')
    probe.stdout.on('data', (chunk) => {
      out += chunk
    })
    probe.stderr.setEncoding('utf8')
    probe.stderr.on('data', (chunk) => {
      err += chunk
    })
    const code = await new Promise((resolve) => probe.once('exit', resolve))
    check('the Harness packages resolve without an override', code === 0, err.trim().slice(0, 300))
    check('resolution finds the real @deepseek-ai/dsh-llm', out.includes('dsh-llm'), out.trim())
  }

  // ── the advertised allow-list ────────────────────────────────────────────
  {
    const { runner } = await makeRunner()
    check('the node advertises exactly its configured workspaces', JSON.stringify(runner.workspaces()) === JSON.stringify([{ name: 'proj', path: '/workspace/proj' }]))
    check('an advertised workspace resolves', runner.resolveWorkspace('/workspace/proj') === '/workspace/proj')
    let refused
    try {
      runner.resolveWorkspace('/etc')
    } catch (error) {
      refused = error
    }
    check(
      'an unadvertised workspace is refused',
      refused instanceof Error && refused.message.includes('not advertised'),
      refused?.message
    )
    check('the refusal lists what is available', String(refused?.message).includes('/workspace/proj'))
  }

  // ── registry mode: the advertised set is read live, not frozen at startup ─
  // This is what makes "new workspace, no backend restart" true. If the provider
  // were consulted once, a directory created after boot would be rejected forever,
  // and the relay page would keep showing a stale list with nothing explaining why.
  {
    const { RemoteRunner } = await import('../lib/runner.js')
    const { ctx } = fakeHarness()
    const live = [{ name: 'one', path: '/workspace/one' }]
    const runner = new RemoteRunner({
      ctx,
      config: { nodeId: 'n', workspaces: [], agentPreset: 'standard', permissionPreset: 'workspace-write' },
      logger: {},
      workspaceProvider: () => live
    })
    check('registry mode advertises what the provider returns', runner.workspaces()[0]?.path === '/workspace/one')
    check('registry mode accepts a path the provider offers', runner.resolveWorkspace('/workspace/one') === '/workspace/one')

    // A workspace created after the node started, with no reconfiguration.
    live.push({ name: 'two', path: '/workspace/two' })
    check(
      'a workspace added at runtime is advertised without a restart',
      runner.workspaces().some((entry) => entry.path === '/workspace/two')
    )
    check(
      'a workspace added at runtime is accepted without a restart',
      runner.resolveWorkspace('/workspace/two') === '/workspace/two'
    )

    // And one that goes away stops being offered, so the advertised list cannot
    // drift from what the node would actually accept.
    live.splice(live.findIndex((entry) => entry.path === '/workspace/one'), 1)
    check('a removed workspace stops being advertised', !runner.workspaces().some((e) => e.path === '/workspace/one'))
    let refused
    try {
      runner.resolveWorkspace('/workspace/one')
    } catch (error) {
      refused = error
    }
    check('a removed workspace is refused', refused instanceof Error && refused.message.includes('not advertised'))
    check(
      'the refusal lists the current set, not the startup one',
      String(refused?.message).includes('/workspace/two') && !String(refused?.message).includes('/workspace/one,')
    )
  }

  // ── a first turn ─────────────────────────────────────────────────────────
  {
    const { runner, ledger } = await makeRunner()
    const result = await runner.run(command())
    check('the first question succeeds', result.ok === true, JSON.stringify(result))
    check('the answer is the committed assistant text', result.text === 'answer')
    check('the result echoes the prompt', result.prompt === 'what changed today?')
    check('the result carries the workspace', result.workspace === '/workspace/proj')
    check('the result carries a duration', typeof result.durationMs === 'number' && result.durationMs >= 0)
    check('a session id comes back for follow-ups', /^remote-/.test(String(result.sessionId)), String(result.sessionId))
    check('the agent preset is resolved by id', ledger.resolvedPresets[0] === 'standard')
    check('a standing key is taken for the preset', ledger.standingKeys[0] === 'standard')
    check('the workspace is created through the registry', ledger.workspacesCreated[0] === '/workspace/proj')
    check('the session is attached to the workspace', ledger.attached.length === 1)
    check('the agent is created with the workspace as cwd', ledger.creates[0]?.meta?.cwd === '/workspace/proj')
    check('the session records the agent preset', ledger.creates[0]?.meta?.agentPreset === 'standard')
    // A route on the created Agent is what makes the preset persona's
    // `{{model}}` resolvable, so a relay-only session's first turn can assemble
    // a prompt at all.
    check(
      'the agent is created with the deployment default route',
      ledger.creates[0]?.agentOptions?.provider === 'deepseek-official' &&
        ledger.creates[0]?.agentOptions?.model === 'deepseek-flash',
      JSON.stringify(ledger.creates[0]?.agentOptions)
    )
    check('the preset is mounted on the agent scope before publication', ledger.mountedPresets[0]?.id === 'standard')
    check(
      'the configured permission preset is pinned onto the session',
      ledger.permissions[0]?.preset === 'workspace-write',
      JSON.stringify(ledger.permissions)
    )
    check('the session is titled from the question', ledger.titles[0]?.title === 'what changed today?', JSON.stringify(ledger.titles))
    check('the session is flushed before the reply is read', ledger.flushed.length === 1)
    check('the prompt is admitted as a user message', ledger.followups[0]?.message?.source?.kind === 'user')
    check(
      'the prompt text reaches the agent unchanged',
      ledger.followups[0]?.message?.content?.[0]?.text === 'what changed today?'
    )
  }

  // ── a follow-up continues the same session ───────────────────────────────
  {
    const { runner, ledger, handles } = await makeRunner()
    const first = await runner.run(command())
    const handle = handles.get(first.sessionId)
    handle.next = { text: 'the second answer' }
    const second = await runner.run(command({ commandId: 'cmd-2', prompt: 'and then?', sessionId: first.sessionId }))
    check('a follow-up reuses the same session id', second.sessionId === first.sessionId)
    check('a follow-up does not create a second agent', ledger.creates.length === 1, `${String(ledger.creates.length)} creates`)
    check('a follow-up does not re-resolve the preset', ledger.resolvedPresets.length === 1)
    check('a follow-up does not re-attach the workspace', ledger.attached.length === 1)
    check('a follow-up returns the new answer', second.text === 'the second answer')
    check('a follow-up admits the new prompt', ledger.followups[1]?.message?.content?.[0]?.text === 'and then?')
    check('a follow-up re-flushes', ledger.flushed.length === 2)
  }

  // ── an unknown session id must start over, not silently reuse ────────────
  {
    const { runner, ledger } = await makeRunner()
    const result = await runner.run(command({ sessionId: 'remote-somebody-elses' }))
    check('an unknown session id starts a fresh session', result.ok === true && ledger.creates.length === 1)
    check('the fresh session gets its own id', result.sessionId !== 'remote-somebody-elses')
  }

  // ── a session cannot be dragged into another workspace ───────────────────
  // A DSH session is created inside one working directory and cannot be moved, so
  // a `sessionId` that arrives alongside a different workspace has to start a
  // fresh conversation. Continuing the old session instead would run the
  // question in the wrong directory and still report success — a failure with no
  // symptom to notice. The page keys its sessions by target for the same reason,
  // and this is the check that keeps the runner honest if a different client
  // gets it wrong.
  {
    const { runner, ledger } = await makeRunner({
      workspaces: [
        { name: 'proj', path: '/workspace/proj' },
        { name: 'notes', path: '/workspace/notes' }
      ]
    })
    const first = await runner.run(command())
    const second = await runner.run(
      command({ commandId: 'cmd-2', workspace: '/workspace/notes', prompt: 'and the notes?', sessionId: first.sessionId })
    )
    check('a session id from another workspace starts a fresh session', second.ok === true && ledger.creates.length === 2)
    check('the fresh session does not reuse the other workspace id', second.sessionId !== first.sessionId)
    check('the fresh session is created in the requested workspace', ledger.creates[1]?.meta?.cwd === '/workspace/notes')
  }

  // ── refusal paths ────────────────────────────────────────────────────────
  {
    const { runner, ledger } = await makeRunner()
    const result = await runner.run(command({ workspace: '/etc' }))
    check('a command for an unadvertised workspace fails', result.ok === false)
    check('no agent is created for a refused workspace', ledger.creates.length === 0)
    check('the error explains the refusal', String(result.error).includes('not advertised'))
  }
  {
    const { runner } = await makeRunner()
    const result = await runner.run(command({ prompt: '   ' }))
    check('an empty prompt fails', result.ok === false && String(result.error).includes('empty'))
  }
  {
    const { runner } = await makeRunner()
    const result = await runner.run(command({ prompt: undefined }))
    check('a missing prompt fails rather than running an empty turn', result.ok === false)
  }

  // ── a failed turn must not look like a successful one ────────────────────
  {
    const { runner, handles } = await makeRunner()
    const promise = runner.run(command())
    // The turn's reply is configured before `followup` runs, so hook the first
    // create to install the failure.
    const created = await promise
    check('a completed turn has no error field', created.error === undefined)
    const handle = handles.get(created.sessionId)
    handle.next = { text: '', reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter for route' } } }
    const failed = await runner.run(command({ commandId: 'cmd-err', prompt: 'again', sessionId: created.sessionId }))
    check('an error turn is reported as a failure', failed.ok === false, JSON.stringify(failed))
    check('the failure carries the adapter code', String(failed.error).includes('NO_ADAPTER'), failed.error)
    check('the failure carries the adapter message', String(failed.error).includes('no adapter for route'))
  }
  {
    const { runner, handles } = await makeRunner()
    const first = await runner.run(command())
    handles.get(first.sessionId).next = {
      text: 'partial answer',
      reason: { kind: 'error', error: { code: 'CANCELLED', message: 'stopped' } }
    }
    const failed = await runner.run(command({ commandId: 'cmd-partial', prompt: 'x', sessionId: first.sessionId }))
    check('a cancelled turn still surfaces the delivered text', String(failed.error).includes('partial answer'), failed.error)
  }
  {
    // Drive the no-outcome branch directly: a session that never commits.
    const { RemoteRunner } = await import('../lib/runner.js')
    const { ctx, ledger } = fakeHarness()
    const silent = new RemoteRunner({
      ctx,
      config: { nodeId: 'n', workspaces: [{ name: 'p', path: '/workspace/proj' }], agentPreset: 'standard', permissionPreset: 'workspace-write' },
      logger: {}
    })
    const originalCreate = ctx.agents.create
    ctx.agents.create = async (request) => {
      const handle = await originalCreate(request)
      handle.next = { silent: true }
      handle.agent.followup = () => {
        ledger.followups.push({ silent: true })
      }
      return handle
    }
    const result = await silent.run(command())
    check('a turn with no recorded outcome fails', result.ok === false, JSON.stringify(result))
    check('the no-outcome error says so', String(result.error).includes('without recording'), result.error)
  }

  // ── permission pinning must be fatal when it fails ───────────────────────
  {
    const { runner, ledger } = await makeRunner({}, { permissionThrows: true })
    const result = await runner.run(command())
    check('a permission-preset failure fails the turn', result.ok === false, JSON.stringify(result))
    check('the permission failure is not swallowed', String(result.error).includes('unknown permission preset'))
    check('the failed session is detached from the workspace', ledger.detached.length === 1)
    check('no prompt is admitted after a permission failure', ledger.followups.length === 0)
  }

  // ── disposal ─────────────────────────────────────────────────────────────
  {
    const { runner, handles } = await makeRunner()
    const first = await runner.run(command())
    await runner.dispose()
    check('dispose disposes the sessions it created', handles.get(first.sessionId)?.disposed === true)
    check('dispose empties the session table', runner.sessions.size === 0)
  }

  process.stdout.write(`\nrunner-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nrunner-check: harness error — ${error?.stack ?? error}\n`)
}

if (failures > 0) process.exitCode = 1
