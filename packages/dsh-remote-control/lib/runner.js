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
 * Reply extraction follows `dsh-headless`: walk the session log from the
 * sequence captured just before the prompt, keep the last non-empty
 * `assistant/message` text, and read the `turn/end` reason. That is more robust
 * than watching the live stream, because it survives retries and reports exactly
 * what was committed to durable history.
 *
 * @module dsh-remote-control/runner
 */

import { createRequire } from 'node:module'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'

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
 * @param {object} session - live Session.
 * @param {number} firstSeq - log length captured before the prompt.
 * @param {Function} SessionSeq - the branded-sequence constructor.
 * @returns {{ text: string, reason: object|undefined }} last text and turn outcome.
 */
export function summarizeTurn(session, firstSeq, SessionSeq) {
  let started = false
  let text = ''
  let reason
  const length = session.seq
  for (let seq = firstSeq; seq < length; seq += 1) {
    const event = session.eventAt(SessionSeq(seq))
    if (event === undefined) continue
    if (event.type === 'turn/start') {
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
    if (event.type === 'turn/end') reason = event.data?.reason
  }
  return { text, reason }
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
 * The engine that turns relay commands into live Harness sessions.
 *
 * One instance per node. It holds the live agents it created so a follow-up can
 * continue the same conversation, and disposes them on shutdown so a plugin
 * unload does not leak running loops.
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
  constructor({ ctx, config, logger, workspaceProvider }) {
    this.ctx = ctx
    this.config = config
    this.logger = logger
    /** Registry mode: returns the live list, or undefined for the configured one. */
    this.workspaceProvider = workspaceProvider
    /** @type {Map<string, { handle: object, workspacePath: string }>} */
    this.sessions = new Map()
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
   * Resolve a relay-supplied workspace path against what this node advertises.
   *
   * Refusing anything not advertised is the whole point of the allow-list: the
   * relay is a separate trust domain, so a compromised or buggy relay must not be
   * able to name `/etc` as a workspace and have the node comply.
   *
   * @param {string} requested - path from the command.
   * @returns {string} the advertised absolute path.
   * @throws {Error} when the path is not advertised.
   */
  resolveWorkspace(requested) {
    const advertised = this.workspaces()
    const match = advertised.find((entry) => entry.path === requested)
    if (match === undefined) {
      const known = advertised.map((entry) => entry.path).join(', ') || '(none configured)'
      throw new Error(`workspace ${JSON.stringify(requested)} is not advertised by this node; known: ${known}`)
    }
    return match.path
  }

  /**
   * Run one relay command and return the transcript-shaped outcome.
   *
   * @param {object} command - `{ commandId, workspace, prompt, sessionId? }`.
   * @returns {Promise<object>} `{ ok, text?, error?, sessionId?, workspace, prompt, durationMs }`.
   */
  async run(command) {
    const started = Date.now()
    const base = {
      commandId: command.commandId,
      prompt: typeof command.prompt === 'string' ? command.prompt : '',
      workspace: typeof command.workspace === 'string' ? command.workspace : '',
      nodeId: this.config.nodeId
    }
    try {
      const prompt = typeof command.prompt === 'string' ? command.prompt.trim() : ''
      if (prompt === '') throw new Error('prompt is empty')
      const workspacePath = this.resolveWorkspace(command.workspace)
      const existing = typeof command.sessionId === 'string' ? this.sessions.get(command.sessionId) : undefined
      const outcome = existing === undefined
        ? await this.startConversation(workspacePath, prompt)
        : await this.continueConversation(existing, prompt)
      return { ...base, ok: true, sessionId: outcome.sessionId, text: outcome.text, durationMs: Date.now() - started }
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
   * @returns {Promise<{ sessionId: string, text: string }>} the answer.
   */
  async startConversation(workspacePath, prompt) {
    const { brandString } = await helpers()
    const preset = await this.ctx.agentPresets.resolve(this.config.agentPreset)
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
      this.applyPermission(handle, this.config.permissionPreset)
      this.title(handle, prompt)
      this.sessions.set(sessionId, { handle, workspacePath: workspace.path })
    } catch (error) {
      if (attached) await workspace.detachSession(sessionId).catch(() => {})
      await handle.dispose().catch(() => {})
      throw error
    }
    const text = await this.ask(handle, prompt)
    return { sessionId, text }
  }

  /**
   * Ask a follow-up on a session this node created earlier.
   *
   * @param {{ handle: object, workspacePath: string }} entry - live session entry.
   * @param {string} prompt - the follow-up question.
   * @returns {Promise<{ sessionId: string, text: string }>} the answer.
   */
  async continueConversation(entry, prompt) {
    const sessionId = entry.handle.agent.session.id
    const text = await this.ask(entry.handle, prompt)
    return { sessionId, text }
  }

  /**
   * Admit one prompt and wait for the whole agent to reach quiescence.
   *
   * @param {object} handle - AgentHandle.
   * @param {string} prompt - the question.
   * @returns {Promise<string>} the final assistant text.
   */
  async ask(handle, prompt) {
    const { createUserMessage, SessionSeq } = await helpers()
    const agent = handle.agent
    await agent.whenIdle()
    const firstSeq = agent.session.seq
    agent.followup(createUserMessage({ content: [{ type: 'text', text: prompt }], source: { kind: 'user' } }))
    await agent.whenIdle()
    await this.flush(agent.session)
    const { text, reason } = summarizeTurn(agent.session, firstSeq, SessionSeq)
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
   * this whole design exists to prevent.
   *
   * @param {object} handle - AgentHandle.
   * @param {string} presetName - configured preset id.
   */
  applyPermission(handle, presetName) {
    this.ctx.permissionPresets.set(handle.agent.session, presetName)
  }

  /**
   * Name the session after its first question so the local GUI is readable.
   *
   * @param {object} handle - AgentHandle.
   * @param {string} prompt - the first question.
   */
  title(handle, prompt) {
    try {
      const line = prompt.replace(/\s+/g, ' ').trim().slice(0, 60)
      this.ctx.sessionTitle?.rename?.(handle.agent.session, line === '' ? 'remote question' : line)
    } catch (error) {
      this.logger?.warn?.(`dsh-remote-control: could not title session: ${error.message}`)
    }
  }

  /**
   * Dispose every session this node created.
   *
   * @returns {Promise<void>} resolves once disposal settled.
   */
  async dispose() {
    this.disposed = true
    const entries = [...this.sessions.values()]
    this.sessions.clear()
    for (const entry of entries) {
      await entry.handle.dispose().catch((error) => {
        this.logger?.warn?.(`dsh-remote-control: disposing a session failed: ${error.message}`)
      })
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
