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
import { RemoteRunner, normalizeWorkspaces } from './runner.js'

/** Cordis plugin name; also the id used in a profile patch. */
export const name = 'dsh-remote-control'

/**
 * Services the node needs before it may start.
 *
 * These are declared for `ctx.inject` rather than as a plugin-level `inject` on
 * purpose: the plugin should still *load* — and say why it cannot work — in a
 * composition that lacks them, instead of silently vanishing from the tree.
 */
export const REQUIRED_SERVICES = ['agents', 'agentPresets', 'permissionPresets', 'workspaceRegistry']

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
    try {
      workspaces = normalizeWorkspaces(resolved.workspaces)
    } catch (error) {
      return { error: error.message }
    }
    return {
      resolved,
      workspaces,
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
    const { resolved, identity } = prepared
    // In registry mode the configured list is ignored and the live registry is the
    // authority. `identity.workspaces` is only ever the startup snapshot used for
    // the announcement; the runner re-reads so the advertised set stays current.
    const workspaceProvider = resolved.registryMode ? registryWorkspaceProvider(scoped) : undefined
    const workspaces = workspaceProvider === undefined ? prepared.workspaces : workspaceProvider()
    const controller = new AbortController()
    const client = new RelayClient({ relayUrl: resolved.relayUrl, nodeToken: resolved.nodeToken, logger })
    const runner = new RemoteRunner({
      ctx: scoped,
      config: { ...resolved, ...identity, workspaces },
      logger,
      ...(workspaceProvider === undefined ? {} : { workspaceProvider })
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
          const ack = await client.hello({ ...identity, workspaces: runner.workspaces() })
          if (typeof ack.pollHoldMs === 'number' && ack.pollHoldMs > 0) pollHoldMs = ack.pollHoldMs
          if (!announced) {
            const advertised = runner.workspaces()
            report(
              logger,
              'info',
              `node "${identity.nodeId}" (${identity.name}) → ${client.baseUrl}, ` +
                `${String(advertised.length)} workspace(s), preset ${resolved.agentPreset}, ` +
                `permission ${resolved.permissionPreset}, ` +
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
        `disabled (node "${identity.nodeId}", ${String(workspaces.length)} workspace(s), relay ${client.baseUrl})`
      )
      stopCurrent = async () => {}
      return
    }
    if (workspaces.length === 0) {
      report(logger, 'warn', 'no workspaces configured; this node will register but offer nothing to run in')
    }

    run().catch((error) => {
      report(logger, 'error', `poll loop rejected: ${error?.message ?? error}`)
    })

    stopCurrent = async () => {
      controller.abort()
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
