/**
 * Child-process containment for the self-checks.
 *
 * The checks start real servers and real backends. The command they invoke is not
 * always the process that ends up holding the port: `dsh` is a launcher, so
 * `node dsh/bin.js web` can put the actual backend one level further down the
 * tree. A plain `child.kill()` therefore signals the middle of the chain and the
 * real backend survives as an orphan.
 *
 * That is not hypothetical: it left five orphaned backends holding five ports on
 * a developer machine, serving stale pages, because `live-check` had been run
 * under `timeout` during debugging and the `finally` block never got to run.
 *
 * Two mechanisms fix it, and both are needed:
 *
 * 1. **A process group per child** (`detached: true`). With a group, one signal
 *    to `-pid` reaches every descendant the tool launched, not just the direct
 *    child.
 * 2. **A process-level registry with exit and signal hooks.** Cleanup that lives
 *    only in a `try/finally` cannot run when the process is signalled, so the
 *    `finally` path is the *tidy* path and these hooks are the *guarantee*.
 *
 * @module dsh-remote-control/tools/spawn-guard
 */

import { spawn } from 'node:child_process'

/** @type {Set<import('node:child_process').ChildProcess>} */
const tracked = new Set()
let installed = false
let cleaning = false

/**
 * Signal one child's whole process group, falling back to the direct signal.
 *
 * The negative pid is the group; a failure there is normal when the child was not
 * detached (or is already gone), so the direct kill is attempted as well.
 *
 * @param {import('node:child_process').ChildProcess} child - tracked child.
 * @param {NodeJS.Signals} signal - signal to send.
 */
function signalGroup(child, signal) {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    /* no group, or already reaped */
  }
  try {
    child.kill(signal)
  } catch {
    /* already gone */
  }
}

/**
 * Terminate every tracked child, group first.
 *
 * Kept idempotent and non-throwing: it runs from `process.on('exit')`, where an
 * exception would mask the real result.
 *
 * @param {NodeJS.Signals} [signal] - first signal to try.
 */
export function reapAll(signal = 'SIGTERM') {
  if (cleaning) return
  cleaning = true
  for (const child of tracked) signalGroup(child, signal)
  // Escalate immediately rather than waiting: this path only runs when the check
  // is already finishing, and a lingering server keeps a port that the next run
  // would need.
  for (const child of tracked) signalGroup(child, 'SIGKILL')
  tracked.clear()
}

/** Install the exit and signal hooks once per process. */
function install() {
  if (installed) return
  installed = true
  process.on('exit', () => reapAll())
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(signal, () => {
      reapAll(signal)
      // Re-raise so the exit status still reflects the signal, now that the
      // children are gone and cannot leak.
      process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))
    })
  }
}

/**
 * Spawn a child in its own process group and track it for reaping.
 *
 * Drop-in for `child_process.spawn` for the cases the checks need. Children are
 * detached so a group signal reaches their descendants, and `stdio` is left to
 * the caller because the checks read the output.
 *
 * @param {string} command - executable.
 * @param {string[]} args - arguments.
 * @param {object} [options] - spawn options; `detached` is forced on.
 * @returns {import('node:child_process').ChildProcess} the tracked child.
 */
export function spawnGuarded(command, args, options = {}) {
  install()
  const child = spawn(command, args, { ...options, detached: true })
  tracked.add(child)
  child.once('exit', () => tracked.delete(child))
  child.once('error', () => tracked.delete(child))
  return child
}

/**
 * Stop one child and its descendants.
 *
 * @param {import('node:child_process').ChildProcess|undefined} child - child to stop.
 * @returns {Promise<void>} resolves once it is gone or the escalation finished.
 */
export async function stopGuarded(child) {
  if (child === undefined || child.pid === undefined) return
  signalGroup(child, 'SIGTERM')
  tracked.delete(child)
  await new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve()
      return
    }
    const timer = setTimeout(() => {
      signalGroup(child, 'SIGKILL')
      resolve()
    }, 2_000)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve()
    })
  })
  signalGroup(child, 'SIGKILL')
}

/**
 * Report how many children this process is still tracking.
 *
 * The checks assert this is zero at the end, so a leak becomes a failed check
 * rather than a surprise five ports later.
 *
 * @returns {number} count of live tracked children.
 */
export function trackedCount() {
  return tracked.size
}
