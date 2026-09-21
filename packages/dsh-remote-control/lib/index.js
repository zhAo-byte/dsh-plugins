/**
 * `dsh-remote-control` — the node half.
 *
 * One row per Harness installation. It advertises this machine to a relay, parks
 * a long-poll for work, and runs whatever arrives as an ordinary local session.
 * A second machine running the same row appears in the same roster, which is the
 * whole point: the relay is the only thing that has to be reachable, so any
 * number of NATed macOS or Windows boxes can be driven from one page.
 *
 * Two properties are deliberate and worth stating where they are implemented:
 *
 * 1. **Outbound only.** This row never listens on a socket. Nothing about the
 *    deployment requires a public IP, a port forward, or relaxing DSH's own
 *    loopback-only web posture — the `--host 0.0.0.0` guard is left alone on
 *    purpose, because it exists to keep the RPC surface off the network.
 * 2. **The relay is not trusted.** It can name only workspaces this node
 *    advertises, it cannot carry approvals, and the permission preset is pinned
 *    here rather than accepted from the wire. A compromised relay can ask
 *    questions; it cannot widen its own authority.
 *
 * @module dsh-remote-control
 */

import { hostname, platform, release } from 'node:os'
import { RelayAuthError, RelayClient, RelayUnreachableError } from './client.js'
import { deriveNodeId, resolveConfig } from './config.js'
import { RemoteQuestionBridge } from './questions.js'
import { RemoteRunner, normalizeWorkspaces } from './runner.js'

/** Cordis plugin name; also the id used in a profile patch. */
export const name = 'dsh-remote-control'

/**
 * Turn the resolved configuration's guest keys into the posture the runner takes.
 *
 * Two checks live here rather than in the resolver, because both need the
 * *normalized* owner list that only `prepare()` has:
 *
 * - an open door with no directory behind it is a configuration mistake;
 * - with an explicit owner list, a guest directory must be one of them. This is
 *   the invariant that makes "guests can only reach what the operator already
 *   granted" checkable by reading two lists, instead of depending on the relay
 *   being well behaved. In registry mode there is no fixed owner list to compare
 *   against, so the runtime intersection in `RemoteRunner.guestWorkspaces` is the
 *   enforcement point instead.
 *
 * **A mistake closes the door; it does not stop the node.** Throwing here would
 * take the operator's own remote control down because of a key about guests —
 * a strictly worse outcome than a door that stayed shut, and one that arrives
 * through a settings card where the two keys sit side by side. So the failure is
 * returned as `problem`, the caller logs it at error level, and the door is
 * reported to the relay as closed. Silence would be the bad version: an operator
 * who typed `guestEnabled: true` must be able to tell that nothing opened.
 *
 * Exported because the subset rule is the security property, and it is testable
 * without a Harness — `tools/node-check.mjs` drives it directly.
 *
 * @param {object} resolved - output of `resolveConfig`.
 * @param {Array<{ name: string, path: string }>} ownerWorkspaces - normalized owner list.
 * @returns {{ guest: object, problem?: string }} the posture, and why the door stayed shut.
 */
export function prepareGuest(resolved, ownerWorkspaces) {
  const guest = resolved.guest
  const closed = { ...guest, enabled: false, workspaces: [] }
  if (guest.enabled !== true) return { guest: closed }
  let workspaces
  try {
    workspaces = normalizeWorkspaces(guest.workspaces)
  } catch (error) {
    return { guest: closed, problem: `the guest door stays closed: ${error.message}` }
  }
  if (workspaces.length === 0) {
    return {
      guest: closed,
      problem: 'the guest door stays closed: guestEnabled is true but guestWorkspaces is empty, so guests would have nothing to run in'
    }
  }
  if (!resolved.registryMode) {
    const owner = new Set(ownerWorkspaces.map((entry) => entry.path))
    const outside = workspaces.find((entry) => !owner.has(entry.path))
    if (outside !== undefined) {
      return {
        guest: closed,
        problem:
          `the guest door stays closed: guest workspace ${JSON.stringify(outside.path)} is not one of this node's workspaces; ` +
          'guestWorkspaces must be a subset of workspaces'
      }
    }
  }
  return { guest: { ...guest, workspaces } }
}

/**
 * Check that a guest turn's two preset names actually resolve, and say so if not.
 *
 * Both failures are otherwise invisible until a stranger's first question fails,
 * which is the worst place to discover a typo: the relay page shows a generic
 * error and nothing on the machine records why. The permission preset is only
 * checked when the service exposes `resolve`, because a deployment that removed
 * it would otherwise look like a configuration error rather than a version skew.
 *
 * @param {object} scoped - context carrying `agentPresets` and `permissionPresets`.
 * @param {object} guest - the resolved guest posture.
 * @param {object} logger - Cordis logger, possibly absent.
 * @returns {Promise<void>} resolves once both checks were reported.
 */
async function preflightGuestPosture(scoped, guest, logger) {
  try {
    await scoped.agentPresets.resolve(guest.agentPreset)
  } catch (error) {
    report(
      logger,
      'error',
      `guest agent preset ${JSON.stringify(guest.agentPreset)} does not resolve (${error?.message ?? error}); ` +
        'every guest turn will fail until it is installed'
    )
  }
  const presets = typeof scoped.get === 'function' ? scoped.get('permissionPresets') : undefined
  if (presets === undefined || typeof presets.resolve !== 'function') return
  try {
    presets.resolve(guest.permissionPreset)
  } catch (error) {
    report(
      logger,
      'error',
      `guest permission preset ${JSON.stringify(guest.permissionPreset)} does not resolve (${error?.message ?? error}); ` +
        'every guest turn will fail until it is added to the permission preset table'
    )
  }
}

/**
 * Services the node needs before it may start.
 *
 * These are declared for `ctx.inject` rather than as a plugin-level `inject` on
 * purpose: the plugin should still *load* — and say why it cannot work — in a
 * composition that lacks them, instead of silently vanishing from the tree.
 *
 * `agentDefaultModel` is in the list because a remotely created session has no
 * one else to pick its route: the persona every preset carries renders
 * `{{model}}` strictly, so an Agent published without a provider/model cannot
 * assemble its first prompt. See `RemoteRunner.startConversation`.
 */
export const REQUIRED_SERVICES = ['agents', 'agentPresets', 'agentDefaultModel', 'permissionPresets', 'workspaceRegistry']

// There is deliberately no `Config` schema here.
//
// One used to live at this spot, and it was a static import of
// `@deepseek-ai/schemastery` — a peer dependency — at the top of the entry
// point. That made the module impossible to load wherever the package was not
// installed, which broke every check and every non-Harness context, while nothing
// actually read the schema: the defaults and validation that take effect are in
// `config.js`. The accepted keys are documented there instead. If a schema is
// ever genuinely needed, import it lazily inside a function.

/**
 * Mount the node.
 *
 * A configuration mistake is reported and the row becomes a no-op rather than
 * throwing: a plugin that crashes the whole profile because a URL had a typo
 * would take the local GUI down with it, which is a strictly worse outcome than
 * a node that never connects.
 *
 * @param {object} ctx - Cordis context.
 * @param {object} config - validated plugin configuration.
 */
export async function apply(ctx, config) {
  const logger = ctx.logger

  // ── the agent presets this package ships ─────────────────────────────────
  //
  // Installing the plugin has to install the agent it needs, or guest mode
  // arrives broken: DSH cannot fetch a preset from a package (the preset root
  // takes a path), so the snapshot in `presets/` is written into the DSH home
  // here. This runs before the node starts because the first guest turn is
  // exactly what would otherwise fail, on a public page, with a preset-resolution
  // error nobody can act on.
  //
  // It is deliberately allowed to fail softly. A read-only home, a permissions
  // problem, or a preset the operator installed by hand are all ordinary
  // conditions, and none of them justifies a backend that will not load.
  // `lib/presets.js` owns the rules — notably that a directory without this
  // plugin's stamp is never touched.
  if (config?.installBundledPresets !== false) {
    try {
      const { ensureBundledPresets } = await import('./presets.js')
      for (const entry of await ensureBundledPresets()) {
        if (entry.action === 'current') continue
        report(logger, entry.action === 'failed' ? 'warn' : 'info', `agent preset "${entry.id}": ${entry.detail}`)
      }
    } catch (error) {
      report(
        logger,
        'warn',
        `the bundled agent presets could not be installed (${error?.message ?? error}); ` +
          'guest mode needs its agent preset present under $DSH_HOME/.agent-presets'
      )
    }
  }

  /**
   * The settings schema, resolved before anything installs it.
   *
   * `installSection` registers a namespace as an *effect on the calling fiber*, so
   * it has to run synchronously inside the injection callback. Reaching it through
   * an `await import()` in that callback failed with "cannot create effect on
   * inactive context" — the fiber had already settled. Loading the schema here,
   * once, keeps the module top level free of the peer dependency while still
   * letting the registration happen where it must.
   *
   * @type {object|undefined}
   */
  let settingsSchema
  try {
    const { loadSchema } = await import('./settings-schema.js')
    settingsSchema = await loadSchema()
  } catch (error) {
    settingsSchema = undefined
    report(logger, 'warn', `settings are not editable from the GUI (${error?.message ?? error}); the YAML configuration still applies`)
  }

  /**
   * Where the live configuration comes from.
   *
   * Starts at the composed YAML entry, and is replaced by the settings scope once
   * that service installs the namespace — which is what makes a GUI edit take
   * effect without restarting the backend. Per plugin instance, so two rows in one
   * tree cannot fight over it.
   *
   * @type {() => object}
   */
  let currentSource = () => config
  /** A prepared configuration waiting for the Harness services to come up. */
  let pending

  /**
   * Every question bridge that currently owns a running node.
   *
   * A set rather than a single value because [`applyConfig`] builds the
   * replacement before the predecessor has finished stopping, and a question
   * arriving in that window has to be answerable by whichever node owns the
   * session that asked it.
   *
   * @type {Set<RemoteQuestionBridge>}
   */
  const liveQuestions = new Set()

  /**
   * Turn one raw configuration object into everything a node needs, or an error.
   *
   * Split out because it now runs more than once: on the YAML configuration at
   * load, and again on every committed settings change.
   *
   * @param {object} raw - raw configuration.
   * @returns {{ resolved: object, workspaces: Array<object>, identity: object } | { error: string }} the prepared node inputs.
   */
  const prepare = (raw) => {
    let resolved
    try {
      resolved = resolveConfig(raw)
    } catch (error) {
      return { error: error.message }
    }
    let workspaces
    let preparedGuest
    try {
      workspaces = normalizeWorkspaces(resolved.workspaces)
      preparedGuest = prepareGuest(resolved, workspaces)
    } catch (error) {
      return { error: error.message }
    }
    return {
      resolved,
      workspaces,
      guest: preparedGuest.guest,
      ...(preparedGuest.problem === undefined ? {} : { guestProblem: preparedGuest.problem }),
      identity: {
        nodeId: resolved.nodeId === '' ? deriveNodeId() : resolved.nodeId,
        name: resolved.displayName === '' ? hostname() : resolved.displayName,
        platform: `${platform()} ${release()}`,
        version: 'dsh-remote-control/0.1.0',
        workspaces
      }
    }
  }

  /**
   * Read this machine's workspaces out of the DSH registry, in registry mode.
   *
   * `registry` mode exists because the explicit list has to be maintained by hand,
   * and the failure mode of forgetting is invisible: a directory the relay cannot
   * name simply never appears on the page, with nothing saying why. Mirroring the
   * registry means the page shows exactly the workspaces this machine has actually
   * used.
   *
   * The trade is deliberate and worth stating where it is implemented: the set the
   * relay may name is then decided by *which sessions exist*, not by an explicit
   * grant. Anything opened in the local GUI becomes remotely reachable. That is why
   * it is opt-in, and why the node logs the mode it is in on every connection.
   *
   * Read fresh on every call rather than cached: `workspaces()` is consulted for
   * each advertisement and each command, so a workspace created after boot becomes
   * usable immediately, and one deleted locally stops being offered.
   *
   * @param {object} scoped - context carrying `workspaceRegistry`.
   * @returns {() => Array<{ name: string, path: string }>} the provider.
   */
  const registryWorkspaceProvider = (scoped) => () => {
    const registry = scoped.get('workspaceRegistry')
    if (registry === undefined || typeof registry.list !== 'function') return []
    return registry
      .list()
      .map((entity) => ({
        // The GUI's own title, so the page and the sidebar agree on names.
        name: typeof entity.title === 'string' && entity.title.trim() !== '' ? entity.title : entity.path,
        path: entity.path
      }))
      .filter((entry) => typeof entry.path === 'string' && entry.path !== '')
  }

  /**
   * Stop the running node, if any.
   *
   * Awaitable so a rebuild cannot race its predecessor: the old poll loop is
   * aborted *and* the sessions it started are disposed before the next node
   * advertises the same identity.
   *
   * @returns {Promise<void>} resolves once the node is fully stopped.
   */
  let stopCurrent = async () => {}

  /**
   * Build and start a node from one prepared configuration.
   *
   * @param {{ resolved: object, workspaces: Array<object>, identity: object }} prepared - output of `prepare`.
   * @param {object} scoped - context carrying the Harness services the runner needs.
   */
  const start = (prepared, scoped) => {
    const { resolved, identity, guest } = prepared
    // Reported before anything else: the door stayed shut because of a mistake, and
    // that has to be said on every (re)start rather than only at load — a settings
    // edit is the most likely way to make it happen.
    if (prepared.guestProblem !== undefined) report(logger, 'error', prepared.guestProblem)
    // In registry mode the configured list is ignored and the live registry is the
    // authority. `identity.workspaces` is only ever the startup snapshot used for
    // the announcement; the runner re-reads so the advertised set stays current.
    //
    // The guest list is not mirrored, in either mode: guests get the explicit
    // directories the operator named, intersected at read time with the operator's
    // live set. Registry mode therefore widens the operator's reachable set
    // without ever widening a guest's.
    const workspaceProvider = resolved.registryMode ? registryWorkspaceProvider(scoped) : undefined
    const workspaces = workspaceProvider === undefined ? prepared.workspaces : workspaceProvider()
    const controller = new AbortController()
    const client = new RelayClient({ relayUrl: resolved.relayUrl, nodeToken: resolved.nodeToken, logger })
    const questions = new RemoteQuestionBridge({
      client,
      nodeId: identity.nodeId,
      logger,
      timeoutMs: resolved.questionTimeoutMs
    })
    const runner = new RemoteRunner({
      ctx: scoped,
      config: { ...resolved, ...identity, workspaces, guest },
      logger,
      questions,
      ...(workspaceProvider === undefined ? {} : { workspaceProvider })
    })
    liveQuestions.add(questions)

    /**
     * What the relay may know about the guest door.
     *
     * The relay needs the list to refuse a guest command for a directory this node
     * never opened, and the page needs it to render the choice. It carries the two
     * preset names as well, so the page can say what a guest turn will actually run
     * as rather than describing a posture the node might not use.
     *
     * Sent on every hello, including when the door is shut: a node that was
     * reconfigured has to be able to *close* a door the relay still remembers.
     *
     * @returns {object} the advertisement.
     */
    const guestAdvertisement = () => ({
      enabled: guest.enabled,
      agentPreset: guest.agentPreset,
      permissionPreset: guest.permissionPreset,
      workspaces: runner.guestWorkspaces()
    })

    /**
     * Execute one command and report its outcome.
     *
     * @param {object} command - relay command envelope.
     * @returns {Promise<void>} resolves after the report was attempted.
     */
    const handleCommand = async (command) => {
      const label = typeof command.prompt === 'string' ? command.prompt.replace(/\s+/g, ' ').slice(0, 70) : ''
      logger?.info?.(`dsh-remote-control: running ${command.commandId} in ${command.workspace}`)
      await client.reportQuietly({
        nodeId: identity.nodeId,
        status: 'busy',
        detail: label === '' ? 'running a remote turn' : label
      })
      const result = await runner.run(command)
      if (result.ok) {
        logger?.info?.(`dsh-remote-control: ${command.commandId} finished in ${String(result.durationMs)}ms`)
      } else {
        logger?.warn?.(`dsh-remote-control: ${command.commandId} failed: ${result.error}`)
      }
      await client.reportQuietly({
        nodeId: identity.nodeId,
        status: 'idle',
        detail: '',
        commandId: command.commandId,
        result
      })
    }

    /**
     * Advertise, then poll until aborted.
     *
     * Failures never propagate out of this loop: an unreachable relay is an
     * ordinary condition (a laptop on a train, a relay restart), so the node backs
     * off and keeps trying while the rest of the Harness is unaffected.
     *
     * @returns {Promise<void>} resolves when the node is stopped.
     */
    const run = async () => {
      let pollHoldMs = 25_000
      let delay = resolved.reconnectMinMs
      let announced = false
      while (!controller.signal.aborted) {
        try {
          const ack = await client.hello({ ...identity, workspaces: runner.workspaces(), guest: guestAdvertisement() })
          if (typeof ack.pollHoldMs === 'number' && ack.pollHoldMs > 0) pollHoldMs = ack.pollHoldMs
          if (!announced) {
            const advertised = runner.workspaces()
            report(
              logger,
              'info',
              `node "${identity.nodeId}" (${identity.name}) → ${client.baseUrl}, ` +
                `${String(advertised.length)} workspace(s), preset ${resolved.agentPreset}, ` +
                `permission ${resolved.permissionPreset}, ` +
                `guest ${guest.enabled ? `on (${String(runner.guestWorkspaces().length)} workspace(s), preset ${guest.agentPreset})` : 'off'}, ` +
                `workspaces from ${resolved.registryMode ? 'the DSH registry' : 'the configured list'}`
            )
            if (resolved.registryMode) {
              // The mode decides what the relay is allowed to name, so it is stated
              // rather than left to be inferred from a config file.
              report(
                logger,
                'warn',
                `registry mode: any directory this machine opens a session in becomes remotely reachable — ${advertised
                  .map((entry) => entry.path)
                  .join(', ')}`
              )
            }
            if (guest.enabled) {
              // An open door is worth a line in the log every time the node
              // connects: the operator's exposure should never depend on them
              // remembering which YAML key they set months ago.
              report(
                logger,
                'warn',
                `guest mode: anyone who opens the relay's /guest page may run the "${guest.agentPreset}" agent ` +
                  `(permission ${guest.permissionPreset}) in ${runner
                    .guestWorkspaces()
                    .map((entry) => entry.path)
                    .join(', ')}`
              )
            }
            announced = true
          } else {
            report(logger, 'info', `reconnected to ${client.baseUrl} as "${identity.nodeId}"`)
          }
          delay = resolved.reconnectMinMs
          while (!controller.signal.aborted) {
            const command = await client.poll({ nodeId: identity.nodeId, idle: true }, pollHoldMs, controller.signal)
            if (command === null) continue
            await handleCommand(command)
          }
        } catch (error) {
          if (controller.signal.aborted) return
          if (error instanceof RelayAuthError) {
            report(
              logger,
              'error',
              `${error.message}; correct the node token (Settings → Plugins → Remote control) and it will reconnect`
            )
            return
          }
          if (!(error instanceof RelayUnreachableError)) {
            report(logger, 'error', `poll loop stopped unexpectedly: ${error?.stack ?? error}`)
            return
          }
          logger?.warn?.(`dsh-remote-control: ${error.message}; retrying in ${String(Math.round(delay / 1000))}s`)
          await sleep(delay, controller.signal)
          delay = Math.min(Math.round(delay * 2), resolved.reconnectMaxMs)
        }
      }
    }

    if (!resolved.enabled) {
      report(
        logger,
        'info',
        `disabled (node "${identity.nodeId}", ${String(workspaces.length)} workspace(s), ` +
          `guest ${guest.enabled ? 'on' : 'off'}, relay ${client.baseUrl})`
      )
      // Nothing will run, so nothing may answer: leaving the bridge live would
      // make a disabled node claim every question of every session it ever
      // created — and it creates none.
      liveQuestions.delete(questions)
      stopCurrent = async () => {}
      return
    }
    if (workspaces.length === 0) {
      report(logger, 'warn', 'no workspaces configured; this node will register but offer nothing to run in')
    }
    if (guest.enabled) {
      // The guest posture names two presets that the operator does not type in the
      // common case; both are checked once here so a missing agent preset is a line
      // in the log rather than a failure on a public page. Not awaited: resolving a
      // preset must not delay the node from connecting.
      void preflightGuestPosture(scoped, guest, logger)
    }

    run().catch((error) => {
      report(logger, 'error', `poll loop rejected: ${error?.message ?? error}`)
    })

    stopCurrent = async () => {
      controller.abort()
      // Retire the bridge before disposing sessions: a question arriving during
      // teardown must fall through to the local GUI, not wait for a page whose
      // node is gone.
      liveQuestions.delete(questions)
      await runner.dispose()
    }
  }

  /** The services the runner needs; declared here so the plugin still loads without them. */
  let scopedContext

  /**
   * Apply one configuration object, replacing whatever is running.
   *
   * Ordering matters in two places, and both are deliberate:
   *
   * - `pending` is updated on *every* successful prepare, not only while the
   *   services are missing. The injection below starts from whatever
   *   `pending` holds, so leaving a stale value there would start the node with a
   *   configuration the operator had already replaced.
   * - teardown is sequenced with `then` before the replacement starts, so the old
   *   poll loop is aborted and its sessions disposed before the new node advertises
   *   the same identity. A rejection in teardown is reported rather than becoming
   *   an unhandled rejection, and the replacement still runs.
   *
   * @param {object} raw - raw configuration.
   */
  const applyConfig = (raw) => {
    const prepared = prepare(raw)
    if (prepared.error !== undefined) {
      report(logger, 'error', prepared.error)
      pending = undefined
      const previous = stopCurrent
      stopCurrent = async () => {}
      void previous().catch((error) => {
        report(logger, 'warn', `stopping the node failed: ${error?.message ?? error}`)
      })
      return
    }
    pending = prepared
    if (scopedContext === undefined) return
    const previous = stopCurrent
    stopCurrent = async () => {}
    void previous()
      .catch((error) => {
        report(logger, 'warn', `stopping the previous node failed: ${error?.message ?? error}`)
      })
      .then(() => start(prepared, scopedContext))
  }

  // ── the settings namespace, registered independently of the node ──────────
  //
  // This ordering is load-bearing. Registration used to happen inside the same
  // injection as starting the node, after `applyConfig(config)` — and because an
  // incomplete configuration returns early, a node with no token yet never
  // registered its namespace either. The configuration card therefore could not
  // appear, and the card is exactly how the operator supplies the missing token.
  // The deadlock was invisible for as long as the token was written into the YAML.
  //
  // So the namespace is installed from its own injection, which waits only on
  // `settings`. `installSection` packages the optional-service wiring, including
  // falling back to the composed entry when the service is absent.
  if (settingsSchema !== undefined) {
    ctx.inject(['settings'], (settingsCtx) => {
      // Synchronous on purpose: registration is a fiber effect, and creating one
      // from a later microtask failed with "cannot create effect on inactive context".
      try {
        settingsCtx.settings.installSection(ctx, 'remote-control', settingsSchema, config, {
          setSource: (source) => {
            // A GUI edit becomes both the live source and the trigger to reconfigure.
            currentSource = source
          },
          onChange: () => {
            applyConfig(currentSource())
          }
        })
      } catch (error) {
        report(
          logger,
          'warn',
          `settings are not editable from the GUI (${error?.message ?? error}); the YAML configuration still applies`
        )
      }
    })
  }

  // ── the question answerer, installed before any node starts ───────────────
  //
  // `prepend` is not an optimisation, it is the whole mechanism. Waterfall
  // listeners run in registration order, and `@deepseek-ai/dsh-api-remotes`
  // registers its forwarding listener while the backend composes — before this
  // plugin can possibly have run. Without `prepend`, the local GUI would take
  // over the composer and block, and the relay page would never see the
  // question; with it, the relay answers first and returns `next()` for every
  // question that is not one of ours, leaving local sessions untouched.
  //
  // The listener is registered from the plugin root rather than from a session's
  // own scope because it has to exist before the first session does. Ownership is
  // decided per event by the bridge instead, which is also what keeps a question
  // asked in the local GUI on the local GUI.
  ctx.on('user-questions/request', async (request, next) => {
    for (const bridge of liveQuestions) {
      if (!bridge.owns(request?.agent)) continue
      const answer = await bridge.answer(request)
      if (answer !== undefined) return answer
      break
    }
    return await next()
  }, { prepend: true })

  // Start from the composed configuration first, so a deployment that configures
  // the node in `cordis.patch.yml` behaves exactly as before and does not depend on
  // the settings service being present at all.
  applyConfig(config)

  ctx.inject(REQUIRED_SERVICES, (scoped) => {
    scopedContext = scoped
    // Re-apply now that the services exist; the settings watcher above is already
    // installed, so any later GUI edit reconfigures without a restart.
    if (pending !== undefined) start(pending, scoped)
  })

  // The outer lifetime owns the sessions: the Harness keeps a session alive after
  // the node stops polling, so disposal has to be explicit and last.
  ctx.effect(() => () => stopCurrent())
}

/**
 * Write one node line to both the Cordis logger and stderr.
 *
 * The web profile does not route `ctx.logger` to stdout, and the host captures
 * the backend's stderr into its app log — so a line that only used the logger
 * would be invisible exactly when a node is misconfigured.
 *
 * @param {object} logger - Cordis logger, possibly absent.
 * @param {'info'|'warn'|'error'} level - severity.
 * @param {string} message - line without the plugin prefix.
 */
function report(logger, level, message) {
  const line = `dsh-remote-control: ${message}`
  logger?.[level]?.(line)
  process.stderr.write(`${line}\n`)
}

/**
 * Sleep, but wake early when the node is shutting down.
 *
 * @param {number} ms - how long to wait.
 * @param {AbortSignal} signal - node lifetime.
 * @returns {Promise<void>} resolves after the wait or the abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(finish, ms)
    function finish() {
      clearTimeout(timer)
      signal.removeEventListener('abort', finish)
      resolve()
    }
    signal.addEventListener('abort', finish, { once: true })
  })
}

export { RelayAuthError, RelayUnreachableError } from './client.js'
export { RemoteRunner } from './runner.js'
