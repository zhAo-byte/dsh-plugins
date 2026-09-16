/**
 * Configuration resolution for the node half.
 *
 * This exists because of a specific failure mode, not for tidiness. A Loader row
 * may hand `apply()` a configuration object that has *not* been through the
 * schema — the schema documents the keys and rejects bad types when the Loader
 * validates, but nothing guarantees it ran. The first version of this plugin read
 * `config.nodeId.trim()` directly and therefore threw on the very first
 * undefined field, from inside the plugin's own setup, before it had registered
 * anything to log with. The observable symptom was a row that appeared in
 * `--dump-config`, loaded, and then simply never did anything: no roster entry,
 * no error, no clue.
 *
 * So every field is resolved here, once, with an explicit default, and a
 * genuinely invalid value (an empty or non-absolute URL) is raised as a clear
 * `TypeError` the caller can print. The plugin body then reads a complete object.
 *
 * **The accepted keys are documented here and nowhere else.** There used to be a
 * `@deepseek-ai/schemastery` schema in `index.js` describing them, which was a
 * mistake twice over: it was a static import of a peer dependency in the plugin
 * entry point, so any machine without that package present could not even *load*
 * the plugin; and nothing consumed it, because the defaults and validation that
 * actually take effect live in this file. A decorative schema that can stop the
 * module from loading is worse than no schema. If a real need for one appears, it
 * must be loaded lazily inside a function, never at module top level.
 *
 * | key | default | meaning |
 * | --- | --- | --- |
 * | `relayUrl` | required | absolute relay base URL, sub-path included, no trailing slash |
 * | `nodeToken` | required | the relay's `DSH_REMOTE_AGENT_TOKEN` |
 * | `nodeId` | hash of host name + home | stable identity; set only to break a collision |
 * | `displayName` | host name | label on the control page |
 * | `workspaces` | `[]` | allow-list; `'~/dir'` or `{ name, path }` |
 * | `agentPreset` | `standard` | agent preset remote sessions compose from |
 * | `permissionPreset` | `workspace-write` | pinned onto every remote session |
 * | `reconnectMinMs` / `reconnectMaxMs` | `2000` / `60000` | reconnect backoff bounds |
 * | `questionTimeoutMs` | `300000` | how long a remote question waits for the page before falling back to the local GUI |
 * | `enabled` | `true` | `false` validates and logs without connecting |
 *
 * @module dsh-remote-control/config
 */

import { createHash } from 'node:crypto'
import { homedir, hostname } from 'node:os'
import { isAbsolute, join } from 'node:path'

/**
 * The defaults, in one place.
 */
export const DEFAULT_CONFIG = Object.freeze({
  nodeId: '',
  displayName: '',
  workspaces: Object.freeze([]),
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  reconnectMinMs: 2_000,
  reconnectMaxMs: 60_000,
  // Five minutes is chosen to sit under the common reverse-proxy read timeout
  // (nginx defaults to 60s, the deployment sets 120s): a longer wait than the
  // proxy allows would be cut off there, and the node would report a relay
  // failure instead of the fallback this timeout exists to provide.
  questionTimeoutMs: 300_000,
  enabled: true
})

/**
 * Read one string field with a default.
 *
 * @param {unknown} value - raw value.
 * @param {string} fallback - value to use when unset or blank.
 * @returns {string} the resolved string.
 */
function stringOr(value, fallback) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : fallback
}

/**
 * Read one positive number with a default.
 *
 * @param {unknown} value - raw value.
 * @param {number} fallback - value to use when unset or unusable.
 * @returns {number} the resolved number.
 */
function numberOr(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

/**
 * The value that switches `workspaces` from an explicit list to the live registry.
 *
 * A sentinel rather than a boolean beside the list, because the two are mutually
 * exclusive: either you name the directories, or the node mirrors the ones this
 * machine has actually used. One key means there is no state where both are set
 * and the answer depends on which wins.
 */
export const REGISTRY_WORKSPACES = 'registry'

/**
 * Resolve a raw plugin configuration into a complete, validated shape.
 *
 * @param {object} [raw] - configuration as handed to `apply()`.
 * @returns {object} every field present and usable.
 * @throws {TypeError} when `relayUrl` or `nodeToken` is missing or unusable.
 */
export function resolveConfig(raw = {}) {
  const source = raw === null || typeof raw !== 'object' ? {} : raw
  const relayUrl = stringOr(source.relayUrl, '')
  if (relayUrl === '') throw new TypeError('relayUrl is required, e.g. https://icyu.online/harness')
  const nodeToken = stringOr(source.nodeToken, '')
  if (nodeToken === '') throw new TypeError("nodeToken is required; use the relay's DSH_REMOTE_AGENT_TOKEN")

  // `workspaces: registry` mirrors the DSH workspace registry; anything else must be
  // a list. The mode is carried as its own field so no caller has to re-sniff the
  // sentinel after resolution.
  const rawWorkspaces = source.workspaces
  const registryMode =
    typeof rawWorkspaces === 'string' && rawWorkspaces.trim().toLowerCase() === REGISTRY_WORKSPACES

  return {
    relayUrl,
    nodeToken,
    registryMode,
    nodeId: stringOr(source.nodeId, DEFAULT_CONFIG.nodeId),
    displayName: stringOr(source.displayName, DEFAULT_CONFIG.displayName),
    workspaces: registryMode
      ? []
      : Array.isArray(rawWorkspaces)
        ? rawWorkspaces
        : [...DEFAULT_CONFIG.workspaces],
    agentPreset: stringOr(source.agentPreset, DEFAULT_CONFIG.agentPreset),
    permissionPreset: stringOr(source.permissionPreset, DEFAULT_CONFIG.permissionPreset),
    reconnectMinMs: numberOr(source.reconnectMinMs, DEFAULT_CONFIG.reconnectMinMs),
    reconnectMaxMs: numberOr(source.reconnectMaxMs, DEFAULT_CONFIG.reconnectMaxMs),
    questionTimeoutMs: numberOr(source.questionTimeoutMs, DEFAULT_CONFIG.questionTimeoutMs),
    // Absent means enabled: a row that ships disabled unless you opt in would be
    // the more surprising default for a plugin you installed on purpose.
    enabled: source.enabled !== false
  }
}

/**
 * Derive a stable node id from the machine's host name and home directory.
 *
 * The hash keeps the id opaque and ASCII-safe, while staying stable across
 * restarts so the control page keeps the same entry. Two machines sharing a host
 * name would collide; an explicit `nodeId` exists for exactly that case.
 *
 * This lives here rather than in the entry point so that the identity rule can be
 * exercised without loading the plugin, which mounts against the Harness.
 *
 * @returns {string} a stable, URL-safe node id.
 */
export function deriveNodeId() {
  const seed = `${hostname()}:${homedir()}`
  return `node-${createHash('sha256').update(seed).digest('hex').slice(0, 12)}`
}
