/**
 * Host half of `dsh-codex-bridge-client` — deliberately inert.
 *
 * A client bundle's package must still be a loadable host plugin: the Cordis
 * Loader imports this row on the backend, and `dsh-client-modules` composes the
 * browser bundle from the very same row. This package owns no host behavior, so
 * the host half exists only to give the Loader something importable to mount.
 *
 * @module dsh-codex-bridge-client
 */

/** Cordis plugin name. */
export const name = 'codex-bridge-client'

/** No host services: nothing here touches the backend. */
export const inject = []

/** Intentionally empty; the browser half does all the work. */
export function apply() {}
