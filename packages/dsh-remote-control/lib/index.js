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

import Schema from '@deepseek-ai/schemastery'
import { createHash } from 'node:crypto'
import { homedir, hostname, platform, release } from 'node:os'
import { RelayAuthError, RelayClient, RelayUnreachableError } from './client.js'
import { DEFAULT_CONFIG, resolveConfig } from './config.js'
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

/** Configuration schema, doubles as the documented key list. */
export const Config = Schema.object({
  /** Absolute base URL of the relay, e.g. `https://icyu.online/harness`. */
  relayUrl: Schema.string().required(),
  /** Token this node presents to the relay; the relay's `DSH_REMOTE_AGENT_TOKEN`. */
  nodeToken: Schema.string().required(),
  /** Stable identity for this installation. Derived from the host name by default. */
  nodeId: Schema.string().default(DEFAULT_CONFIG.nodeId),
  /** Display name on the control page. Defaults to the host name. */
  displayName: Schema.string().default(DEFAULT_CONFIG.displayName),
  /**
   * Workbenches this node offers. Accepts `- ~/Desktop/project` or
   * `- { name: project, path: ~/Desktop/project }`.
   */
  workspaces: Schema.array(Schema.any()).default([]),
  /** Agent preset remote sessions are composed from. */
  agentPreset: Schema.string().default(DEFAULT_CONFIG.agentPreset),
  /**
   * Permission preset pinned onto every remote session. The shipped
   * `workspace-write` bundles the `workspace-write` sandbox with the `ask`
   * approval policy, so anything outside the workspace stops and waits for a
   * human at this machine.
   */
  permissionPreset: Schema.string().default(DEFAULT_CONFIG.permissionPreset),
  /** Reconnect delay after a failed exchange, doubled up to the cap. */
  reconnectMinMs: Schema.number().default(DEFAULT_CONFIG.reconnectMinMs),
  reconnectMaxMs: Schema.number().default(DEFAULT_CONFIG.reconnectMaxMs),
  /** Set false to validate configuration and log the verdict without connecting. */
  enabled: Schema.boolean().default(DEFAULT_CONFIG.enabled)
})

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
export function apply(ctx, config) {
  const logger = ctx.logger
  let resolved
  try {
    resolved = resolveConfig(config)
  } catch (error) {
    report(logger, 'error', error.message)
    return
  }
  let workspaces
  try {
    workspaces = normalizeWorkspaces(resolved.workspaces)
  } catch (error) {
    report(logger, 'error', error.message)
    return
  }

  const identity = {
    nodeId: resolved.nodeId === '' ? deriveNodeId() : resolved.nodeId,
    name: resolved.displayName === '' ? hostname() : resolved.displayName,
    platform: `${platform()} ${release()}`,
    version: 'dsh-remote-control/0.1.0',
    workspaces
  }

  let client
  try {
    client = new RelayClient({ relayUrl: resolved.relayUrl, nodeToken: resolved.nodeToken, logger })
  } catch (error) {
    report(logger, 'error', error.message)
    return
  }

  if (!resolved.enabled) {
    report(
      logger,
      'info',
      `disabled by configuration (node "${identity.nodeId}", ${String(workspaces.length)} workspace(s), relay ${client.baseUrl})`
    )
    return
  }
  if (workspaces.length === 0) {
    report(logger, 'warn', 'no workspaces configured; this node will register but offer nothing to run in')
  }

  /** @type {RemoteRunner|undefined} */
  let runner
  /** @type {AbortController|undefined} */
  let lifetime

  ctx.inject(REQUIRED_SERVICES, (scoped) => {
    const controller = new AbortController()
    lifetime = controller
    const nodeConfig = { ...resolved, ...identity, workspaces }
    runner = new RemoteRunner({ ctx: scoped, config: nodeConfig, logger })

    /**
     * Advertise, then poll until disposed.
     *
     * Failures never propagate out of this loop: an unreachable relay is an
     * ordinary condition (a laptop on a train, a relay restart), so the node
     * backs off and keeps trying while the rest of the Harness is unaffected.
     *
     * @returns {Promise<void>} resolves when the node is disposed.
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
            report(
              logger,
              'info',
              `node "${identity.nodeId}" (${identity.name}) → ${client.baseUrl}, ` +
                `${String(runner.workspaces().length)} workspace(s), preset ${resolved.agentPreset}, ` +
                `permission ${resolved.permissionPreset}`
            )
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
            report(logger, 'error', `${error.message}; correct nodeToken and restart the backend`)
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

    run().catch((error) => {
      report(logger, 'error', `poll loop rejected: ${error?.message ?? error}`)
    })

    // Both lifetimes are wired: the injection's own disposer stops the loop, and
    // the outer one disposes the agents it created. Splitting them matters
    // because the Harness keeps a session alive after the node stops polling.
    scoped.effect(() => () => controller.abort())
    ctx.effect(() => () => {
      controller.abort()
      return runner.dispose()
    })
  })
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
 * Derive a stable node id from the machine's host name and home directory.
 *
 * The hash keeps the id opaque and ASCII-safe, while staying stable across
 * restarts so the control page keeps the same entry. Two machines sharing a host
 * name would collide; `nodeId` exists for exactly that case.
 *
 * @returns {string} a stable, URL-safe node id.
 */
export function deriveNodeId() {
  const seed = `${hostname()}:${homedir()}`
  return `node-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
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
