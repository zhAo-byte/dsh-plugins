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
 * exercise reply extraction without a model request. The admitted prompt is
 * recorded too, because that identity is how a reply is attributed to the right
 * question once a session is shared with the local GUI.
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
   * Append one admitted prompt, one reply, and close the turn.
   *
   * @param {string} text - assistant text.
   * @param {object} [reason] - turn outcome; defaults to completed.
   * @param {object} [message] - the admitted user message, when there was one.
   */
  commitReply(text, reason = { kind: 'completed' }, message) {
    if (message !== undefined) this.events.push({ type: 'user/message', data: message })
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
 * exactly the same plumbing. `whenIdle` waits for the reply being produced, which
 * is what makes a held turn (`next.gate`) look like a turn that is still running
 * — the property the runner's serialization and its shared-agent path depend on.
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
    /** Next reply to commit: `{ text, reason, gate }`, or `{ silent: true }` for no events. */
    this.next = { text: 'answer' }
    /** Resolves when the turn currently being produced has been committed. */
    this.reply = Promise.resolve()
    this.agent = {
      session: this.session,
      whenIdle: () => this.reply,
      followup: (message) => {
        this.ledger.followups.push({ sessionId, message })
        if (this.next.silent === true) {
          this.reply = Promise.resolve()
          return
        }
        const gate = this.next.gate
        this.reply = (gate === undefined ? Promise.resolve() : gate).then(() => {
          this.session.commitReply(this.next.text ?? '', this.next.reason, message)
        })
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
    resumes: [],
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
    observed: [],
    disposed: []
  }
  const handles = new Map()
  /** Durable header facts per session, as the real `sessionQuery` would report them. */
  const stored = new Map()
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
        stored.set(request.sessionId, { cwd: request.meta?.cwd, agentPreset: request.meta?.agentPreset })
        // Real creation composes the agent before publishing it, so the setup
        // callback must have run by the time create() resolves.
        return Promise.resolve(request.setup({ name: 'agent-scope' })).then(() => handle)
      },
      resume: (request) => {
        ledger.resumes.push(request)
        const handle = new FakeHandle(request.resumeSessionId, ledger)
        handles.set(request.resumeSessionId, handle)
        return Promise.resolve(request.setup({ name: 'agent-scope' })).then(() => handle)
      },
      // Real disposal unregisters the agent, so a session whose handle was given
      // back must not look live — that distinction is what the resume path and
      // the "somebody else owns it" path are told apart by.
      get: (id) => (handles.get(id)?.disposed === true ? undefined : handles.get(id)?.agent)
    },
    sessionQuery: {
      observeSession: (sessionId) => {
        ledger.observed.push(sessionId)
        const facts = stored.get(sessionId)
        if (facts === undefined) return Promise.reject(new Error(`session "${sessionId}" not found`))
        return Promise.resolve({
          header: { id: sessionId, cwd: facts.cwd },
          projections: { values: { agentPreset: facts.agentPreset } },
          [Symbol.dispose]: () => {
            ledger.observedDisposed = (ledger.observedDisposed ?? 0) + 1
          }
        })
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
    get: (name) => {
      if (name === 'sessions') return ctx.sessions
      if (name === 'sessionQuery') return ctx.sessionQuery
      return undefined
    }
  }
  return { ctx, ledger, handles, stored }
}

/**
 * Build a runner over a fake Harness.
 *
 * @param {object} [overrides] - config overrides.
 * @param {object} [harnessOptions] - fake Harness options.
 * @returns {Promise<{ runner: object, ctx: object, ledger: object, handles: Map<string, object>, stored: Map<string, object>, warnings: string[], tracked: string[], released: string[] }>} the wired runner.
 */
async function makeRunner(overrides = {}, harnessOptions = {}) {
  const { RemoteRunner } = await import('../lib/runner.js')
  const { ctx, ledger, handles, stored } = fakeHarness(harnessOptions)
  const warnings = []
  /** Session ids the runner handed to the question bridge. */
  const tracked = []
  /** Session ids the runner retired from it. */
  const released = []
  const config = {
    nodeId: 'node-test',
    workspaces: [{ name: 'proj', path: '/workspace/proj' }],
    agentPreset: 'standard',
    permissionPreset: 'workspace-write',
    ...overrides
  }
  const runner = new RemoteRunner({
    ctx,
    config,
    logger: { warn: (line) => warnings.push(line) },
    // The bridge is recorded rather than imported: what this file has to prove is
    // that the runner hands over the exact session id it created and retires it on
    // disposal. The bridge's own behaviour is `node-check`'s subject.
    questions: {
      track: (sessionId) => tracked.push(sessionId),
      release: (sessionId) => released.push(sessionId)
    }
  })
  return { runner, ctx, ledger, handles, stored, warnings, tracked, released }
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
    const { runner, ledger, handles, tracked, released } = await makeRunner()
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
    check(
      'the created session is handed to the question bridge',
      tracked.includes(String(result.sessionId)),
      `tracked ${JSON.stringify(tracked)} for ${String(result.sessionId)} — without this the relay cannot answer its questions`
    )
    // The turn is over, so the claim and the write handle are both gone. This is
    // the pair that makes the conversation usable from the local GUI: a held
    // handle is a held kernel lease, and a held claim would route the person at
    // the machine's own question to the relay page.
    check(
      'the write handle is given back when the turn ends',
      handles.get(result.sessionId)?.disposed === true,
      'the session is still held open, so no other process can write it'
    )
    check('the node holds no handle between turns', runner.handles.size === 0)
    check(
      'the session stops being claimed by the bridge when the turn ends',
      released.includes(String(result.sessionId)),
      `released ${JSON.stringify(released)}`
    )
    check(
      'the created session is remembered for follow-ups',
      runner.sessions.get(result.sessionId)?.workspacePath === '/workspace/proj',
      JSON.stringify([...runner.sessions.values()])
    )
    check('the admitted prompt carries an identity', typeof ledger.followups[0]?.message?.id === 'string')
    await runner.dispose()
    check(
      'disposing the session also retires it from the bridge',
      released.includes(String(result.sessionId)),
      `released ${JSON.stringify(released)}`
    )
    check('the session is flushed before the reply is read', ledger.flushed.length === 1)
    check('the prompt is admitted as a user message', ledger.followups[0]?.message?.source?.kind === 'user')
    check(
      'the prompt text reaches the agent unchanged',
      ledger.followups[0]?.message?.content?.[0]?.text === 'what changed today?'
    )
  }

  // ── a session held by another process is explained, not surfaced raw ────
  // `SessionAlreadyOwnedError` is what the person actually sees when two DSH
  // instances share `~/.dsh` and both open the same conversation. The raw
  // framework text reaches the page as `gateway/internal` and says nothing about
  // what to do, so the runner translates the one case it can explain.
  {
    const { runner, ctx } = await makeRunner()
    const first = await runner.run(command())
    ctx.agents.resume = async () => {
      const error = new Error('session "x" is already owned by an active write handle')
      error.name = 'SessionAlreadyOwnedError'
      throw error
    }
    const failed = await runner.run(command({ commandId: 'cmd-2', prompt: 'x', sessionId: first.sessionId }))
    check('a session held by another process fails the turn', failed.ok === false, JSON.stringify(failed))
    check(
      'the failure says what to do about it',
      String(failed.error).includes('another DSH process') && String(failed.error).includes('one writer'),
      failed.error
    )
    check('the framework error class is not leaked to the page', !String(failed.error).includes('SessionAlreadyOwnedError'), failed.error)
  }

  // ── a follow-up continues the same session ───────────────────────────────
  // The handle from the first turn is gone by now, so this is the path that has
  // to *resume* the conversation from its durable log — the same thing the local
  // GUI does when it opens a remote-started session. Identity, workspace, and
  // posture all have to survive that round trip.
  {
    const { runner, ctx, ledger, handles } = await makeRunner()
    const first = await runner.run(command())
    const originalResume = ctx.agents.resume
    ctx.agents.resume = async (request) => {
      const handle = await originalResume(request)
      handle.next = { text: 'the second answer' }
      return handle
    }
    const second = await runner.run(command({ commandId: 'cmd-2', prompt: 'and then?', sessionId: first.sessionId }))
    check('a follow-up continues the same session id', second.sessionId === first.sessionId)
    check('a follow-up does not create a second session', ledger.creates.length === 1, `${String(ledger.creates.length)} creates`)
    check(
      'a follow-up resumes the session this node created',
      ledger.resumes.length === 1 && ledger.resumes[0]?.resumeSessionId === first.sessionId,
      JSON.stringify(ledger.resumes.map((entry) => entry.resumeSessionId))
    )
    check(
      'the resumed agent is composed on the preset the session records',
      ledger.mountedPresets.at(-1)?.id === 'standard' && ledger.resolvedPresets.length === 2,
      JSON.stringify({ mounted: ledger.mountedPresets.map((entry) => entry.id), resolved: ledger.resolvedPresets })
    )
    check('a follow-up does not re-attach the workspace', ledger.attached.length === 1)
    check('a follow-up returns the new answer', second.text === 'the second answer')
    check('a follow-up admits the new prompt', ledger.followups[1]?.message?.content?.[0]?.text === 'and then?')
    check('a follow-up re-flushes', ledger.flushed.length === 2)
    check(
      'the resumed turn re-pins the configured permission preset',
      ledger.permissions.at(-1)?.preset === 'workspace-write',
      JSON.stringify(ledger.permissions)
    )
    check(
      'the follow-up hands its write handle back too',
      handles.get(first.sessionId)?.disposed === true && runner.handles.size === 0
    )
  }

  // ── the stored session decides the composition, not the current setting ──
  // Mounting a different preset onto an existing log is how a conversation ends
  // up with two personas, so the stored header wins; the configured id is only
  // the fallback for a session that cannot be read.
  {
    const { runner, ctx, ledger, stored } = await makeRunner()
    const first = await runner.run(command())
    stored.set(first.sessionId, { cwd: '/workspace/proj', agentPreset: 'stored-preset' })
    await runner.run(command({ commandId: 'cmd-2', prompt: 'and then?', sessionId: first.sessionId }))
    check(
      'the preset stored in the session wins over the configured one',
      ledger.resolvedPresets.at(-1) === 'stored-preset' && ledger.mountedPresets.at(-1)?.id === 'stored-preset',
      JSON.stringify({ resolved: ledger.resolvedPresets, mounted: ledger.mountedPresets.map((entry) => entry.id) })
    )
  }
  {
    const { runner, ctx, ledger, warnings } = await makeRunner()
    const first = await runner.run(command())
    ctx.sessionQuery.observeSession = async () => {
      throw new Error('stored session is unreadable')
    }
    const second = await runner.run(command({ commandId: 'cmd-2', prompt: 'and then?', sessionId: first.sessionId }))
    check('an unreadable stored session still continues the conversation', second.ok === true, JSON.stringify(second))
    check(
      'the fallback is the configured preset',
      ledger.resolvedPresets.at(-1) === 'standard',
      JSON.stringify(ledger.resolvedPresets)
    )
    check(
      'the unreadable session is warned about rather than swallowed',
      warnings.some((line) => line.includes('could not read the stored session')),
      warnings.join(' | ')
    )
  }

  // ── a stored conversation in another directory is not continued ──────────
  // Same rule as a relay-supplied id from a workspace this node does not serve:
  // running the question in the session's directory instead of the one the
  // command named is a failure with no visible symptom, so it starts over.
  {
    const { runner, ctx, ledger, stored } = await makeRunner({
      workspaces: [
        { name: 'proj', path: '/workspace/proj' },
        { name: 'notes', path: '/workspace/notes' }
      ]
    })
    const first = await runner.run(command())
    stored.set(first.sessionId, { cwd: '/workspace/notes', agentPreset: 'standard' })
    const second = await runner.run(command({ commandId: 'cmd-2', prompt: 'moved?', sessionId: first.sessionId }))
    check('a session whose stored cwd moved starts a fresh conversation', second.ok === true && second.sessionId !== first.sessionId, JSON.stringify(second))
    check('the fresh conversation ignores the stale session record', ledger.creates.length === 2 && ledger.resumes.length === 0, JSON.stringify({ creates: ledger.creates.length, resumes: ledger.resumes.length }))
    check('the fresh conversation is created in the requested workspace', ledger.creates[1]?.meta?.cwd === '/workspace/proj')
  }

  // ── a conversation the local GUI has open is driven, not locked out ──────
  // This is the case that used to end in `SessionAlreadyOwnedError`: the person
  // at the machine opened the remote-started conversation, so *their* agent is
  // the writer. A second write handle is both impossible and wrong — it is the
  // same conversation — and the runner has to leave their agent alone when it is
  // done with the turn.
  {
    const { runner, ctx, ledger, tracked, released } = await makeRunner()
    const first = await runner.run(command())
    const live = new FakeHandle(first.sessionId, ledger)
    live.next = { text: 'answered through the open conversation' }
    const lookup = ctx.agents.get
    ctx.agents.get = (id) => (id === first.sessionId ? live.agent : lookup(id))
    const second = await runner.run(command({ commandId: 'cmd-2', prompt: 'still there?', sessionId: first.sessionId }))
    check(
      'a follow-up drives the agent the local GUI already has open',
      second.text === 'answered through the open conversation',
      JSON.stringify(second)
    )
    check('no second write handle is opened for a session somebody else owns', ledger.resumes.length === 0)
    check(
      'the shared session is claimed while the remote turn runs',
      tracked.includes(String(first.sessionId)) && released.includes(String(first.sessionId)),
      JSON.stringify({ tracked, released })
    )
    check(
      'the shared session is re-pinned to the configured permission too',
      ledger.permissions.at(-1)?.preset === 'workspace-write',
      JSON.stringify(ledger.permissions)
    )
    await runner.dispose()
    check('dispose leaves an agent this node did not create alone', live.disposed === false)
  }

  // ── a guest turn runs the guest posture, on the guest's own sessions ─────
  // The relay already refuses a guest turn for an operator directory and a
  // session that belongs to somebody else. This is the *node's* half of the same
  // rules, and it is the half that matters when the relay is the thing that is
  // wrong: the posture comes from the role, and a session records who owns it, so
  // neither a compromised relay nor a stale session id can widen a visitor's
  // reach or hand them somebody else's conversation.
  {
    const guest = {
      enabled: true,
      workspaces: [{ name: 'demo', path: '/workspace/demo' }],
      agentPreset: 'reader',
      permissionPreset: 'read-only',
      maxPromptChars: 40
    }
    const { runner, ledger } = await makeRunner({
      workspaces: [
        { name: 'proj', path: '/workspace/proj' },
        { name: 'demo', path: '/workspace/demo' }
      ],
      guest
    })
    /** One guest turn, from visitor `guest-a` unless told otherwise. */
    const guestCommand = (overrides = {}) => ({
      commandId: 'g-1',
      workspace: '/workspace/demo',
      prompt: 'review this file',
      role: 'guest',
      principal: 'guest-a',
      ...overrides
    })

    const firstGuest = await runner.run(guestCommand())
    check('a guest turn succeeds', firstGuest.ok === true, JSON.stringify(firstGuest))
    check('the result names the role it ran as', firstGuest.role === 'guest', JSON.stringify(firstGuest.role))
    check('a guest turn composes the guest preset', ledger.resolvedPresets[0] === 'reader', JSON.stringify(ledger.resolvedPresets))
    check(
      'a guest turn is pinned to the guest permission, not the node default',
      ledger.permissions[0]?.preset === 'read-only',
      JSON.stringify(ledger.permissions)
    )
    check(
      'a guest session is titled as one so the local GUI shows it',
      ledger.titles[0]?.title.startsWith('[游客] '),
      JSON.stringify(ledger.titles[0])
    )
    check(
      'the guest session records the preset so it is resumed on the same composition',
      ledger.creates[0]?.meta?.agentPreset === 'reader',
      JSON.stringify(ledger.creates[0]?.meta)
    )

    const sameVisitor = await runner.run(guestCommand({ commandId: 'g-2', prompt: 'and this one', sessionId: firstGuest.sessionId }))
    check(
      'the same visitor continues the same conversation',
      sameVisitor.sessionId === firstGuest.sessionId && ledger.creates.length === 1,
      JSON.stringify({ sessionId: sameVisitor.sessionId, creates: ledger.creates.length })
    )
    check(
      'the follow-up re-pins the guest permission',
      ledger.permissions.at(-1)?.preset === 'read-only',
      JSON.stringify(ledger.permissions)
    )

    const otherVisitor = await runner.run(
      guestCommand({ commandId: 'g-3', prompt: 'mine now', sessionId: firstGuest.sessionId, principal: 'guest-b' })
    )
    check(
      'another visitor cannot continue the first visitor’s conversation',
      otherVisitor.sessionId !== firstGuest.sessionId && ledger.creates.length === 2,
      JSON.stringify({ sessionId: otherVisitor.sessionId, creates: ledger.creates.length })
    )
    check(
      'the second visitor’s fresh conversation still uses the guest posture',
      ledger.mountedPresets.at(-1)?.id === 'reader' && ledger.permissions.at(-1)?.preset === 'read-only',
      JSON.stringify({ mounted: ledger.mountedPresets.at(-1)?.id, permission: ledger.permissions.at(-1)?.preset })
    )

    const asOperator = await runner.run(command({ commandId: 'o-1', sessionId: firstGuest.sessionId }))
    check(
      'the operator naming a guest session gets a fresh conversation, not that one',
      asOperator.sessionId !== firstGuest.sessionId && ledger.creates.length === 3,
      JSON.stringify({ sessionId: asOperator.sessionId, creates: ledger.creates.length })
    )
    check(
      'and runs the operator preset and permission',
      ledger.resolvedPresets.at(-1) === 'standard' && ledger.permissions.at(-1)?.preset === 'workspace-write',
      JSON.stringify({ preset: ledger.resolvedPresets.at(-1), permission: ledger.permissions.at(-1)?.preset })
    )

    const outside = await runner.run(guestCommand({ commandId: 'g-4', workspace: '/workspace/proj' }))
    check(
      'a guest cannot run in an operator workspace',
      outside.ok === false && String(outside.error).includes('not offered to guests'),
      JSON.stringify(outside)
    )
    check(
      'and the refusal does not leak the operator’s directory list',
      outside.ok === false && !String(outside.error).includes('/workspace/proj; known'),
      String(outside.error)
    )
  }

  // ── two commands in flight cannot interleave their turns ────────────────
  // The relay sends one command per node at a time, but the runner no longer
  // relies on that: with a session shared with the local GUI, two interleaved
  // `followup`/`whenIdle` pairs on one agent is how a reply gets attributed to
  // the wrong question.
  {
    const { runner, ctx, ledger } = await makeRunner()
    let open
    const gate = new Promise((resolve) => {
      open = resolve
    })
    const originalCreate = ctx.agents.create
    ctx.agents.create = async (request) => {
      const handle = await originalCreate(request)
      handle.next = { text: 'first answer', gate }
      return handle
    }
    const first = runner.run(command())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = runner.run(command({ commandId: 'cmd-2', prompt: 'second question' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    check(
      'a second command does not start while a turn is running',
      ledger.creates.length === 1 && ledger.followups.length === 1,
      JSON.stringify({ creates: ledger.creates.length, followups: ledger.followups.length })
    )
    open()
    const results = await Promise.all([first, second])
    check('both serialized commands complete', results.every((entry) => entry.ok === true), JSON.stringify(results))
    check('the second command runs after the first', ledger.followups.length === 2, JSON.stringify(ledger.followups.length))
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
    const { runner, ctx } = await makeRunner()
    const created = await runner.run(command())
    check('a completed turn has no error field', created.error === undefined)
    const originalResume = ctx.agents.resume
    ctx.agents.resume = async (request) => {
      const handle = await originalResume(request)
      handle.next = { text: '', reason: { kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter for route' } } }
      return handle
    }
    const failed = await runner.run(command({ commandId: 'cmd-err', prompt: 'again', sessionId: created.sessionId }))
    check('an error turn is reported as a failure', failed.ok === false, JSON.stringify(failed))
    check('the failure carries the adapter code', String(failed.error).includes('NO_ADAPTER'), failed.error)
    check('the failure carries the adapter message', String(failed.error).includes('no adapter for route'))
  }
  {
    const { runner, ctx } = await makeRunner()
    const first = await runner.run(command())
    const originalResume = ctx.agents.resume
    ctx.agents.resume = async (request) => {
      const handle = await originalResume(request)
      handle.next = {
        text: 'partial answer',
        reason: { kind: 'error', error: { code: 'CANCELLED', message: 'stopped' } }
      }
      return handle
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
  {
    // The same failure on the *resume* path, where the fallback (detach the
    // workspace) does not apply. A handle kept after a failed pinning is a lock
    // the person at this machine cannot clear without restarting the backend.
    const { runner, ctx, ledger, handles } = await makeRunner()
    const first = await runner.run(command())
    ctx.permissionPresets.set = () => {
      throw new Error('unknown permission preset')
    }
    const failed = await runner.run(command({ commandId: 'cmd-2', prompt: 'x', sessionId: first.sessionId }))
    check('a resume whose permission pinning fails fails the turn', failed.ok === false, JSON.stringify(failed))
    check(
      'the failed resume hands its write handle back',
      ledger.resumes.length === 1 && handles.get(first.sessionId)?.disposed === true,
      JSON.stringify({ resumes: ledger.resumes.length, disposed: handles.get(first.sessionId)?.disposed })
    )
    check('the failed resume leaves no handle behind', runner.handles.size === 0)
  }

  // ── disposal ─────────────────────────────────────────────────────────────
  {
    const { runner, handles } = await makeRunner()
    const first = await runner.run(command())
    await runner.dispose()
    check('dispose disposes the sessions it created', handles.get(first.sessionId)?.disposed === true)
    check('dispose empties the session table', runner.sessions.size === 0)
    const refused = await runner.run(command({ commandId: 'cmd-after-stop', prompt: 'anyone there?' }))
    check('a stopped node refuses new commands', refused.ok === false, JSON.stringify(refused))
    check('the refusal says the node was stopped', String(refused.error).includes('stopped'), refused.error)
  }

  // ── dispose hands back a turn that is still running ──────────────────────
  // A plugin reload or a settings change tears the node down mid-turn. The session
  // it was writing must go back immediately; otherwise the reload leaves a kernel
  // lease behind and the local GUI cannot open the conversation until the backend
  // itself is restarted.
  {
    const { runner, ctx, ledger, handles, tracked, released } = await makeRunner()
    let open
    const gate = new Promise((resolve) => {
      open = resolve
    })
    const originalCreate = ctx.agents.create
    ctx.agents.create = async (request) => {
      const handle = await originalCreate(request)
      handle.next = { text: 'late answer', gate }
      return handle
    }
    const running = runner.run(command())
    await new Promise((resolve) => setTimeout(resolve, 0))
    const sessionId = ledger.creates[0]?.sessionId
    check('a turn is in flight before the node is stopped', typeof sessionId === 'string', JSON.stringify(ledger.creates))
    await runner.dispose()
    check('dispose hands back the write handle of an in-flight turn', handles.get(sessionId)?.disposed === true)
    check(
      'dispose retires the in-flight turn from the bridge',
      released.includes(String(sessionId)),
      JSON.stringify({ tracked, released })
    )
    open()
    await running
    check('the holder list is empty after disposal', runner.handles.size === 0)
  }

  process.stdout.write(`\nrunner-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nrunner-check: harness error — ${error?.stack ?? error}\n`)
}

if (failures > 0) process.exitCode = 1
