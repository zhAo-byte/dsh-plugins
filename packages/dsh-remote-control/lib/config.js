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
 * @module dsh-remote-control/config
 */

/**
 * The defaults, in one place.
 *
 * The schema and the resolver must agree on every default; keeping two copies is
 * how a key ends up documented as `standard` while the code falls back to
 * something else. Both read this object.
 */
export const DEFAULT_CONFIG = Object.freeze({
  nodeId: '',
  displayName: '',
  workspaces: Object.freeze([]),
  agentPreset: 'standard',
  permissionPreset: 'workspace-write',
  reconnectMinMs: 2_000,
  reconnectMaxMs: 60_000,
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
  return {
    relayUrl,
    nodeToken,
    nodeId: stringOr(source.nodeId, DEFAULT_CONFIG.nodeId),
    displayName: stringOr(source.displayName, DEFAULT_CONFIG.displayName),
    workspaces: Array.isArray(source.workspaces) ? source.workspaces : [...DEFAULT_CONFIG.workspaces],
    agentPreset: stringOr(source.agentPreset, DEFAULT_CONFIG.agentPreset),
    permissionPreset: stringOr(source.permissionPreset, DEFAULT_CONFIG.permissionPreset),
    reconnectMinMs: numberOr(source.reconnectMinMs, DEFAULT_CONFIG.reconnectMinMs),
    reconnectMaxMs: numberOr(source.reconnectMaxMs, DEFAULT_CONFIG.reconnectMaxMs),
    // Absent means enabled: a row that ships disabled unless you opt in would be
    // the more surprising default for a plugin you installed on purpose.
    enabled: source.enabled !== false
  }
}
