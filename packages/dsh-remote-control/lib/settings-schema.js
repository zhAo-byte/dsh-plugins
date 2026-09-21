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
     * Which workbenches this node offers. Two forms, and the schema accepts both
     * plus the registry sentinel, because the settings service validates the
     * *composed* configuration against this schema: a form the schema omits is a
     * form whose whole namespace gets rejected.
     *
     * - the array of bare path strings, or `{ name, path }` for custom labels;
     * - the literal string `'registry'`, which mirrors the DSH workspace registry
     *   instead of naming directories. In that mode the set the relay may name is
     *   decided by which sessions this machine has, not by an explicit grant — so
     *   anything opened locally becomes remotely reachable. Opt-in for that reason.
     */
    workspaces: Schema.union([
      Schema.string(),
      Schema.array(Schema.union([Schema.string(), Schema.object({ name: Schema.string(), path: Schema.string() })]))
    ]).default([]),
    /** Agent preset remote sessions are composed from. */
    agentPreset: Schema.string().default('standard'),
    /** Permission preset pinned onto every remote session. */
    permissionPreset: Schema.string().default('workspace-write'),
    /** Reconnect backoff bounds, in milliseconds. */
    reconnectMinMs: Schema.number().default(2_000),
    reconnectMaxMs: Schema.number().default(60_000),
    /**
     * How long a remote question waits for an answer on the relay page.
     *
     * It has to sit under the reverse proxy's read timeout: a longer wait than
     * the proxy allows is cut at the proxy, and the node sees a dead connection
     * rather than the clean fallback this timeout exists to provide.
     */
    questionTimeoutMs: Schema.number().default(300_000),
    /** Turn the node off without uninstalling it. */
    enabled: Schema.boolean().default(true),
    /**
     * Write the agent presets this package ships into `$DSH_HOME/.agent-presets`.
     *
     * On by default because the plugin's own guest mode runs the bundled
     * read-only `reader` agent, and a preset cannot be fetched from a package —
     * DSH's preset root takes a path. A directory this plugin did not install is
     * never overwritten; see `lib/presets.js`.
     */
    installBundledPresets: Schema.boolean().default(true),
    /**
     * Open the passwordless guest door on the relay.
     *
     * Defaults to off, and unlike `enabled` it needs an explicit `true` rather than
     * merely being present: this switch publishes an unauthenticated page that can
     * drive an agent on this machine, and "the field was there" is the wrong reason
     * for a door to open.
     */
    guestEnabled: Schema.boolean().default(false),
    /**
     * The directories a guest may name — the only ones.
     *
     * A subset of `workspaces` when that is an explicit list (enforced at load);
     * in registry mode this list is intersected with the live registry on every
     * read, so a guest never inherits the registry's "anything I opened" reach.
     */
    guestWorkspaces: Schema.array(Schema.union([Schema.string(), Schema.object({ name: Schema.string(), path: Schema.string() })])).default([]),
    /** Agent preset guest turns compose from. Defaults to the bundled read-only `reader`. */
    guestAgentPreset: Schema.string().default('reader'),
    /** Permission preset pinned onto every guest session. */
    guestPermissionPreset: Schema.string().default('read-only'),
    /** Longest guest question this node will run. */
    guestMaxPromptChars: Schema.number().default(8_000)
  })
}
