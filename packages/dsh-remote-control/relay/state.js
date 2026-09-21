/**
 * `dsh-remote-control` relay — the little it remembers across a restart.
 *
 * Everything about this relay is deliberately in memory: the roster, the
 * transcripts, the open questions. A restart means a machine re-registers and a
 * visitor's *history* is gone, and that is a trade the README states plainly —
 * nothing on disk means no credentials or conversations on disk.
 *
 * Guest identities are the exception, and the reason is the invite code. A code
 * buys an identity exactly once, so if identities died with the process then every
 * relay restart — a deploy, a reboot, an OOM — would hand every invited visitor a
 * code prompt they cannot satisfy: they have no code any more, and the operator has
 * to mint a fresh one per person by hand. "You only type it once" has to survive a
 * restart or it is not true.
 *
 * What is written, and why each one:
 *
 * - **identities** — the whole point. Token → who they are and which machine they
 *   were invited to.
 * - **invite codes** — a code that dies in a restart would be a code handed out
 *   that stops working for no visible reason. Fifteen minutes is short, but a
 *   deploy lands inside it often enough.
 * - **session ownership** — otherwise a returning visitor's *second* question is
 *   refused ("that conversation does not belong to this visitor") even though the
 *   conversation is sitting right there in their browser.
 * - **transcripts** — the record of what was asked and answered. A page that
 *   reloads after a deploy has to still show the conversation, and the operator
 *   reading the page should not have to care whether the relay was restarted in
 *   between.
 * - **the queue and the in-flight command** — the two ways a question can be
 *   waiting: not picked up yet, or being answered right now. Losing them means a
 *   question on the page that can never be answered, and an answer that arrives
 *   after a restart and is dropped on the floor because the relay no longer
 *   recognises the command it belongs to.
 * - **rate counters** — so the limits cannot be reset by waiting for a restart.
 *
 * What is deliberately *not* written: the roster's liveness and the open question
 * cards. Both are tied to a live socket — a registered machine re-registers in
 * seconds, and a question card belongs to the node's parked request, which a
 * restart ends regardless. Persisting either would mean drawing a machine as
 * online when it is not.
 *
 * Three properties are non-negotiable, because this file is now on the critical
 * path of a service that must never fail to start:
 *
 * 1. **A broken file never stops the relay.** Unreadable, truncated, foreign
 *    JSON: the relay logs it, moves the file aside so it can be inspected, and
 *    starts empty. A cache that takes the door down with it is worse than a cache.
 * 2. **Writes are atomic.** Write a sibling temp file, then `rename`, which is
 *    atomic within a filesystem. A crash mid-write leaves either the old state or
 *    the new one, never half of either.
 * 3. **Writes are debounced and synchronous.** Synchronous because there are only
 *    a few kilobytes and a shutdown must not race `process.exit`; debounced because
 *    every visitor call refreshes a liveness stamp, and a file write per request
 *    would be a disk write per two seconds for a page nobody is looking at.
 *
 * The file holds bearer credentials, so it is created `0600` and the unit gives it
 * a private state directory (`StateDirectory=dsh-remote-relay`, mode 0700).
 *
 * @module dsh-remote-control/relay/state
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** The schema version, so a future change can refuse a shape it does not know. */
const VERSION = 1

/** How long a change waits before it is written. */
const DEBOUNCE_MS = 5_000

/**
 * Where the state file lives.
 *
 * `DSH_REMOTE_STATE_FILE` wins when set. `STATE_DIRECTORY` is what systemd gives a
 * service that asked for `StateDirectory=`, and it is the deployment's answer: a
 * writable directory the unit was built for.
 *
 * **Nothing is configured, nothing is written** — and an earlier version of this
 * file learned that the hard way by falling back to the working directory. Two
 * things were wrong with it. A relay started by hand wrote a file of bearer
 * credentials into whatever directory it happened to be in (for this repository,
 * that meant the package's own working tree). And the file survived between runs,
 * so a second `relay-check` inherited the first one's rate-limit counters and
 * identities and failed in ways that looked like relay bugs — a state file that
 * changes what a check observes is a state file that makes the check lie.
 *
 * So persistence is opt-in: set one of those two variables, or run under the unit
 * that sets `StateDirectory`. A relay without a file is a relay that forgets, which
 * is exactly what this service was before this file existed.
 *
 * @param {object} [env] - environment to read; defaults to `process.env`.
 * @returns {string} the absolute path to the state file, or '' for "do not persist".
 */
export function stateFilePath(env = process.env) {
  const explicit = typeof env?.DSH_REMOTE_STATE_FILE === 'string' ? env.DSH_REMOTE_STATE_FILE.trim() : ''
  if (explicit !== '') return explicit
  const directory = typeof env?.STATE_DIRECTORY === 'string' ? env.STATE_DIRECTORY.trim() : ''
  if (directory !== '') return join(directory, 'guests.json')
  return ''
}

/**
 * How long a session's transcript is kept for a machine nobody has touched.
 *
 * Long enough that "the relay was restarted last week" is invisible; short enough
 * that a machine the operator stopped using does not sit in the file forever.
 */
const TRANSCRIPT_KEEP_MS = 30 * 24 * 60 * 60 * 1000

/**
 * How long a command that was never delivered, or never reported, is worth keeping.
 *
 * Both are waiting on a node that is, by definition, not currently answering. A day
 * is far longer than any real outage and short enough that the file cannot grow
 * around abandoned work.
 */
const PENDING_KEEP_MS = 24 * 60 * 60 * 1000

/**
 * Drop anything past its lifetime, so a restored file cannot resurrect it.
 *
 * @param {object} state - the parsed state.
 * @param {object} limits - `{ identityTtlMs, inviteMemoryMs, maxIdentities, transcriptLimit }`.
 * @returns {object} the pruned state, in the same shape.
 */
export function pruneState(state, limits) {
  const now = Date.now()
  const identities = Object.entries(state.identities ?? {})
    .filter(([, record]) => now - Number(record?.lastSeenAt ?? 0) <= limits.identityTtlMs)
    // A file that grew past the cap (an older configuration, a hand edit) is trimmed
    // to the most recently seen, which is the same set the live cap would have kept.
    .sort((left, right) => Number(right[1]?.lastSeenAt ?? 0) - Number(left[1]?.lastSeenAt ?? 0))
    .slice(0, limits.maxIdentities)
  const kept = new Set(identities.map(([, record]) => record?.guestId))
  const invites = Object.entries(state.invites ?? {}).filter(
    ([, record]) => now <= Number(record?.expiresAt ?? 0) + limits.inviteMemoryMs
  )
  const sessions = Object.entries(state.sessions ?? {}).filter(([guestId]) => kept.has(guestId))
  const counters = Object.fromEntries(
    Object.entries(state.counters ?? {}).map(([name, buckets]) => [
      name,
      Object.fromEntries(
        Object.entries(buckets ?? {})
          .map(([address, stamps]) => [address, (stamps ?? []).filter((at) => now - Number(at) < 3_600_000)])
          .filter(([, stamps]) => stamps.length > 0)
      )
    ])
  )
  // Transcripts and pending work are kept per machine, and a machine nobody has
  // touched for a month is dropped along with them.
  const transcripts = {}
  const queue = {}
  const seq = {}
  for (const [nodeId, entries] of Object.entries(state.transcripts ?? {})) {
    const kept = (Array.isArray(entries) ? entries : []).slice(-limits.transcriptLimit)
    const newest = kept.reduce((latest, entry) => Math.max(latest, Number(entry?.at ?? 0)), 0)
    if (kept.length === 0 || now - newest > TRANSCRIPT_KEEP_MS) continue
    transcripts[nodeId] = kept
    if (typeof state.seq?.[nodeId] === 'number') seq[nodeId] = state.seq[nodeId]
  }
  for (const [nodeId, commands] of Object.entries(state.queue ?? {})) {
    const kept = (Array.isArray(commands) ? commands : []).filter(
      (command) => now - Number(command?.issuedAt ?? 0) <= PENDING_KEEP_MS
    )
    // A queue is only worth restoring when it still has somewhere to go: either the
    // machine has history here, or it is simply waiting to re-register.
    if (kept.length > 0) queue[nodeId] = kept
  }
  const inFlight = Object.fromEntries(
    Object.entries(state.inFlight ?? {}).filter(([, record]) => now - Number(record?.issuedAt ?? 0) <= PENDING_KEEP_MS)
  )
  return {
    identities: Object.fromEntries(identities),
    invites: Object.fromEntries(invites),
    sessions: Object.fromEntries(sessions),
    counters,
    transcripts,
    queue,
    inFlight,
    seq
  }
}

/**
 * A debounced, atomic, never-fatal JSON store for the relay's guest state.
 *
 * @param {object} options - `{ file?, logger? }`.
 * @returns {object} `{ path, load, save, flush, persisted }`.
 */
export function createStateStore({ file = stateFilePath(), logger } = {}) {
  let pending = null
  let timer = null
  let warned = false
  /** No path means no persistence, which is a decision rather than a failure. */
  const disabled = file === ''

  /**
   * Report one problem once, so a read-only directory does not fill the log.
   *
   * @param {string} message - what went wrong.
   */
  const warn = (message) => {
    if (warned) return
    warned = true
    const line = `dsh-remote-control relay: ${message}\n`
    if (typeof logger === 'function') logger(line.trim())
    process.stderr.write(line)
  }

  /**
   * Write now, or keep the newest state until the debounce fires.
   *
   * @param {object} state - the state to persist.
   */
  const save = (state) => {
    if (disabled) return
    pending = state
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      flush()
    }, DEBOUNCE_MS)
    timer.unref?.()
  }

  /** Write whatever is pending, synchronously, and swallow the reason if it cannot. */
  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    if (pending === null) return
    const state = pending
    pending = null
    const temporary = `${file}.tmp-${String(process.pid)}`
    try {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(temporary, `${JSON.stringify({ version: VERSION, savedAt: Date.now(), ...state })}\n`, {
        encoding: 'utf8',
        mode: 0o600
      })
      renameSync(temporary, file)
      // `rename` keeps the temp file's mode, but a file that already existed with a
      // wider mode would keep that instead — this is a bearer credential.
      chmodSync(file, 0o600)
    } catch (error) {
      // A relay that cannot persist is a relay without a memory, not a broken one.
      warn(`could not write guest state to ${file} (${error?.message ?? error}); identities will not survive a restart`)
    }
  }

  /**
   * Read the state file, tolerating every way it can be wrong.
   *
   * @returns {object} the pruned `{ identities, invites, sessions, counters }`, empty when there is nothing usable.
   */
  const load = () => {
    const empty = { identities: {}, invites: {}, sessions: {}, counters: {}, transcripts: {}, queue: {}, inFlight: {}, seq: {} }
    if (disabled || !existsSync(file)) return empty
    let parsed
    try {
      parsed = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      // Move it aside rather than leaving a file that will fail on every start.
      try {
        renameSync(file, `${file}.corrupt-${String(Date.now())}`)
        warn(`guest state at ${file} was unreadable (${error?.message ?? error}); it was moved aside and the door starts empty`)
      } catch {
        warn(`guest state at ${file} was unreadable and could not be moved aside; the door starts empty`)
      }
      return empty
    }
    if (parsed === null || typeof parsed !== 'object' || Number(parsed.version) !== VERSION) {
      warn(`guest state at ${file} has an unknown shape (version ${String(parsed?.version)}); the door starts empty`)
      return empty
    }
    return {
      identities: parsed.identities ?? {},
      invites: parsed.invites ?? {},
      sessions: parsed.sessions ?? {},
      counters: parsed.counters ?? {},
      transcripts: parsed.transcripts ?? {},
      queue: parsed.queue ?? {},
      inFlight: parsed.inFlight ?? {},
      seq: parsed.seq ?? {}
    }
  }

  return { path: file, persisted: !disabled, load, save, flush }
}
