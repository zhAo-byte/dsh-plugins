/**
 * Host half of `dsh-remote-control-client` — deliberately inert.
 *
 * A client bundle's package must also be a loadable host plugin: the Loader
 * imports this row on the backend, and `dsh-client-modules` composes the browser
 * bundle from that same row. This package owns no host behavior, so the host half
 * exists only to give the Loader something importable to mount.
 *
 * @module dsh-remote-control-client
 */

/** Cordis plugin name. */
export const name = 'remote-control-client'

/** No host services: nothing here touches the backend. */
export const inject = []

/** Intentionally empty; the browser half does all the work. */
export function apply() {}
