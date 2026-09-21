#!/usr/bin/env node
/**
 * `dsh-remote-control` relay — the public rendezvous point.
 *
 * It runs on a machine the agents can dial *out* to (a cloud VM), so every
 * Harness behind NAT stays reachable without a public IP, a port forward, or
 * any inbound firewall rule. The relay never runs an agent, never holds model
 * credentials, and never touches a workspace: it keeps a roster, a mailbox, and
 * a transcript cache, and it serves the small Q&A page.
 *
 * Transport is deliberately plain HTTP with bearer tokens. TLS is terminated by
 * whatever reverse proxy sits in front (nginx on the deployment this was built
 * for); the relay itself speaks cleartext to loopback like every other service
 * behind that proxy.
 *
 * Zero runtime dependencies: `node:http` and friends only, so the deployment
 * story is `scp` plus a systemd unit rather than a lockfile and a registry.
 *
 * @module dsh-remote-control/relay
 */

import { createServer } from 'node:http'
import { timingSafeEqual, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { admitAnswers, admitQuestions } from '../lib/answers.js'

const HERE = dirname(fileURLToPath(import.meta.url))

// ── configuration ──────────────────────────────────────────────────────────

/**
 * Read one required secret from the environment.
 *
 * No default is provided on purpose: a relay that silently starts with a
 * well-known token is worse than one that refuses to start, because the failure
 * is invisible exactly when it matters.
 *
 * @param {string} key - environment variable name.
 * @returns {string} the non-empty secret.
 */
function requiredSecret(key) {
  const value = process.env[key]
  if (typeof value !== 'string' || value.trim() === '') {
    process.stderr.write(`dsh-remote-control relay: ${key} is required (set a long random value)\n`)
    process.exit(2)
  }
  return value.trim()
}

/**
 * Read one positive number from the environment.
 *
 * @param {string} key - environment variable name.
 * @param {number} fallback - value to use when unset or unusable.
 * @returns {number} the resolved number.
 */
function numberFromEnv(key, fallback) {
  const raw = process.env[key]
  if (raw === undefined || raw.trim() === '') return fallback
  const parsed = Number(raw)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const config = {
  host: process.env.DSH_REMOTE_RELAY_HOST ?? '127.0.0.1',
  port: Number(process.env.DSH_REMOTE_RELAY_PORT ?? 8787),
  /** Token every agent presents. Rotating it disconnects every node. */
  agentToken: requiredSecret('DSH_REMOTE_AGENT_TOKEN'),
  /** Token the browser page presents. Distinct from the agent token. */
  controlToken: requiredSecret('DSH_REMOTE_CONTROL_TOKEN'),
  /** A node that has not polled for this long is reported offline. */
  offlineAfterMs: Number(process.env.DSH_REMOTE_OFFLINE_AFTER_MS ?? 45_000),
  /** How long one agent long-poll may park before answering "no work". */
  pollHoldMs: Number(process.env.DSH_REMOTE_POLL_HOLD_MS ?? 25_000),
  /** Transcript lines retained per node, oldest dropped first. */
  transcriptLimit: Number(process.env.DSH_REMOTE_TRANSCRIPT_LIMIT ?? 200),
  /**
   * How long a held question may wait for an answer before the node is told the
   * wait is over. Deliberately longer than a node's own `questionTimeoutMs` so
   * the node's local fallback (the GUI) always fires first and this is only a
   * backstop against a connection that died without a FIN.
   */
  questionTimeoutMs: numberFromEnv('DSH_REMOTE_QUESTION_TIMEOUT_MS', 330_000),
  /** Set when a TLS-terminating proxy supplies the public origin, for logs. */
  publicOrigin: process.env.DSH_REMOTE_PUBLIC_ORIGIN ?? '',
  /**
   * The master switch for the guest door.
   *
   * On unless explicitly turned off, because the door only exists for nodes that
   * advertise one: with `guestEnabled: false` on every node (the default there),
   * `/guest` lists nothing and every guest route is a 403. Keeping the relay's own
   * switch default-on means enabling guests is one node-side setting rather than
   * a coordinated change to a server the operator may not administer; turning it
   * off here is the kill switch that needs no node cooperation at all.
   */
  guestEnabled: process.env.DSH_REMOTE_GUEST !== 'off',
  /** Longest guest question the relay forwards. The node caps it again. */
  guestMaxPromptChars: numberFromEnv('DSH_REMOTE_GUEST_MAX_PROMPT', 8_000),
  /** How long an unused anonymous guest identity stays valid. */
  guestTokenTtlMs: numberFromEnv('DSH_REMOTE_GUEST_TOKEN_TTL_MS', 12 * 60 * 60 * 1000),
  /** Cap on live guest identities, so an open door cannot grow without bound. */
  guestMaxVisitors: numberFromEnv('DSH_REMOTE_GUEST_MAX_VISITORS', 64),
  /** Commands one visitor may have waiting on one node, in flight or queued. */
  guestMaxOutstanding: numberFromEnv('DSH_REMOTE_GUEST_MAX_OUTSTANDING', 2),
  /** Guest entries a single node's queue may hold, across all visitors. */
  guestMaxQueue: numberFromEnv('DSH_REMOTE_GUEST_MAX_QUEUE', 4),
  /** How many guest identities one address may mint per hour. */
  guestEntersPerHour: numberFromEnv('DSH_REMOTE_GUEST_ENTERS_PER_HOUR', 20)
}

// ── state ──────────────────────────────────────────────────────────────────

/**
 * One connected Harness.
 *
 * `queue` holds commands the agent has not claimed yet; `waiters` holds parked
 * long-polls waiting for exactly that. The two are drained against each other so
 * a command submitted while an agent is parked is delivered immediately instead
 * of waiting out the hold.
 */
class NodeRecord {
  /**
   * @param {string} nodeId - stable identity the agent chooses and reuses.
   */
  constructor(nodeId) {
    this.nodeId = nodeId
    this.name = nodeId
    this.platform = ''
    this.version = ''
    this.workspaces = []
    /**
     * The guest door this node advertises.
     *
     * Kept separate from `workspaces` rather than merged into it, because the two
     * lists answer different questions and only one of them may be shown to a
     * visitor. `enabled: false` is the default, so a node that never mentions
     * guests is closed rather than implicitly open.
     *
     * @type {{ enabled: boolean, workspaces: Array<{name: string, path: string}>, agentPreset: string, permissionPreset: string }}
     */
    this.guest = { enabled: false, workspaces: [], agentPreset: '', permissionPreset: '' }
    this.status = 'idle'
    this.detail = ''
    this.lastSeenAt = Date.now()
    this.connectedAt = Date.now()
    /** @type {Array<object>} commands awaiting delivery */
    this.queue = []
    /** @type {Set<(command: object|null) => void>} parked long-polls */
    this.waiters = new Set()
    /** @type {Array<object>} bounded transcript */
    this.transcript = []
    /** Monotonic transcript counter; the control page uses it to dedupe pushes. */
    this.transcriptSeq = 0
  }
}

/** @type {Map<string, NodeRecord>} */
const nodes = new Map()
/**
 * Commands a node has picked up or is about to.
 *
 * The record carries the caller as well as the node, because that is what decides
 * who may read the outcome and who may answer the question a turn asks. It is the
 * relay's own record of what *it* submitted, so a node's report cannot promote a
 * guest command into an operator one.
 *
 * @type {Map<string, {nodeId: string, commandId: string, role: 'owner'|'guest', guestId: string}>}
 */
const inFlight = new Map()
/**
 * Anonymous visitor identities, keyed by the opaque token the page holds.
 *
 * A visitor gets an identity without presenting anything, which is the point of
 * the feature — but "no password" must not mean "no identity": without one, every
 * visitor would share one conversation view, could answer another visitor's
 * question, and could continue another visitor's session. The identity is minted
 * by the relay, never by the node, and it is what the node records on the session
 * it creates.
 *
 * @type {Map<string, {guestId: string, createdAt: number, lastSeenAt: number}>}
 */
const guestTokens = new Map()
/**
 * Sessions a visitor created: `guestId -> sessionId -> nodeId`.
 *
 * The relay's own copy of the node's session ledger. The node refuses a session
 * it did not create, so this is not the security boundary — it is what turns
 * "wrong session" into a 403 the page can explain instead of a failed turn.
 *
 * @type {Map<string, Map<string, string>>}
 */
const guestSessions = new Map()
/**
 * Guest identities minted per client address, in the last hour.
 *
 * `/api/guest/enter` is the one route with no credential at all, so it is the one
 * route worth rate-limiting: without this, a script could mint unbounded
 * identities, and every identity is a conversation the machine may be asked to
 * run.
 *
 * @type {Map<string, number[]>}
 */
const guestEnters = new Map()
/**
 * Questions a node is holding open, keyed by `nodeId` then `questionId`.
 *
 * A question is relay-local state, not a transcript line: it exists only while
 * the node is blocked on it, and the entry carries the parked HTTP response that
 * the answer has to reach. Nothing here is persisted, for the same reason the
 * roster is not — the relay is a rendezvous point, and a restart simply means
 * the node's own wait times out and falls back to its local GUI.
 *
 * @type {Map<string, Map<string, {questionId: string, nodeId: string, questions: Array<object>, commandId: string, workspace: string, at: number, deliver: (outcome: object) => void, res: import('node:http').ServerResponse, timer: NodeJS.Timeout, settled: boolean, ended: boolean}>>}
 */
const openQuestions = new Map()
/**
 * Browser event-stream subscribers, each with the view it is entitled to.
 *
 * A record rather than the bare response, because the roster is now projected per
 * audience: the same event means different things to the operator and to a
 * visitor, so the subscriber has to carry who it is.
 *
 * @type {Set<{ res: import('node:http').ServerResponse, viewer: { role: string, guestId: string } }>}
 */
const subscribers = new Set()

// ── helpers ────────────────────────────────────────────────────────────────

/**
 * Constant-time string comparison that tolerates length differences.
 *
 * @param {string} a - candidate.
 * @param {string} b - expected.
 * @returns {boolean} whether they match.
 */
function secretEquals(a, b) {
  const left = Buffer.from(String(a), 'utf8')
  const right = Buffer.from(String(b), 'utf8')
  if (left.length !== right.length) {
    // Still compare something of equal length so the failure path is not an
    // early-return timing oracle for the length.
    timingSafeEqual(left, left)
    return false
  }
  return timingSafeEqual(left, right)
}

/**
 * Extract a bearer token from either supported header form.
 *
 * `Authorization: Bearer <token>` is the documented form. The query form exists
 * only for the EventSource subscriber, which cannot set headers.
 *
 * @param {import('node:http').IncomingMessage} req - incoming request.
 * @param {URL} url - parsed request URL.
 * @returns {string|undefined} the presented token.
 */
function presentedToken(req, url) {
  const header = req.headers.authorization
  if (typeof header === 'string' && header.startsWith('Bearer ')) return header.slice(7).trim()
  const query = url.searchParams.get('token')
  return query === null ? undefined : query
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - JSON-serializable body.
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store'
  })
  res.end(payload)
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {number} limit - maximum accepted bytes.
 * @returns {Promise<object|null>} parsed object, or null when invalid or oversized.
 */
async function readJsonBody(req, limit = 1_048_576) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > limit) return null
    chunks.push(chunk)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** The operator's view: everything the relay knows. */
const OWNER_VIEW = Object.freeze({ role: 'owner', guestId: '' })

/**
 * Public projection of a node, for one kind of viewer.
 *
 * Two projections rather than one, because the two audiences must not be able to
 * read each other's facts. A guest sees the guest door's directories and nothing
 * else of this machine: not the operator's workspace list, not its platform and
 * version, and not a `detail` line — that field carries a slice of whatever turn
 * is running, which for the operator's turn is the operator's own prompt text.
 *
 * @param {NodeRecord} node - stored record.
 * @param {{ role: string, guestId: string }} [viewer] - who is reading.
 * @returns {object} page-facing shape.
 */
function publicNode(node, viewer = OWNER_VIEW) {
  const online = Date.now() - node.lastSeenAt <= config.offlineAfterMs
  if (viewer.role === 'guest') {
    return {
      nodeId: node.nodeId,
      name: node.name,
      guest: true,
      workspaces: node.guest.workspaces,
      status: node.status,
      detail: guestDetail(node, viewer),
      online,
      lastSeenAt: node.lastSeenAt,
      connectedAt: node.connectedAt,
      queued: node.queue.filter((command) => command.guestId === viewer.guestId).length,
      questions: pendingQuestionsOf(node.nodeId, viewer)
    }
  }
  return {
    nodeId: node.nodeId,
    name: node.name,
    platform: node.platform,
    version: node.version,
    workspaces: node.workspaces,
    status: node.status,
    detail: node.detail,
    online,
    lastSeenAt: node.lastSeenAt,
    connectedAt: node.connectedAt,
    queued: node.queue.length,
    // Pending questions ride the roster rather than the transcript because they
    // are live state: a page that loads mid-turn has to see the open card, and a
    // transcript is a record of what already happened.
    questions: pendingQuestionsOf(node.nodeId, viewer),
    // The door's state, for the operator only: it is their exposure, and their page
    // is where the link to it is offered.
    guest: {
      enabled: node.guest.enabled,
      agentPreset: node.guest.agentPreset,
      permissionPreset: node.guest.permissionPreset,
      workspaces: node.guest.workspaces
    }
  }
}

/**
 * What a guest may be told about a node's current activity.
 *
 * Never the operator's `detail` string: it is a 70-character slice of a running
 * prompt, so forwarding it would put the operator's own words on a public page.
 * A guest learns whether the machine is busy and whether the busy turn is theirs,
 * which is what the page actually needs to explain a wait.
 *
 * @param {NodeRecord} node - stored record.
 * @param {{ role: string, guestId: string }} viewer - the reading visitor.
 * @returns {string} a guest-safe status line.
 */
function guestDetail(node, viewer) {
  if (node.status !== 'busy') return ''
  const mine = [...inFlight.values()].some((record) => record.nodeId === node.nodeId && record.guestId === viewer.guestId)
  return mine ? '正在运行你的提问' : '正在运行其他会话'
}

/**
 * The nodes one viewer may see at all.
 *
 * A node with the door shut is not listed to a guest, rather than listed with an
 * empty directory list: "this machine exists but you may do nothing here" is a
 * fact about somebody else's machine, and there is no use the page has for it.
 *
 * @param {{ role: string, guestId: string }} viewer - who is reading.
 * @returns {NodeRecord[]} the visible records.
 */
function visibleNodes(viewer) {
  const all = [...nodes.values()]
  if (viewer.role !== 'guest') return all
  return all.filter((node) => node.guest.enabled && node.guest.workspaces.length > 0)
}

/**
 * The public projection of one node's pending questions.
 *
 * @param {string} nodeId - owning node.
 * @param {{ role: string, guestId: string }} [viewer] - who is reading.
 * @returns {Array<object>} questions the page may render and answer.
 */
function pendingQuestionsOf(nodeId, viewer = OWNER_VIEW) {
  const held = openQuestions.get(nodeId)
  if (held === undefined) return []
  return [...held.values()]
    .filter((entry) => viewer.role !== 'guest' || entry.guestId === viewer.guestId)
    .map((entry) => ({
      questionId: entry.questionId,
      commandId: entry.commandId,
      workspace: entry.workspace,
      at: entry.at,
      questions: entry.questions
    }))
}

/**
 * Whether one viewer may see one transcript line.
 *
 * Ownership is the whole test, and it is one-way: the operator sees everything
 * (it is their machine and the audit trail of the public door lives here), while a
 * visitor sees exactly the turns their own identity issued.
 *
 * @param {object} entry - transcript entry.
 * @param {{ role: string, guestId: string }} viewer - who is reading.
 * @returns {boolean} true when the entry is visible.
 */
function visibleEntry(entry, viewer) {
  return viewer.role !== 'guest' || (entry.guestId !== undefined && entry.guestId === viewer.guestId)
}

/**
 * Write one event-stream frame to one subscriber, per that subscriber's view.
 *
 * Filtering happens per subscriber rather than per broadcast because the two
 * audiences are subscribed to the same roster: a single filtered payload for
 * everybody is exactly the bug this shape prevents.
 *
 * @param {{ res: import('node:http').ServerResponse, viewer: object }} subscriber - the subscriber.
 * @param {object} payload - the event object.
 */
function writeTo(subscriber, payload) {
  const { res } = subscriber
  if (res.writableEnded) return
  res.write(`data: ${JSON.stringify(payload)}\n\n`)
}

/**
 * Fan one question state change out to the browsers.
 *
 * The roster carries the full list, so this is a nudge to re-read it rather than
 * a delta: the page already treats a roster push as authoritative.
 *
 * @param {string} nodeId - owning node.
 */
function broadcastQuestions(nodeId) {
  for (const subscriber of subscribers) {
    writeTo(subscriber, { type: 'questions', nodeId, questions: pendingQuestionsOf(nodeId, subscriber.viewer) })
  }
  broadcastRoster()
}

/** Notify every browser subscriber with the roster as that subscriber may see it. */
function broadcastRoster() {
  for (const subscriber of subscribers) {
    writeTo(subscriber, { type: 'roster', nodes: visibleNodes(subscriber.viewer).map((node) => publicNode(node, subscriber.viewer)) })
  }
}

/**
 * Append one transcript line and fan it out to browsers.
 *
 * @param {NodeRecord} node - owning node.
 * @param {object} entry - transcript entry without `at` or `seq`; carries `role` and, for a guest, `guestId`.
 */
function appendTranscript(node, entry) {
  const record = { seq: (node.transcriptSeq += 1), at: Date.now(), nodeId: node.nodeId, ...entry }
  node.transcript.push(record)
  if (node.transcript.length > config.transcriptLimit) {
    node.transcript.splice(0, node.transcript.length - config.transcriptLimit)
  }
  for (const subscriber of subscribers) {
    if (!visibleEntry(record, subscriber.viewer)) continue
    writeTo(subscriber, { type: 'transcript', entry: record })
  }
}

/**
 * Hand a command to a parked long-poll, or queue it.
 *
 * @param {NodeRecord} node - target node.
 * @param {object} command - command envelope.
 */
function deliverOrQueue(node, command) {
  const waiter = node.waiters.values().next().value
  if (waiter !== undefined) {
    node.waiters.delete(waiter)
    waiter(command)
    return
  }
  node.queue.push(command)
  broadcastRoster()
}

// ── agent-facing endpoints ─────────────────────────────────────────────────

/**
 * `POST /api/agent/hello` — register or refresh a node's advertised facts.
 *
 * The `guest` block is always applied, including when it says `enabled: false`: a
 * node that was reconfigured has to be able to close a door this relay still
 * remembers, and "the field was absent" must not leave a stale door open.
 *
 * @param {object} body - `{ nodeId, name?, platform?, version?, workspaces?, guest? }`.
 * @returns {object} accepted identity.
 */
function agentHello(body) {
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  if (nodeId === '') throw new HttpError(400, 'nodeId must be a non-empty string')
  let node = nodes.get(nodeId)
  if (node === undefined) {
    node = new NodeRecord(nodeId)
    nodes.set(nodeId, node)
  }
  if (typeof body.name === 'string' && body.name.trim() !== '') node.name = body.name.trim()
  if (typeof body.platform === 'string') node.platform = body.platform
  if (typeof body.version === 'string') node.version = body.version
  if (Array.isArray(body.workspaces)) {
    node.workspaces = body.workspaces
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        path: typeof entry.path === 'string' ? entry.path : ''
      }))
      .filter((entry) => entry.path !== '')
  }
  // The block is applied on every hello, and an absent block means *closed* rather
  // than "leave whatever was there". The node this relay is written for always sends
  // the block, so the only caller this changes is one that does not — an older
  // node, or a hand-written client — and for those the safe reading of "said nothing
  // about guests" is "has no door". The alternative would let a door outlive the
  // process that opened it.
  const guest = body.guest !== null && typeof body.guest === 'object' ? body.guest : {}
  node.guest = {
    enabled: guest.enabled === true,
    // The guest list is filtered against the operator's own list here as well as
    // on the node. A node is the authority on its directories, but the relay is
    // the one that hands a name to a visitor, so it refuses to hold a name the
    // same node never advertised to the operator at all.
    workspaces: (Array.isArray(guest.workspaces) ? guest.workspaces : [])
      .filter((entry) => entry !== null && typeof entry === 'object')
      .map((entry) => ({
        name: typeof entry.name === 'string' ? entry.name : '',
        path: typeof entry.path === 'string' ? entry.path : ''
      }))
      .filter((entry) => entry.path !== '' && node.workspaces.some((owner) => owner.path === entry.path)),
    agentPreset: typeof guest.agentPreset === 'string' ? guest.agentPreset : '',
    permissionPreset: typeof guest.permissionPreset === 'string' ? guest.permissionPreset : ''
  }
  node.lastSeenAt = Date.now()
  broadcastRoster()
  return { nodeId: node.nodeId, name: node.name, pollHoldMs: config.pollHoldMs, guest: node.guest.enabled }
}

/**
 * `POST /api/agent/poll` — long-poll for the next command.
 *
 * @param {object} body - `{ nodeId }`.
 * @param {import('node:http').ServerResponse} res - response to answer later.
 * @returns {Promise<void>} resolves once the response is written.
 */
async function agentPoll(body, res) {
  const node = requireNode(body)
  node.lastSeenAt = Date.now()
  if (node.status !== 'idle' && body.idle === true) {
    node.status = 'idle'
    node.detail = ''
    broadcastRoster()
  }
  const queued = node.queue.shift()
  if (queued !== undefined) {
    sendJson(res, 200, { command: queued })
    return
  }
  await new Promise((resolve) => {
    let settled = false
    const finish = (command) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      node.waiters.delete(finish)
      if (res.writableEnded) {
        resolve()
        return
      }
      sendJson(res, 200, command === null ? { command: null } : { command })
      resolve()
    }
    const timer = setTimeout(() => finish(null), config.pollHoldMs)
    node.waiters.add(finish)
    res.on('close', () => finish(null))
  })
}

/**
 * `POST /api/agent/report` — status and command outcomes.
 *
 * @param {object} body - `{ nodeId, status?, detail?, commandId?, result? }`.
 * @returns {object} acknowledgement.
 */
function agentReport(body) {
  const node = requireNode(body)
  node.lastSeenAt = Date.now()
  if (typeof body.status === 'string' && body.status !== '') {
    node.status = body.status
    node.detail = typeof body.detail === 'string' ? body.detail : ''
  }
  const commandId = typeof body.commandId === 'string' ? body.commandId : undefined
  if (commandId !== undefined) {
    // The caller is read from the relay's own record of the submission, not from
    // the node's report: a node (or a compromised node) must not be able to
    // relabel a guest turn as the operator's, which would publish it to the wrong
    // audience.
    const caller = inFlight.get(commandId)
    inFlight.delete(commandId)
    const result = body.result !== null && typeof body.result === 'object' ? body.result : {}
    const role = caller?.role ?? 'owner'
    const guestId = caller?.guestId ?? ''
    appendTranscript(node, {
      kind: result.ok === true ? 'answer' : 'error',
      role,
      guestId,
      commandId,
      prompt: typeof result.prompt === 'string' ? result.prompt : '',
      workspace: typeof result.workspace === 'string' ? result.workspace : '',
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : '',
      text: typeof result.text === 'string' ? result.text : '',
      error: typeof result.error === 'string' ? result.error : '',
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0
    })
    // The relay's copy of "which sessions this visitor owns", so the next command
    // that names one is refused before it reaches the node rather than after.
    if (role === 'guest' && guestId !== '' && typeof result.sessionId === 'string' && result.sessionId !== '') {
      const owned = guestSessions.get(guestId) ?? new Map()
      owned.set(result.sessionId, node.nodeId)
      guestSessions.set(guestId, owned)
    }
    if (node.status !== 'idle') {
      node.status = 'idle'
      node.detail = ''
    }
  }
  broadcastRoster()
  return { ok: true }
}

/**
 * `POST /api/agent/ask` — hold a node's question open until the page answers it.
 *
 * This is the second long-poll of the protocol, and it exists because the node's
 * own `ask_user_question` is a blocking call: the agent is suspended on it, so
 * the question cannot be smuggled through `report`/`poll` without inventing a
 * state machine. Parking here mirrors `agentPoll` exactly — same hold, same
 * "answer later" response.
 *
 * The node is told the outcome, never asked to wait forever: the entry expires
 * after `questionTimeoutMs`, and the page is told either way so no card is left
 * offering an answer that would go nowhere.
 *
 * @param {object} body - `{ nodeId, questions }`.
 * @param {import('node:http').ServerResponse} res - response to answer later.
 * @returns {Promise<void>} resolves once the response is written.
 */
async function agentAsk(body, res) {
  const node = requireNode(body)
  node.lastSeenAt = Date.now()
  const questions = admitQuestions(body.questions)
  if (questions === undefined) throw new HttpError(400, 'questions must be a non-empty list of { id, question }')
  const nodeId = node.nodeId
  // Check before touching the map. An earlier draft deleted the node's entry
  // first and re-inserted it after the check, which meant a *refused* duplicate
  // dropped the live question on the floor — the card vanished and the agent
  // stayed blocked. A rejection must leave everything exactly as it was.
  const held = openQuestions.get(nodeId)
  if (held !== undefined && held.size > 0) {
    throw new HttpError(409, `node ${nodeId} already has ${String(held.size)} question(s) waiting for an answer`)
  }
  // One open question per node is the contract, not a limitation: a node runs one
  // remote turn at a time, and the agent is blocked on this call, so a second
  // question can only be a duplicate or a bug. Refusing is what keeps the page's
  // "which question is this answer for" unambiguous.
  const open = held ?? new Map()
  if (held === undefined) openQuestions.set(nodeId, open)

  const questionId = randomUUID()
  const commandId = commandFor(nodeId)
  const workspace = workspaceFor(commandId)
  // Who asked decides who may answer. A visitor's card must not appear on another
  // visitor's page, and an answer from a third party would stall the turn it
  // belongs to.
  const caller = commandId === '' ? undefined : inFlight.get(commandId)
  const entry = {
    questionId,
    commandId,
    workspace,
    role: caller?.role ?? 'owner',
    guestId: caller?.guestId ?? '',
    questions,
    at: Date.now(),
    res,
    timer: undefined,
    settled: false,
    ended: false,
    deliver: () => {}
  }
  const settle = (outcome) => {
    if (entry.settled) return
    entry.settled = true
    clearTimeout(entry.timer)
    if (!entry.ended) {
      entry.ended = true
      openQuestions.get(nodeId)?.delete(questionId)
      broadcastQuestions(nodeId)
    }
    if (!res.writableEnded) sendJson(res, 200, outcome)
  }
  entry.deliver = settle
  entry.timer = setTimeout(() => {
    settle({ questionId, settled: true, reason: 'timeout' })
  }, config.questionTimeoutMs)
  entry.timer.unref?.()
  open.set(questionId, entry)
  // A node that went away without a FIN would otherwise leave the card up until
  // the expiry; `close` is the only signal that the holder is gone.
  res.on('close', () => {
    if (!entry.ended) {
      entry.ended = true
      clearTimeout(entry.timer)
      openQuestions.get(nodeId)?.delete(questionId)
      broadcastQuestions(nodeId)
    }
  })
  broadcastQuestions(nodeId)
  // The response is written later by the answer or the expiry; `sendJson` is
  // reached from `settle`, so nothing is awaited here on purpose.
}

/**
 * `POST /api/agent/question/settled` — the node stopped waiting on its own.
 *
 * Sent when the node's local timeout, a cancelled turn, or an unusable answer
 * ends the wait before the page answered. Without it the page would keep
 * offering a card whose submission resolves nothing.
 *
 * @param {object} body - `{ nodeId, questionId }`.
 * @returns {object} acknowledgement.
 */
function agentQuestionSettled(body) {
  const node = requireNode(body)
  node.lastSeenAt = Date.now()
  const questionId = typeof body.questionId === 'string' ? body.questionId : ''
  const entry = openQuestions.get(node.nodeId)?.get(questionId)
  if (entry === undefined) return { ok: true, settled: false }
  clearTimeout(entry.timer)
  entry.deliver({ questionId, settled: true, reason: 'withdrawn' })
  return { ok: true, settled: true }
}

/**
 * The command a node is currently running, if any.
 *
 * A question is always asked inside a turn, so this is what lets the page put
 * the card in the right transcript position instead of at the end.
 *
 * @param {string} nodeId - owning node.
 * @returns {string} the in-flight command id, or the empty string.
 */
function commandFor(nodeId) {
  for (const [commandId, record] of inFlight) if (record.nodeId === nodeId) return commandId
  return ''
}

/**
 * The workspace a command was issued for.
 *
 * Read from the transcript rather than from the node, because the transcript is
 * where the command's own `workspace` was recorded at submit time.
 *
 * @param {string} commandId - in-flight command id.
 * @returns {string} the workspace path, or the empty string.
 */
function workspaceFor(commandId) {
  if (commandId === '') return ''
  for (const node of nodes.values()) {
    const found = node.transcript.find((entry) => entry.commandId === commandId)
    if (found !== undefined) return found.workspace ?? ''
  }
  return ''
}

/**
 * Resolve the node a request names, refreshing its liveness stamp.
 *
 * @param {object} body - request body carrying `nodeId`.
 * @returns {NodeRecord} the record.
 */
function requireNode(body) {
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  const node = nodes.get(nodeId)
  if (node === undefined) throw new HttpError(404, `unknown nodeId ${JSON.stringify(nodeId)}; run /api/agent/hello first`)
  return node
}

// ── browser-facing endpoints ───────────────────────────────────────────────

/**
 * `GET /api/state` — full snapshot for the control page.
 *
 * @param {URL} url - the request URL, carrying an optional `nodeId` focus.
 * @returns {object} roster plus requested transcript.
 */
function controlState(url) {
  return stateFor(url, OWNER_VIEW)
}

/**
 * `GET /api/guest/state` — the same snapshot, narrowed to one visitor.
 *
 * @param {URL} url - the request URL, carrying an optional `nodeId` focus.
 * @param {{ role: string, guestId: string }} viewer - the visiting identity.
 * @returns {object} the visitor's roster and its own transcript.
 */
function guestState(url, viewer) {
  return stateFor(url, viewer)
}

/**
 * Build one page snapshot for one audience.
 *
 * Shared by both entry points so the two can never disagree about what a
 * transcript is: the only difference is the viewer, and every projection below it
 * is keyed on that.
 *
 * @param {URL} url - the request URL.
 * @param {{ role: string, guestId: string }} viewer - who is reading.
 * @returns {object} the snapshot.
 */
function stateFor(url, viewer) {
  const focus = url.searchParams.get('nodeId')
  const focused = focus === null ? undefined : nodes.get(focus)
  const transcript = focused === undefined ? [] : focused.transcript.filter((entry) => visibleEntry(entry, viewer))
  return {
    nodes: visibleNodes(viewer).map((node) => publicNode(node, viewer)),
    transcript,
    pollHoldMs: config.pollHoldMs,
    offlineAfterMs: config.offlineAfterMs,
    guest: { enabled: config.guestEnabled, mode: viewer.role === 'guest' ? 'guest' : 'owner' }
  }
}

/**
 * `POST /api/command` — submit one question to one node.
 *
 * @param {object} body - `{ nodeId, workspace, prompt, sessionId? }`.
 * @returns {object} accepted command summary.
 */
function controlCommand(body) {
  const node = nodes.get(typeof body.nodeId === 'string' ? body.nodeId : '')
  if (node === undefined) throw new HttpError(404, 'that nodeId is not registered')
  return submitCommand(node, body, OWNER_VIEW)
}

/**
 * `POST /api/guest/command` — submit one question as a visitor.
 *
 * The refusals here are the door's shape: the node must have opened the door, the
 * directory must be one of the directories it opened, the question must fit the
 * cap, and the visitor must not already have work waiting. The node refuses all of
 * the same things again on arrival — this half exists so the page can explain the
 * refusal, and so an abusive visitor is stopped before the node is asked at all.
 *
 * @param {object} body - `{ nodeId, workspace, prompt, sessionId? }`.
 * @param {{ role: string, guestId: string }} viewer - the visiting identity.
 * @returns {object} accepted command summary.
 */
function guestCommand(body, viewer) {
  const node = nodes.get(typeof body.nodeId === 'string' ? body.nodeId : '')
  if (node === undefined) throw new HttpError(404, 'that nodeId is not registered')
  if (!node.guest.enabled) throw new HttpError(403, `node ${node.nodeId} does not offer guest access`)
  if (Date.now() - node.lastSeenAt > config.offlineAfterMs) {
    throw new HttpError(409, `node ${node.nodeId} is offline; the command was not queued`)
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt.length > config.guestMaxPromptChars) {
    throw new HttpError(400, `a guest question may be at most ${String(config.guestMaxPromptChars)} characters`)
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined
  if (sessionId !== undefined) {
    // Continuity is per visitor: a session this visitor did not create is refused
    // here rather than silently starting a new conversation on the node.
    const owned = guestSessions.get(viewer.guestId)
    if (owned === undefined || owned.get(sessionId) !== node.nodeId) {
      throw new HttpError(403, 'that conversation does not belong to this visitor')
    }
  }
  const mine =
    [...inFlight.values()].filter((record) => record.guestId === viewer.guestId).length +
    node.queue.filter((command) => command.guestId === viewer.guestId).length
  if (mine >= config.guestMaxOutstanding) {
    throw new HttpError(429, `you already have ${String(mine)} question(s) waiting on ${node.nodeId}; wait for one to finish`)
  }
  const queued = node.queue.filter((command) => command.role === 'guest').length
  if (queued >= config.guestMaxQueue) {
    throw new HttpError(429, 'the guest queue for this machine is full; try again in a moment')
  }
  return submitCommand(node, body, viewer)
}

/**
 * Admit and hand off one question, for either audience.
 *
 * @param {NodeRecord} node - target node.
 * @param {object} body - `{ workspace, prompt, sessionId? }`.
 * @param {{ role: string, guestId: string }} viewer - the caller.
 * @returns {object} accepted command summary.
 */
function submitCommand(node, body, viewer) {
  if (Date.now() - node.lastSeenAt > config.offlineAfterMs) {
    throw new HttpError(409, `node ${node.nodeId} is offline; the command was not queued`)
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') throw new HttpError(400, 'prompt must not be empty')
  const workspace = typeof body.workspace === 'string' && body.workspace.trim() !== '' ? body.workspace.trim() : undefined
  if (workspace === undefined) throw new HttpError(400, 'workspace is required')
  const advertised = viewer.role === 'guest' ? node.guest.workspaces : node.workspaces
  if (!advertised.some((entry) => entry.path === workspace)) {
    throw new HttpError(
      400,
      viewer.role === 'guest'
        ? `workspace ${JSON.stringify(workspace)} is not offered to guests by ${node.nodeId}`
        : `workspace ${JSON.stringify(workspace)} is not advertised by ${node.nodeId}`
    )
  }
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined
  const command = {
    commandId: randomUUID(),
    kind: 'question',
    workspace,
    prompt,
    // The node decides the posture from these two: `role` picks the workspace list
    // and the presets, `principal` decides which sessions this caller may continue.
    role: viewer.role,
    principal: viewer.role === 'guest' ? viewer.guestId : 'owner',
    ...(sessionId === undefined ? {} : { sessionId }),
    issuedAt: Date.now()
  }
  inFlight.set(command.commandId, {
    nodeId: node.nodeId,
    commandId: command.commandId,
    role: viewer.role,
    guestId: viewer.role === 'guest' ? viewer.guestId : ''
  })
  appendTranscript(node, {
    kind: 'question',
    role: viewer.role,
    guestId: viewer.role === 'guest' ? viewer.guestId : '',
    commandId: command.commandId,
    prompt,
    workspace,
    sessionId: sessionId ?? ''
  })
  deliverOrQueue(node, command)
  return { commandId: command.commandId, queued: node.queue.length }
}

/**
 * `POST /api/answer` — answer one held question.
 *
 * Two independent checks, and both are needed. `admitAnswers` enforces the
 * vocabulary and rejects an option the model never offered, so a compromised
 * relay cannot get an invented choice into the model's context; this function
 * enforces that the question is genuinely open and that the batch matches the
 * questions that were asked. The node re-checks the labels again on arrival —
 * neither half trusts the other.
 *
 * @param {object} body - `{ nodeId, questionId, answers }`.
 * @returns {object} acknowledgement naming the command the answer settled.
 */
function controlAnswer(body) {
  return answerQuestion(body, OWNER_VIEW)
}

/**
 * `POST /api/guest/answer` — answer a held question as a visitor.
 *
 * @param {object} body - `{ nodeId, questionId, answers }`.
 * @param {{ role: string, guestId: string }} viewer - the visiting identity.
 * @returns {object} acknowledgement naming the command the answer settled.
 */
function guestAnswer(body, viewer) {
  return answerQuestion(body, viewer)
}

/**
 * Settle one open question from one audience.
 *
 * @param {object} body - `{ nodeId, questionId, answers }`.
 * @param {{ role: string, guestId: string }} viewer - who is answering.
 * @returns {object} acknowledgement.
 */
function answerQuestion(body, viewer) {
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : ''
  if (nodeId === '' || questionId === '') throw new HttpError(400, 'nodeId and questionId are required')
  // Deliberately resolved through the map rather than `requireNode`: answering an
  // unregistered node's question has to be a 404 about the question, not a
  // liveness refresh for a node that is not there.
  const entry = openQuestions.get(nodeId)?.get(questionId)
  if (entry === undefined) throw new HttpError(409, 'that question is no longer waiting for an answer')
  if (entry.settled) throw new HttpError(409, 'that question was already settled')
  // Ownership before vocabulary: a visitor answering somebody else's card must be
  // refused as a trespass rather than told whether their invented labels matched.
  if (viewer.role === 'guest' && entry.guestId !== viewer.guestId) {
    throw new HttpError(403, 'that question was not asked of this visitor')
  }
  const answers = admitAnswers(body.answers, entry.questions)
  if (answers === undefined) {
    throw new HttpError(400, 'answers must match the questions that were asked, using the option labels they offered')
  }
  entry.deliver({ questionId, answers })
  return { ok: true, questionId, commandId: entry.commandId }
}

// ── the guest door ─────────────────────────────────────────────────────────

/**
 * The client address a guest identity is metered against.
 *
 * Best effort, and deliberately so: behind the deployment's nginx the socket
 * address is always the proxy, which would collapse every visitor into one
 * bucket, so the forwarded chain is used instead. A client can put anything in
 * that chain — which is acceptable here because this counter is a speed bump
 * against bulk minting, not an authorization decision.
 *
 * @param {import('node:http').IncomingMessage} req - the request.
 * @returns {string} a bucket key.
 */
function clientAddress(req) {
  const forwarded = req.headers['x-forwarded-for']
  if (typeof forwarded === 'string' && forwarded.trim() !== '') return forwarded.split(',')[0].trim()
  return req.socket.remoteAddress ?? 'unknown'
}

/** Drop guest identities that have not been used within their lifetime. */
function sweepGuestTokens() {
  const now = Date.now()
  for (const [token, record] of guestTokens) {
    if (now - record.lastSeenAt > config.guestTokenTtlMs) {
      guestTokens.delete(token)
      guestSessions.delete(record.guestId)
    }
  }
  for (const [address, stamps] of guestEnters) {
    const recent = stamps.filter((at) => now - at < 3_600_000)
    if (recent.length === 0) guestEnters.delete(address)
    else guestEnters.set(address, recent)
  }
}

/**
 * Resolve a presented guest token into a viewer, refreshing its liveness.
 *
 * @param {string|undefined} token - the token the page holds.
 * @returns {{ role: 'guest', guestId: string }|undefined} the viewer, or undefined when unusable.
 */
function guestViewer(token) {
  if (typeof token !== 'string' || token === '') return undefined
  const record = guestTokens.get(token)
  if (record === undefined) return undefined
  if (Date.now() - record.lastSeenAt > config.guestTokenTtlMs) {
    guestTokens.delete(token)
    guestSessions.delete(record.guestId)
    return undefined
  }
  record.lastSeenAt = Date.now()
  return { role: 'guest', guestId: record.guestId }
}

/**
 * `POST /api/guest/enter` — mint an anonymous visitor identity.
 *
 * This is the only route with no credential at all, which is the point of the
 * feature and the reason it is also the only route that is metered: without a
 * limit, a script could mint identities without bound, and every identity is a
 * conversation this machine may be asked to run.
 *
 * @param {import('node:http').IncomingMessage} req - the request, for its address.
 * @returns {object} `{ token, guestId, expiresInMs }`.
 */
function guestEnter(req) {
  sweepGuestTokens()
  const address = clientAddress(req)
  const recent = guestEnters.get(address) ?? []
  if (recent.length >= config.guestEntersPerHour) {
    throw new HttpError(429, 'too many guest sessions from this address in the last hour; try again later')
  }
  if (guestTokens.size >= config.guestMaxVisitors) {
    throw new HttpError(503, 'this relay is at its guest capacity; try again later')
  }
  recent.push(Date.now())
  guestEnters.set(address, recent)
  const token = randomUUID()
  const guestId = `guest-${randomUUID().slice(0, 12)}`
  guestTokens.set(token, { guestId, createdAt: Date.now(), lastSeenAt: Date.now() })
  return { token, guestId, expiresInMs: config.guestTokenTtlMs }
}

/**
 * `GET /api/events` — server-sent roster and transcript updates.
 *
 * The control page is a thin client: every fact it renders arrives here. The
 * subscriber's view is registered with the stream, because the same event means
 * different things to the operator and to a visitor.
 *
 * @param {import('node:http').ServerResponse} res - response to hold open.
 * @param {{ role: string, guestId: string }} [viewer] - who is subscribing.
 */
function controlEvents(res, viewer = OWNER_VIEW) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write('retry: 3000\n\n')
  const subscriber = { res, viewer }
  res.write(
    `data: ${JSON.stringify({ type: 'roster', nodes: visibleNodes(viewer).map((node) => publicNode(node, viewer)) })}\n\n`
  )
  subscribers.add(subscriber)
  const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 15_000)
  res.on('close', () => {
    clearInterval(keepAlive)
    subscribers.delete(res)
  })
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

/** An error carrying the HTTP status the client should see. */
class HttpError extends Error {
  /**
   * @param {number} status - HTTP status code.
   * @param {string} message - client-facing message.
   */
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** Cache of the static control page, read once per process. */
let pagePromise

/**
 * Serve the control page, told where it is mounted when behind a prefix.
 *
 * The page resolves its own API calls against its document base, so the same file
 * works at `/` and at any sub-path. What it cannot know on its own is the
 * *public* prefix when a reverse proxy strips it: the browser asked for
 * `/harness/`, the relay sees `/`, and without a hint the page would resolve
 * `/api/...` against the origin root — where another site, not this relay, is
 * listening. Proxy locations in this project therefore send
 * `X-Forwarded-Prefix`, and this injects it as a `<base>` for HTML only. Data
 * responses are untouched, so every API path stays root-relative on the wire.
 *
 * @param {import('node:http').ServerResponse} res - response.
 * @param {unknown} forwardedPrefix - prefix reported by the proxy, if any.
 */
async function servePage(res, forwardedPrefix) {
  pagePromise ??= readFile(join(HERE, 'public', 'index.html'), 'utf8')
  let html = await pagePromise
  const prefix = normalizePrefix(forwardedPrefix)
  if (prefix !== '') {
    const base = `<base href="${prefix}/">`
    html = html.includes('<head>') ? html.replace('<head>', `<head>\n${base}`) : `${base}\n${html}`
  }
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html),
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer'
  })
  res.end(html)
}

/**
 * Normalize a proxy-supplied mount prefix.
 *
 * Anything that is not a plain path is rejected, so a hostile or buggy proxy
 * cannot inject markup through the `<base>` tag it feeds.
 *
 * @param {unknown} value - raw header value.
 * @returns {string} a safe prefix such as `/harness`, or the empty string.
 */
function normalizePrefix(value) {
  if (typeof value !== 'string') return ''
  const trimmed = value.trim().replace(/\/+$/, '')
  if (trimmed === '' || trimmed === '/') return ''
  return /^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(trimmed) ? trimmed : ''
}

/**
 * Every route and the method it accepts.
 *
 * Routing is table-driven so that "does this path exist" and "is this the right
 * verb" stay separate answers. The guest routes are a separate namespace rather
 * than a flag on the operator's routes: the two audiences are authorized by
 * different credentials, and a URL that means "act as the operator" must not be
 * reachable with a visitor's token even by accident.
 */
const ROUTE_METHODS = {
  '/api/agent/hello': 'POST',
  '/api/agent/poll': 'POST',
  '/api/agent/report': 'POST',
  '/api/agent/ask': 'POST',
  '/api/agent/question/settled': 'POST',
  '/api/command': 'POST',
  '/api/answer': 'POST',
  '/api/guest/enter': 'POST',
  '/api/guest/state': 'GET',
  '/api/guest/events': 'GET',
  '/api/guest/command': 'POST',
  '/api/guest/answer': 'POST'
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay.invalid')
  const token = presentedToken(req, url)

  const run = async () => {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/guest' || url.pathname === '/guest/')) {
      // The same page file serves both audiences; it reads which one it is from
      // its own URL and calls the matching API namespace.
      await servePage(res, req.headers['x-forwarded-prefix'])
      return
    }

    const isAgentRoute = url.pathname.startsWith('/api/agent/')
    const isGuestRoute = url.pathname.startsWith('/api/guest/')

    if (isGuestRoute && !config.guestEnabled) {
      // The relay's kill switch, answered before any token is looked at: closing
      // the door has to work without the cooperation of every node.
      sendJson(res, 404, { error: 'the guest door is closed on this relay' })
      return
    }

    /**
     * Who is calling, decided by credential and by route namespace.
     *
     * `undefined` means the credential was missing or wrong, and the only route
     * that may proceed without one is the guest entry point — that route mints the
     * identity every other guest route requires.
     *
     * @type {{ role: string, guestId: string }|undefined}
     */
    let viewer
    if (isAgentRoute) {
      viewer = token !== undefined && secretEquals(token, config.agentToken) ? { role: 'agent', guestId: '' } : undefined
    } else if (url.pathname === '/api/guest/enter') {
      viewer = { role: 'public', guestId: '' }
    } else if (isGuestRoute) {
      viewer = guestViewer(token)
    } else {
      viewer = token !== undefined && secretEquals(token, config.controlToken) ? OWNER_VIEW : undefined
    }
    if (viewer === undefined) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    // The EventSource subscriber cannot send headers, so its token rides the
    // query string and is the only route that accepts that form.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      controlEvents(res, viewer)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, controlState(url))
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/guest/events') {
      controlEvents(res, viewer)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/guest/state') {
      sendJson(res, 200, guestState(url, viewer))
      return
    }

    // Routing is resolved *before* the method check so that an unknown path is
    // a 404 rather than a 405: a caller that mistyped a route should be told the
    // route does not exist, not that it used the wrong verb on it.
    const method = ROUTE_METHODS[url.pathname]
    if (method === undefined) {
      sendJson(res, 404, { error: `no route for ${url.pathname}` })
      return
    }
    if (req.method !== method) {
      sendJson(res, 405, { error: `${url.pathname} accepts ${method}` })
      return
    }
    // The entry route is the one POST whose body is optional (the page sends
    // none), so its read is tolerant — but it still drains the request, since a
    // body left in the socket is a connection the next keep-alive request has to
    // wait behind.
    const raw = await readJsonBody(req)
    const body = url.pathname === '/api/guest/enter' ? (raw ?? {}) : raw
    if (body === null) {
      sendJson(res, 400, { error: 'body must be a JSON object' })
      return
    }
    switch (url.pathname) {
      case '/api/agent/hello':
        sendJson(res, 200, agentHello(body))
        return
      case '/api/agent/report':
        sendJson(res, 200, agentReport(body))
        return
      case '/api/agent/ask':
        await agentAsk(body, res)
        return
      case '/api/agent/question/settled':
        sendJson(res, 200, agentQuestionSettled(body))
        return
      case '/api/agent/poll':
        await agentPoll(body, res)
        return
      case '/api/answer':
        sendJson(res, 200, controlAnswer(body))
        return
      case '/api/guest/enter':
        sendJson(res, 200, guestEnter(req))
        return
      case '/api/guest/answer':
        sendJson(res, 200, guestAnswer(body, viewer))
        return
      case '/api/guest/command':
        sendJson(res, 200, guestCommand(body, viewer))
        return
      default:
        sendJson(res, 200, controlCommand(body))
    }
  }

  run().catch((error) => {
    const status = error instanceof HttpError ? error.status : 500
    if (!(error instanceof HttpError)) {
      process.stderr.write(`relay: ${req.method} ${url.pathname} failed: ${error?.stack ?? error}\n`)
    }
    if (!res.writableEnded) sendJson(res, status, { error: error?.message ?? 'internal error' })
  })
})

/** Mark nodes offline whose last poll is older than the threshold, and expire guest identities. */
const reaper = setInterval(() => {
  let changed = false
  const now = Date.now()
  for (const node of nodes.values()) {
    if (now - node.lastSeenAt > config.offlineAfterMs && node.status !== 'offline') {
      node.status = 'offline'
      node.detail = 'no poll within the liveness window'
      changed = true
    }
  }
  sweepGuestTokens()
  if (changed) broadcastRoster()
}, 5_000)
reaper.unref()

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `dsh-remote-control relay listening on http://${config.host}:${String(config.port)}` +
      `${config.publicOrigin === '' ? '' : ` (public: ${config.publicOrigin})`}` +
      `, guest door ${config.guestEnabled ? 'available' : 'closed'}\n`
  )
})

/**
 * Shut down cleanly: close the listener, then release every parked connection.
 *
 * @param {string} signal - the received signal name, for the log line.
 */
function shutdown(signal) {
  process.stdout.write(`relay: ${signal} received, closing\n`)
  for (const node of nodes.values()) {
    for (const waiter of node.waiters) waiter(null)
    node.waiters.clear()
  }
  // A held question is the one response that is not written by its own handler:
  // without this the node would sit in the client's read until its own timeout.
  for (const [nodeId, held] of openQuestions) {
    for (const entry of held.values()) entry.deliver({ questionId: entry.questionId, settled: true, reason: 'shutdown' })
    openQuestions.delete(nodeId)
  }
  for (const subscriber of subscribers) subscriber.res.end()
  subscribers.clear()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
