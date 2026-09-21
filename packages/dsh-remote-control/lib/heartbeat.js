/**
 * `dsh-remote-control` — keep the relay's liveness window fed while a turn runs.
 *
 * The relay decides a machine is gone by the clock: no poll and no report for
 * `offlineAfterMs` (45s by default) and the node is marked offline. That rule is
 * right for a machine that died, and wrong for a machine that is *thinking*, and
 * this plugin used to confuse the two. Its poll loop is sequential:
 *
 *     while (true) {
 *       command = await poll()      // the heartbeat the relay watches
 *       await handleCommand(command)  // ← blocks here for the whole turn
 *     }
 *
 * So every remote turn longer than the liveness window looked like a dead
 * machine: the page showed 离线, and — worse — the relay's own command route
 * refuses new work for an offline node, so a visitor who kept typing got "node is
 * offline; the command was not queued" instead of being queued behind the running
 * turn. Observed in the field on a real guest question ("现在apk602的包体有多大")
 * that spent eight minutes on file reads and a question to the user; the machine
 * was reported offline for nearly all of it, and it had been answering perfectly
 * the whole time.
 *
 * The fix is not to make polling concurrent — one turn at a time is a deliberate
 * property — but to say "still here" out loud while the turn runs. A single
 * `report` already refreshes the relay's liveness stamp, so a report on a timer is
 * the whole mechanism.
 *
 * Two properties matter for safety:
 *
 * - **The interval is derived, not fixed.** The relay tells every node its own
 *   window in the `hello` ack, so the heartbeat is a third of it, clamped to
 *   [1s, 15s]. A deployment that widens or tightens the window gets a heartbeat
 *   that fits, without a second setting to keep in step.
 * - **It can never affect the turn.** Every beat is fire-and-forget: a relay that
 *   is down, slow, or rejecting reports must not slow a turn down or fail it. The
 *   timer is also `unref`ed, so it cannot hold the process open.
 *
 * @module dsh-remote-control/heartbeat
 */

/**
 * The interval used when the relay has not said what its window is.
 *
 * Fifteen seconds is a third of the shipped default (45s), so it is the right
 * answer for the deployment this was built for and a safe answer elsewhere: three
 * beats fit inside the window even if it is only slightly wider than the default.
 */
export const DEFAULT_HEARTBEAT_MS = 15_000

/**
 * How often to report while a turn is running.
 *
 * @param {unknown} offlineAfterMs - the relay's liveness window, from the `hello` ack.
 * @returns {number} the interval in milliseconds, always usable.
 */
export function heartbeatMsFor(offlineAfterMs) {
  if (typeof offlineAfterMs !== 'number' || !Number.isFinite(offlineAfterMs) || offlineAfterMs <= 0) {
    return DEFAULT_HEARTBEAT_MS
  }
  // A third of the window leaves room for one lost beat, and the clamp keeps a
  // misconfigured window (0.5s, or an hour) from turning into a request flood or
  // no heartbeat at all.
  return Math.max(1_000, Math.min(DEFAULT_HEARTBEAT_MS, Math.floor(offlineAfterMs / 3)))
}

/**
 * Start reporting "busy" on a timer until stopped.
 *
 * @param {object} options - `{ intervalMs, report }`.
 * @param {number} intervalMs - how often to beat.
 * @param {() => Promise<unknown>|unknown} report - one liveness report; may reject, may be slow.
 * @returns {() => void} stops the timer; safe to call more than once.
 */
export function startBusyHeartbeat({ intervalMs, report }) {
  if (typeof intervalMs !== 'number' || !Number.isFinite(intervalMs) || intervalMs <= 0) return () => {}
  if (typeof report !== 'function') return () => {}
  let stopped = false
  const timer = setInterval(() => {
    if (stopped) return
    // Deliberately not awaited and deliberately swallowed: a heartbeat is a
    // courtesy to the relay, and a courtesy must never become a turn's problem.
    void Promise.resolve()
      .then(() => report())
      .catch(() => {})
  }, intervalMs)
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
