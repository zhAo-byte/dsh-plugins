/**
 * The settings schema for `dsh-remote-control`.
 *
 * Kept out of the entry point on purpose. A schemastery schema is what the
 * settings service needs, but importing schemastery at the top of `lib/index.js`
 * is exactly the mistake that once made this plugin impossible to *load* wherever
 * the peer dependency was absent — a decorative schema that could stop the module
 * from loading, while nothing read it. So this module is the only place that
 * touches schemastery, and the entry point reaches it with a lazy `await import()`
 * inside `apply()`, where a missing package degrades to "settings are not
 * editable" instead of "the plugin does not exist".
 *
 * The schema is also the form contract: the Plugins → Plugin configuration card
 * renders from `ctx.settings.describe()`, so a key added here appears in the GUI
 * with no client-side change. That is the whole point of putting the
 * configuration here instead of in a YAML comment.
 *
 * @module dsh-remote-control/settings-schema
 */

/**
 * Build the schema.
 *
 * Deferred behind a function so importing this module has no side effects and the
 * caller controls when the peer dependency is resolved.
 *
 * @returns {Promise<object>} the schemastery schema for the `remote-control` namespace.
 */
export async function loadSchema() {
  const { default: Schema } = await import('@deepseek-ai/schemastery')
  return Schema.object({
    /** Absolute relay base URL; sub-path included, no trailing slash. */
    relayUrl: Schema.string().default(''),
    /**
     * The relay's `DSH_REMOTE_AGENT_TOKEN`.
     *
     * Left as an ordinary string rather than `role('secret')` deliberately. The
     * secret role stores the value through the credentials domain and keeps it out
     * of every wire response, which is what a token field should do — but the
     * settings-backed form only writes that domain through the client card's
     * credential path, and this plugin's card does not implement it yet. Marking
     * the field secret without that path would render a write-only input that
     * saves nothing, which is worse than being honest: the value lives in
     * `settings.yaml`, which is `0600`. The role is the follow-up.
     */
    nodeToken: Schema.string().default(''),
    /** Label on the control page. Empty means the machine's host name. */
    displayName: Schema.string().default(''),
    /**
     * Workbenches this node offers, as an allow-list.
     *
     * Both shapes the rest of the plugin accepts are declared here: a bare path
     * string, and `{ name, path }` for a custom label. Declaring only the string
     * form was a real defect rather than a simplification — the settings service
     * validates the composed configuration against this schema, so a deployment
     * that used the documented mapping form had its whole namespace rejected and
     * silently lost GUI configuration. The schema must describe what the code
     * accepts, not the subset the card happens to render.
     */
    workspaces: Schema.array(
      Schema.union([Schema.string(), Schema.object({ name: Schema.string(), path: Schema.string() })])
    ).default([]),
    /** Agent preset remote sessions are composed from. */
    agentPreset: Schema.string().default('standard'),
    /** Permission preset pinned onto every remote session. */
    permissionPreset: Schema.string().default('workspace-write'),
    /** Reconnect backoff bounds, in milliseconds. */
    reconnectMinMs: Schema.number().default(2_000),
    reconnectMaxMs: Schema.number().default(60_000),
    /** Turn the node off without uninstalling it. */
    enabled: Schema.boolean().default(true)
  })
}
