/**
 * `dsh-remote-control` — run one question through a real DSH agent.
 *
 * This is the only file that touches the Harness API, and it deliberately does
 * not invent a private execution path: every step mirrors what the official
 * `dsh-webhook` runtime does when it turns an external event into a session
 * (`ctx.agentDefaultModel.currentSelection` → `ctx.agentPresets.resolve` →
 * `ctx.workspaceRegistry.create` → `ctx.agents.create` with `agentOptions` and
 * `meta.cwd` → `mount` → `attachSession` → `permissionPresets.set` →
 * `followup`). The payoff is that a remotely started
 * conversation is an ordinary session: it appears in the local GUI, in the
 * sidebar, in the workspace grouping, in persistence, and its approvals route
 * through the normal approval service to whoever is sitting at the machine.
 *
 * **A session is claimed for one turn, then handed back.** DSH gives a session
 * exactly one writer: an open write handle holds a kernel lease on it
 * (`session.lock`), and any other process that opens it for write gets
 * `SessionAlreadyOwnedError`. So this runner opens a handle when a turn starts
 * and disposes it when the turn ends — the session then belongs to whoever opens
 * it next, which on this machine is normally the local GUI. Between turns the
 * conversation is continued by `ctx.agents.resume` on the same session id, which
 * is what the GUI itself does, so the two ends share one conversation instead of
 * fighting over it. If the local GUI already has the session open, the runner
 * drives *that* live agent rather than opening a second handle.
 *
 * The same boundary decides who answers a question: the bridge claims a session
 * only while this node is running a turn in it, so a question asked by the
 * person at the machine never gets routed to the page.
 *
 * **Every command carries a role, and the role decides three things.** A relay
 * command is either the operator's (`role: 'owner'`) or a visitor's
 * (`role: 'guest'`, plus the anonymous `principal` the relay issued). The role
 * picks the workspace allow-list, the agent preset and the permission preset,
 * and it is recorded *on the session* — so a guest cannot name a session this
 * node created for the operator, and a second visitor cannot continue the first
 * visitor's conversation, even if the relay asked them to. The relay enforces
 * the same rules from its own side; both halves check, because neither trusts
 * the other. The refusal message for a guest names only the guest's own
 * workspaces, so a rejected path cannot be used to enumerate the machine's
 * directories.
 *
 * Reply extraction follows `dsh-headless`: walk the session log from the
 * sequence captured just before the prompt, keep the last non-empty
 * `assistant/message` text, and read the `turn/end` reason. That is more robust
 * than watching the live stream, because it survives retries and reports exactly
 * what was committed to durable history. The walk stops at the end of *this*
 * turn, because a session shared with the local GUI can have a second turn in
 * the same window.
 *
 * @module dsh-remote-control/runner
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { GUEST_DEFAULTS } from './config.js'

/**
 * Build the list of directories the Harness packages may resolve from.
 *
 * A plugin loaded by absolute path cannot see the profile's `node_modules`
 * through Node's own lookup, so the roots are assembled explicitly. The order is
 * deliberate: an explicit override first, then this package's own `node_modules`
 * and its ancestors (which is both how the self-checks run and, in the common
 * case, how an installed plugin inside a profile resolves), and finally the
 * conventional profile locations under the Harness home.
 *
 * An ancestor walk is not cosmetic: on Windows the DSH home lives under
 * `%USERPROFILE%`, and hard-coding `~/.dsh/profiles/web` first would silently
 * prefer it over the installation actually running.
 *
 * @returns {string[]} candidate directories, most specific first.
 */
function profileRoots() {
  const roots = []
  if (typeof process.env.DSH_REMOTE_CONTROL_PROFILE_DIR === 'string' && process.env.DSH_REMOTE_CONTROL_PROFILE_DIR !== '') {
    roots.push(process.env.DSH_REMOTE_CONTROL_PROFILE_DIR)
  }
  let directory = dirname(fileURLToPath(import.meta.url))
  for (let depth = 0; depth < 5; depth += 1) {
    roots.push(directory)
    const parent = dirname(directory)
    if (parent === directory) break
    directory = parent
  }
  roots.push(join(homedir(), '.dsh', 'profiles', 'web'), join(homedir(), '.dsh', 'profiles'))
  return [...new Set(roots)]
}

/**
 * Import one `@deepseek-ai/*` package out of the running Harness installation.
 *
 * @param {string} specifier - package name, e.g. `@deepseek-ai/dsh-llm`.
 * @returns {Promise<object>} the module namespace.
 */
async function loadDshPackage(specifier) {
  const roots = profileRoots()
  const errors = []
  for (const root of roots) {
    try {
      const require = createRequire(join(root, 'package.json'))
      return await import(require.resolve(specifier))
    } catch (error) {
      errors.push(`${root}: ${error.code ?? error.message}`)
    }
  }
  throw new Error(
    `dsh-remote-control cannot load ${specifier} from any profile root (${errors.join('; ')}). ` +
      'Install it with `dsh plugin --profile web add <this package>` so the profile owns the peer dependencies.'
  )
}

/**
 * Probe the Harness-package resolution, for the self-checks to assert on.
 *
 * Resolution is the one thing here that cannot be tested by driving the runner:
 * it only fails when the profile layout differs from the assumed one, which is
 * exactly the situation a check should cover. So the check calls this and the
 * real `ask()` path uses the same function.
 *
 * @returns {Promise<{ roots: string[], llm: string }>} the roots tried and the resolved `@deepseek-ai/dsh-llm` path.
 */
export async function probePackageResolution() {
  const { createRequire: makeRequire } = await import('node:module')
  const roots = profileRoots()
  let llm
  for (const root of roots) {
    try {
      llm = makeRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh-llm')
      break
    } catch {
      /* try the next root */
    }
  }
  if (llm === undefined) throw new Error(`@deepseek-ai/dsh-llm did not resolve from any of: ${roots.join(', ')}`)
  return { roots, llm }
}

/**
 * Value helpers from the Harness, resolved once.
 */
let helpersPromise

/**
 * Resolve the small set of Harness value helpers this runner needs.
 *
 * @returns {Promise<{ createUserMessage: Function, SessionSeq: Function, brandString: Function }>} helpers.
 */
function helpers() {
  helpersPromise ??= (async () => {
    const [llm, session, brand] = await Promise.all([
      loadDshPackage('@deepseek-ai/dsh-llm'),
      loadDshPackage('@deepseek-ai/dsh-session'),
      loadDshPackage('@deepseek-ai/dsh-brand')
    ])
    if (typeof llm.createUserMessage !== 'function') {
      throw new TypeError('dsh-remote-control: @deepseek-ai/dsh-llm no longer exports createUserMessage')
    }
    if (typeof session.SessionSeq !== 'function') {
      throw new TypeError('dsh-remote-control: @deepseek-ai/dsh-session no longer exports SessionSeq')
    }
    return { createUserMessage: llm.createUserMessage, SessionSeq: session.SessionSeq, brandString: brand.brandString }
  })()
  return helpersPromise
}

/**
 * Absorb the last assistant turn committed between two log positions.
 *
 * A turn often commits more than one assistant message (a tool-calling step
 * followed by the final answer), and early ones are frequently empty or carry
 * only usage. Keeping the last non-empty text is what makes the remote page show
 * the answer the user actually saw locally.
 *
 * The walk ends at the first `turn/end` after the turn it is reading. A session
 * this node shares with the local GUI can hold a *second* turn in the same
 * window — the person at the machine sends their own message while a remote turn
 * is still running — and reading to the end of the log would then report their
 * answer to the relay page as if it were the reply to the remote question. When
 * the prompt's message identity is known the walk starts at that message, so the
 * attribution is exact even if the other end's turn was admitted first.
 *
 * @param {object} session - live Session.
 * @param {number} firstSeq - log length captured before the prompt.
 * @param {Function} SessionSeq - the branded-sequence constructor.
 * @param {string} [messageId] - identity of the admitted prompt, when known.
 * @returns {{ text: string, reason: object|undefined }} last text and turn outcome.
 */
export function summarizeTurn(session, firstSeq, SessionSeq, messageId) {
  let started = false
  let text = ''
  let reason
  const start = (messageId === undefined ? undefined : promptSeq(session, firstSeq, SessionSeq, messageId)) ?? firstSeq
  const length = session.seq
  for (let seq = start; seq < length; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') {
      // A turn that begins after ours ended is somebody else's.
      if (started) break
      started = true
      continue
    }
    if (!started) continue
    if (event.type === 'assistant/message') {
      const joined = (event.data?.message?.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('')
      if (joined !== '') text = joined
    }
    if (event.type === 'turn/end') {
      reason = event.data?.reason
      break
    }
  }
  return { text, reason }
}

/**
 * The log position of one admitted prompt.
 *
 * @param {object} session - live Session.
 * @param {number} firstSeq - earliest position worth scanning.
 * @param {Function} SessionSeq - the branded-sequence constructor.
 * @param {string} messageId - identity of the admitted prompt.
 * @returns {number|undefined} its sequence, or undefined when it is not in the window.
 */
function promptSeq(session, firstSeq, SessionSeq, messageId) {
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event?.type === 'user/message' && event.data?.id === messageId) return seq
  }
  return undefined
}

/**
 * Turn a `turn/end` reason into a human-readable failure, when it is one.
 *
 * @param {object|undefined} reason - the recorded reason.
 * @returns {string|undefined} an error line, or undefined for a completed turn.
 */
export function turnFailure(reason) {
  if (reason === undefined) return 'the turn ended without recording an outcome'
  if (reason.kind === 'completed') return undefined
  if (reason.kind === 'error') {
    const code = reason.error?.code ?? 'unknown'
    const message = reason.error?.message ?? 'no detail'
    return `${code}: ${message}`
  }
  return `turn ended as ${JSON.stringify(reason.kind)}`
}

/**
 * The session-record key for a caller: what a session belongs to.
 *
 * Two fields rather than one string because the two questions are different —
 * "is this the operator or a visitor" decides the posture, and "which visitor"
 * decides whether one guest may continue another guest's conversation. Both are
 * compared on every reuse, so a session can only ever be driven by the exact
 * caller that created it.
 *
 * @param {{ role: string, principal: string }} caller - the acting caller.
 * @returns {string} a comparable key.
 */
function callerKey(caller) {
  return `${caller.role}\u0000${caller.principal}`
}

/**
 * Read the caller out of a relay command.
 *
 * Anything that is not an explicit guest command is the operator's: the node's
 * own configuration is what the local GUI and the operator's page have always
 * produced, and a missing `role` must keep meaning exactly that. A guest command
 * without a principal is resolved as an empty principal and refused in
 * `runTurn`, rather than silently collapsing every visitor into one identity.
 *
 * @param {object} command - the relay command envelope.
 * @returns {{ role: 'owner'|'guest', principal: string }} the caller.
 */
export function callerOf(command) {
  if (command?.role !== 'guest') return { role: 'owner', principal: 'owner' }
  const principal = typeof command.principal === 'string' ? command.principal.trim() : ''
  return { role: 'guest', principal }
}

/**
 * The engine that turns relay commands into Harness turns.
 *
 * One instance per node. It records which sessions this node created — that list
 * is the trust boundary the relay cannot cross — and it owns a session only for
 * as long as a turn is running in it: the write handle is disposed when the turn
 * ends, which gives the conversation back to the local GUI instead of locking it
 * out. A plugin unload disposes whatever turn is still in flight.
 */
export class RemoteRunner {
  /**
   * @param {object} options - `{ ctx, config, logger, workspaceProvider? }`.
   *
   * `workspaceProvider` is the registry mode: a synchronous callback that returns
   * the current list, consulted on every advertisement and every command instead
   * of a list fixed at startup. That timing is the whole point — a workspace
   * created after the backend booted has to become usable without a restart, and
   * re-reading is also what keeps the advertised list honest if one is removed.
   */
  constructor({ ctx, config, logger, workspaceProvider, questions }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    /** Registry mode: returns the live list, or undefined for the configured one. */
    this.workspaceProvider = workspaceProvider
    /**
     * The question bridge, when one is installed.
     *
     * The runner is where a session's identity becomes known, so it is the only
     * place that can tell the bridge which sessions the relay may answer for.
     * Optional because `runner-check` drives this class without a plugin around
     * it, and a runner that refused to work without a relay would be untestable.
     */
    this.questions = questions
    /**
     * Sessions this node created: `sessionId -> { sessionId, workspacePath, role, principal }`.
     *
     * The relay is a separate trust domain, so a `sessionId` it names is only
     * driveable while this node is the one that created it — that is what stops a
     * compromised or buggy relay from aiming a question at a conversation the
     * person at this machine owns. The record has to outlive the turn (the
     * continuity and workspace checks read it) even though the write handle does
     * not, and it is dropped with the process: after a plugin reload the page's
     * stored session id is unknown again and its next question starts a new
     * conversation, exactly as before.
     *
     * `role` and `principal` are what keep the caller boundary: a session belongs
     * to the operator or to one visitor, and only that same caller may continue
     * it. Both are compared by `callerKey`.
     *
     * @type {Map<string, { sessionId: string, workspacePath: string, role: string, principal: string }>}
     */
    this.sessions = new Map()
    /** Write handles this node currently owns, i.e. the turns in flight. */
    this.handles = new Set()
    /** Session ids currently claimed by a turn, so dispose can hand them back. */
    this.claimed = new Set()
    this.disposed = false
    /** Serializes turns; the relay also runs one command at a time per node. */
    this.chain = Promise.resolve()
  }

  /**
   * List the workspaces this node advertises.
   *
   * @returns {Array<{ name: string, path: string }>} advertised workspaces.
   */
  workspaces() {
    const source = this.workspaceProvider === undefined ? this.config.workspaces : this.workspaceProvider()
    return source.map((entry) => ({ name: entry.name, path: entry.path }))
  }

  /**
   * The guest posture, defaulted field by field.
   *
   * Read through a resolver rather than straight off `this.config` because the
   * runner is also constructed by the self-checks without a guest block, and a
   * runner that threw on a missing field would be untestable. An absent block
   * resolves to "the door is shut", which is also what a node that never
   * configured guests should do.
   *
   * @returns {{ enabled: boolean, workspaces: Array<{name: string, path: string}>, agentPreset: string, permissionPreset: string, maxPromptChars: number }} the posture.
   */
  guestConfig() {
    const raw = this.config.guest
    const source = raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    const entries = Array.isArray(source.workspaces) ? source.workspaces : []
    return {
      enabled: source.enabled === true,
      workspaces: entries.filter((entry) => entry !== null && typeof entry === 'object' && typeof entry.path === 'string'),
      agentPreset: typeof source.agentPreset === 'string' && source.agentPreset.trim() !== '' ? source.agentPreset.trim() : GUEST_DEFAULTS.agentPreset,
      permissionPreset:
        typeof source.permissionPreset === 'string' && source.permissionPreset.trim() !== ''
          ? source.permissionPreset.trim()
          : GUEST_DEFAULTS.permissionPreset,
      maxPromptChars:
        typeof source.maxPromptChars === 'number' && Number.isFinite(source.maxPromptChars) && source.maxPromptChars > 0
          ? source.maxPromptChars
          : GUEST_DEFAULTS.maxPromptChars
    }
  }

  /**
   * List the workspaces guests may use.
   *
   * The intersection with the operator's live list is the safety property, not a
   * tidiness one: in registry mode the operator's set is decided by which
   * sessions exist, so a guest path that the registry no longer carries must stop
   * being offered the moment it does. In explicit mode the configured subset is
   * already validated at load, and the intersection is then a no-op.
   *
   * @returns {Array<{ name: string, path: string }>} guest-visible workspaces.
   */
  guestWorkspaces() {
    const guest = this.guestConfig()
    if (!guest.enabled) return []
    const owner = new Set(this.workspaces().map((entry) => entry.path))
    return guest.workspaces.filter((entry) => owner.has(entry.path)).map((entry) => ({ name: entry.name, path: entry.path }))
  }

  /**
   * Resolve a relay-supplied workspace path against what the caller may use.
   *
   * Refusing anything not advertised is the whole point of the allow-list: the
   * relay is a separate trust domain, so a compromised or buggy relay must not be
   * able to name `/etc` as a workspace and have the node comply.
   *
   * The role is a parameter rather than a property because the two lists answer
   * two different questions, and the *error message* has to differ with it: a
   * guest told which paths exist would have been handed a directory listing of
   * the machine, so a guest only ever learns about the paths it was already
   * offered.
   *
   * @param {string} requested - path from the command.
   * @param {'owner'|'guest'} [role] - who is asking.
   * @returns {string} the advertised absolute path.
   * @throws {Error} when the path is not offered to that caller.
   */
  resolveWorkspace(requested, role = 'owner') {
    const advertised = role === 'guest' ? this.guestWorkspaces() : this.workspaces()
    const match = advertised.find((entry) => entry.path === requested)
    if (match === undefined) {
      const known = advertised.map((entry) => entry.path).join(', ') || '(none offered)'
      throw new Error(
        role === 'guest'
          ? `workspace ${JSON.stringify(requested)} is not offered to guests; offered: ${known}`
          : `workspace ${JSON.stringify(requested)} is not advertised by this node; known: ${known}`
      )
    }
    return match.path
  }

  /**
   * The preset and permission a caller's turns run under.
   *
   * @param {{ role: 'owner'|'guest', principal: string }} caller - the acting caller.
   * @returns {{ role: string, principal: string, agentPreset: string, permissionPreset: string }} the posture.
   */
  postureFor(caller) {
    if (caller.role === 'guest') {
      const guest = this.guestConfig()
      return {
        role: 'guest',
        principal: caller.principal,
        agentPreset: guest.agentPreset,
        permissionPreset: guest.permissionPreset
      }
    }
    return {
      role: 'owner',
      principal: caller.principal,
      agentPreset: this.config.agentPreset,
      permissionPreset: this.config.permissionPreset
    }
  }

  /**
   * Run one relay command and return the transcript-shaped outcome.
   *
   * Turns are serialized here rather than trusted to arrive one at a time. The
   * relay does send one command per node at a time, but a session can now be
   * shared with the local GUI, and two `followup`/`whenIdle` pairs interleaving
   * on one agent is exactly how a reply gets attributed to the wrong question.
   *
   * @param {object} command - `{ commandId, workspace, prompt, sessionId? }`.
   * @returns {Promise<object>} `{ ok, text?, error?, sessionId?, workspace, prompt, durationMs }`.
   */
  run(command) {
    const turn = this.chain.then(() => this.runTurn(command))
    // A rejected turn must not poison the chain: every later command would then
    // fail with this one's error instead of running.
    this.chain = turn.then(
      () => undefined,
      () => undefined
    )
    return turn
  }

  /**
   * Run one command. Always resolves; failures come back in the result object.
   *
   * @param {object} command - `{ commandId, workspace, prompt, sessionId? }`.
   * @returns {Promise<object>} the transcript-shaped outcome.
   */
  async runTurn(command) {
    const started = Date.now()
    // The caller is read before the try so that a *refused* turn still reports who
    // it came from. The relay records the role of a failure from its own copy of
    // the submission, and this field is what the operator's page shows beside it —
    // a refusal that looked like the operator's own would hide a visitor probing
    // the door.
    const caller = callerOf(command)
    const base = {
      commandId: command.commandId,
      prompt: typeof command.prompt === 'string' ? command.prompt : '',
      workspace: typeof command.workspace === 'string' ? command.workspace : '',
      nodeId: this.config.nodeId,
      role: caller.role
    }
    try {
      if (this.disposed) throw new Error('this node was stopped')
      const prompt = typeof command.prompt === 'string' ? command.prompt.trim() : ''
      if (prompt === '') throw new Error('prompt is empty')
      if (caller.role === 'guest') {
        // Three independent refusals, so a compromised relay cannot smuggle a
        // guest turn in through a node that never opened the door, borrow the
        // operator's posture, or use the page as an unbounded text sink.
        const guest = this.guestConfig()
        if (!guest.enabled) throw new Error('this node does not accept guest turns')
        if (caller.principal === '') throw new Error('a guest turn must name the visitor it came from')
        if (prompt.length > guest.maxPromptChars) {
          throw new Error(`the question is longer than the ${String(guest.maxPromptChars)} characters a guest turn may carry`)
        }
      }
      const posture = this.postureFor(caller)
      const workspacePath = this.resolveWorkspace(command.workspace, caller.role)
      const existing = typeof command.sessionId === 'string' ? this.sessions.get(command.sessionId) : undefined
      // A session is created inside one workspace and cannot be moved, so a
      // `sessionId` that arrives alongside a *different* workspace starts a fresh
      // conversation. Continuing the old one would run the question in the wrong
      // directory and report success — a failure with no visible symptom. This is
      // also the trust boundary: an id this node never created is simply unknown.
      //
      // The caller has to match too, and for the same reason: a session created
      // for one visitor must not become a second visitor's conversation, and a
      // guest must never be able to continue the operator's. A mismatch starts a
      // fresh conversation in the caller's own posture, which is the same safe
      // outcome a workspace mismatch gets.
      const reusable =
        existing !== undefined && existing.workspacePath === workspacePath && callerKey(existing) === callerKey(caller)
          ? existing
          : undefined
      const outcome = reusable === undefined
        ? await this.startConversation(workspacePath, prompt, posture)
        : await this.continueConversation(reusable, prompt, posture)
      return {
        ...base,
        ok: true,
        sessionId: outcome.sessionId,
        text: outcome.text,
        durationMs: Date.now() - started
      }
    } catch (error) {
      return {
        ...base,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - started
      }
    }
  }

  /**
   * Create a new session in one workspace and ask the first question.
   *
   * @param {string} workspacePath - advertised absolute workspace path.
   * @param {string} prompt - the question.
   * @param {{ role: string, principal: string, agentPreset: string, permissionPreset: string }} posture - the caller's preset and permission.
   * @returns {Promise<{ sessionId: string, text: string }>} the answer.
   */
  async startConversation(workspacePath, prompt, posture) {
    const { brandString } = await helpers()
    const preset = await this.ctx.agentPresets.resolve(posture.agentPreset)
    await this.ctx.agentPresets.standingKeyFor(preset.id)
    const workspace = await this.ctx.workspaceRegistry.create(workspacePath)
    const sessionId = brandString(`remote-${randomUUID()}`)
    // An Agent created without a route cannot assemble its first prompt at all:
    // the persona prefix every shipped preset carries is
    // `You are a coding agent powered by the {{model}} model.`, and the prompt
    // registry resolves `{{model}}` strictly from `agent.options.model`, so an
    // absent route throws before any request is built ("prompt variable
    // \"{{model}}\" has no value for this assembly (section
    // \"deployment:persona-prefix\")"). The GUI never meets this because its own
    // create path passes `agentDefaultModel.currentSelection()`; the node is the
    // one entry point that builds an Agent by hand, so it pins the same default
    // route here. A deployment default is always present (`provider`/`model` are
    // required by that service), which keeps the first turn working even when the
    // relay is the only thing driving the session and no GUI has picked a model.
    const route = this.ctx.agentDefaultModel.currentSelection()
    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: { provider: route.provider, model: route.model },
      meta: { cwd: workspace.path, agentPreset: preset.id },
      setup: async (agentCtx) => {
        await this.ctx.agentPresets.mount(agentCtx, preset.id)
      }
    })
    let attached = false
    try {
      await workspace.attachSession(sessionId)
      attached = true
      this.applyPermission(handle.agent, posture.permissionPreset)
      this.title(handle.agent, prompt, posture.role)
      // The posture is recorded with the session, not looked up later: it is what
      // decides whether a later `sessionId` may continue this conversation at all.
      this.sessions.set(sessionId, { sessionId, workspacePath: workspace.path, role: posture.role, principal: posture.principal })
    } catch (error) {
      if (attached) await workspace.detachSession(sessionId).catch(() => {})
      await handle.dispose().catch(() => {})
      throw error
    }
    const text = await this.turn({ sessionId, agent: handle.agent, prompt, handle })
    return { sessionId, text }
  }

  /**
   * Continue a conversation this node started, whatever holds it right now.
   *
   * A session has exactly one writer, so the first question is who has it:
   *
   * - **Nobody has it open.** The normal case between turns. The session is
   *   resumed from its durable log, run, and released again — the same thing the
   *   local GUI does when you click it, which is what lets the two ends share one
   *   conversation instead of being locked out of each other.
   * - **The local GUI has it open.** Then *that* agent is the writer, and this
   *   turn drives it directly. Opening a second handle would not just fail with
   *   `SessionAlreadyOwnedError`; it would be the wrong answer, because the two
   *   ends are looking at the same conversation.
   *
   * @param {{ sessionId: string, workspacePath: string, role: string, principal: string }} entry - a session this node created.
   * @param {string} prompt - the follow-up question.
   * @param {{ role: string, principal: string, agentPreset: string, permissionPreset: string }} posture - the caller's preset and permission.
   * @returns {Promise<{ sessionId: string, text: string }>} the answer.
   */
  async continueConversation(entry, prompt, posture) {
    const sessionId = entry.sessionId
    const live = this.ctx.agents.get(sessionId)
    if (live !== undefined) {
      // Already-live sessions are re-pinned to the caller's posture too: the live
      // agent may have been created by an earlier turn of the same visitor, and
      // the permission must not be whatever a local switch left on it.
      this.applyPermission(live, posture.permissionPreset)
      const text = await this.turn({ sessionId, agent: live, prompt })
      return { sessionId, text }
    }
    const stored = await this.observeSession(sessionId)
    // The stored conversation lives in another directory: continuing it here would
    // run the question in the wrong place and report success, which is the same
    // failure the workspace check in `runTurn` refuses for a relay-supplied id.
    if (stored?.cwd !== undefined && stored.cwd !== entry.workspacePath) {
      return this.startConversation(entry.workspacePath, prompt, posture)
    }
    const handle = await this.resumeConversation(entry, stored, posture)
    const text = await this.turn({ sessionId, agent: handle.agent, prompt, handle })
    return { sessionId, text }
  }

  /**
   * Reopen a session this node created earlier, on the composition it owns.
   *
   * The preset comes from the stored session rather than from the configuration:
   * a conversation keeps the identity it was created with, and mounting a
   * different one onto an existing log is how a session ends up with two
   * personas. The configured preset is only the fallback for a session whose
   * header cannot be read (an older artifact, or a profile without the query
   * service), and the configured *permission* preset is pinned on every remote
   * turn either way — the posture the page promises must not depend on what this
   * conversation was last set to locally.
   *
   * @param {{ sessionId: string, workspacePath: string, role: string, principal: string }} entry - a session this node created.
   * @param {{ agentPreset?: string, cwd?: string }|undefined} stored - its stored identity, when readable.
   * @param {{ role: string, principal: string, agentPreset: string, permissionPreset: string }} posture - the caller's preset and permission.
   * @returns {Promise<object>} the resumed AgentHandle, owned by this turn.
   */
  async resumeConversation(entry, stored, posture) {
    const preset = await this.ctx.agentPresets.resolve(stored?.agentPreset ?? posture.agentPreset)
    await this.ctx.agentPresets.standingKeyFor(preset.id)
    const route = this.ctx.agentDefaultModel.currentSelection()
    let handle
    try {
      handle = await this.ctx.agents.resume({
        resumeSessionId: entry.sessionId,
        agentOptions: { provider: route.provider, model: route.model },
        setup: async (agentCtx) => {
          await this.ctx.agentPresets.mount(agentCtx, preset.id)
        }
      })
    } catch (error) {
      // The framework's message for this is `SessionAlreadyOwnedError: …`, which
      // reaches the page as `gateway/internal` and tells the reader nothing about
      // what to do. It means one concrete thing: another DSH process — normally a
      // second window of the local GUI — is writing this session right now.
      if (error?.name === 'SessionAlreadyOwnedError') {
        throw new Error(
          `this conversation is open for writing in another DSH process (another window or backend holds it); ` +
            'close it there and send again — a session has exactly one writer'
        )
      }
      throw error
    }
    try {
      this.applyPermission(handle.agent, posture.permissionPreset)
    } catch (error) {
      // A handle that is not handed back is a lock: the local GUI could not open
      // this conversation again until the backend restarted.
      await this.release(handle)
      throw error
    }
    return handle
  }

  /**
   * Read the durable identity of one session.
   *
   * Best effort on purpose: this decides which preset to mount and whether the
   * conversation still lives in the workspace the relay named, and both have a
   * safe default (`config.agentPreset`, and the record this node already holds).
   * A missing session is *not* reported here — `agents.resume` refuses it with a
   * precise error, and inventing a fresh conversation at this point is the silent
   * continuity break this file exists to avoid.
   *
   * @param {string} sessionId - session identity.
   * @returns {Promise<{ agentPreset?: string, cwd?: string }|undefined>} stored header facts.
   */
  async observeSession(sessionId) {
    const query = this.ctx.get('sessionQuery')
    if (query === undefined) return undefined
    let observation
    try {
      observation = await query.observeSession(sessionId)
      return {
        agentPreset: observation?.projections?.values?.agentPreset,
        cwd: observation?.header?.cwd
      }
    } catch (error) {
      this.logger?.warn?.(`dsh-remote-control: could not read the stored session: ${error.message}`)
      return undefined
    } finally {
      observation?.[Symbol.dispose]?.()
    }
  }

  /**
   * Run one turn in a session, claiming it for the relay and giving it back after.
   *
   * The claim is what routes that session's `ask_user_question` to the page, and
   * it lasts exactly as long as the turn: between turns the session belongs to
   * whoever opens it. The write handle is released for the same reason — a held
   * handle is a held kernel lock, and a lock held between turns is what makes a
   * remote-started conversation impossible to continue on this machine. A handle
   * this turn did not open (the local GUI's live agent) is left alone.
   *
   * @param {{ sessionId: string, agent: object, prompt: string, handle?: object }} turn - the turn to run.
   * @returns {Promise<string>} the assistant answer.
   */
  async turn({ sessionId, agent, prompt, handle }) {
    if (handle !== undefined) this.handles.add(handle)
    this.claimed.add(sessionId)
    this.questions?.track(sessionId)
    try {
      return await this.ask(agent, prompt)
    } finally {
      this.questions?.release(sessionId)
      this.claimed.delete(sessionId)
      if (handle !== undefined) {
        this.handles.delete(handle)
        await this.release(handle)
      }
    }
  }

  /**
   * Give one session's write handle back.
   *
   * Disposal is what closes the persistence handle and releases the kernel lease,
   * so this is the step that lets the local GUI open the conversation. A failure
   * is warned about rather than thrown: the turn already produced its answer, and
   * a handle that will not close is a lock the person at the machine will notice,
   * not an answer the page should lose.
   *
   * @param {object} handle - AgentHandle.
   * @returns {Promise<void>} resolves once disposal settled.
   */
  async release(handle) {
    try {
      await handle.dispose()
    } catch (error) {
      this.logger?.warn?.(`dsh-remote-control: releasing a session failed: ${error.message}`)
    }
  }

  /**
   * Admit one prompt and wait for the whole agent to reach quiescence.
   *
   * @param {object} agent - live Agent.
   * @param {string} prompt - the question.
   * @returns {Promise<string>} the final assistant text.
   */
  async ask(agent, prompt) {
    const { createUserMessage, SessionSeq } = await helpers()
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    const message = createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } })
    agent.followup(message)
    await agent.whenIdle()
    await this.flush(agent.session)
    // The prompt's own identity attributes the reply. A session shared with the
    // local GUI can hold their turn in the same window, and `firstSeq` alone
    // would then hand their answer to the relay page.
    const { text, reason } = summarizeTurn(agent.session, firstSeq, SessionSeq, message.id)
    const failure = turnFailure(reason)
    if (failure !== undefined) {
      // The turn failed but may still carry partial text; surfacing both is more
      // useful than an empty error, because a cancelled turn delivers a prefix.
      throw new Error(text === '' ? failure : `${failure}\n\n(partial reply)\n${text}`)
    }
    return text
  }

  /**
   * Flush a session so its durable log settles before the answer is read.
   *
   * @param {object} session - live Session.
   * @returns {Promise<void>} resolves once the flush settled.
   */
  async flush(session) {
    const sessions = this.ctx.get('sessions')
    if (sessions === undefined) return
    await sessions.flush(session)
  }

  /**
   * Pin the permission preset onto a session.
   *
   * A failure here is fatal for the turn rather than a warning: a remote session
   * that quietly ran with a wider posture than configured would be the one bug
   * this whole design exists to prevent. It is re-pinned on every remote turn,
   * including a turn in a conversation the local GUI happens to have open, so the
   * posture the page advertises is the posture the turn ran with rather than
   * whatever this session was last set to locally.
   *
   * @param {object} agent - live Agent.
   * @param {string} presetName - configured preset id.
   */
  applyPermission(agent, presetName) {
    this.ctx.permissionPresets.set(agent.session, presetName)
  }

  /**
   * Name the session after its first question so the local GUI is readable.
   *
   * A guest session is marked as one. The local GUI is how the operator audits
   * what the public door did — the relay page is not the only place these turns
   * are visible — and a list of sessions where an anonymous visitor's question is
   * indistinguishable from the operator's own would hide exactly that.
   *
   * @param {object} agent - live Agent.
   * @param {string} prompt - the first question.
   * @param {string} [role] - `'owner'` or `'guest'`.
   */
  title(agent, prompt, role = 'owner') {
    try {
      const line = prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
      const prefix = role === 'guest' ? '[游客] ' : ''
      this.ctx.sessionTitle?.rename?.(agent.session, `${prefix}${line === '' ? 'remote question' : line}`)
    } catch (error) {
      this.logger?.warn?.(`dsh-remote-control: could not title session: ${error.message}`)
    }
  }

  /**
   * Stop the node: hand back every session it is holding.
   *
   * Only handles this node opened are disposed. An agent the local GUI created is
   * not ours to tear down, and disposing it would close a conversation the person
   * at the machine is looking at.
   *
   * @returns {Promise<void>} resolves once disposal settled.
   */
  async dispose() {
    this.disposed = true
    const handles = [...this.handles]
    this.handles.clear()
    for (const sessionId of this.claimed) {
      // Stop accepting relay answers before the session goes away, so a question
      // that arrives during teardown falls through to the local GUI instead of
      // being held for a page nobody is watching.
      this.questions?.release(sessionId)
    }
    this.claimed.clear()
    this.sessions.clear()
    for (const handle of handles) {
      await this.release(handle)
    }
  }
}

/**
 * Normalize the configured workspace list into `{ name, path }` entries.
 *
 * A leading `~` is expanded here rather than at use time so the advertised list
 * the control page shows is exactly the list the runner accepts. Both the terse
 * string form and the explicit `{ name, path }` form are accepted, because the
 * common case (one obvious directory) should not need a YAML mapping.
 *
 * Duplicate paths are rejected: they would make the control page show two
 * identical workbenches, and the allow-list check in `resolveWorkspace` would
 * silently pick the first.
 *
 * @param {Array<string|{name?: string, path: string}>} [raw] - configured entries.
 * @returns {Array<{ name: string, path: string }>} normalized entries.
 */
export function normalizeWorkspaces(raw = []) {
  if (!Array.isArray(raw)) {
    throw new TypeError('dsh-remote-control: workspaces must be a list')
  }
  const normalized = raw.map((entry, index) => {
    const isObject = entry !== null && typeof entry === 'object'
    const rawPath = isObject ? entry.path : entry
    if (typeof rawPath !== 'string' || rawPath.trim() === '') {
      throw new TypeError(`dsh-remote-control: workspaces[${String(index)}] must be a non-empty path string`)
    }
    const trimmed = rawPath.trim()
    const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
    if (!isAbsolute(expanded)) {
      throw new TypeError(`dsh-remote-control: workspaces[${String(index)}] must be absolute, got ${JSON.stringify(rawPath)}`)
    }
    const configuredName = isObject && typeof entry.name === 'string' ? entry.name.trim() : ''
    return { name: configuredName === '' ? expanded : configuredName, path: expanded }
  })
  const seen = new Set()
  for (const entry of normalized) {
    if (seen.has(entry.path)) throw new TypeError(`dsh-remote-control: workspace ${JSON.stringify(entry.path)} is listed twice`)
    seen.add(entry.path)
  }
  return normalized
}
