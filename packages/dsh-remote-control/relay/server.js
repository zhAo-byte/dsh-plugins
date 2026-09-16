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
  publicOrigin: process.env.DSH_REMOTE_PUBLIC_ORIGIN ?? ''
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
/** @type {Map<string, {nodeId: string, commandId: string}>} */
const inFlight = new Map()
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
/** @type {Set<import('node:http').ServerResponse>} browser event-stream subscribers */
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

/**
 * Public projection of a node: what the control page is allowed to know.
 *
 * @param {NodeRecord} node - stored record.
 * @returns {object} page-facing shape.
 */
function publicNode(node) {
  const online = Date.now() - node.lastSeenAt <= config.offlineAfterMs
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
    questions: pendingQuestionsOf(node.nodeId)
  }
}

/**
 * The public projection of one node's pending questions.
 *
 * @param {string} nodeId - owning node.
 * @returns {Array<object>} questions the page may render and answer.
 */
function pendingQuestionsOf(nodeId) {
  const held = openQuestions.get(nodeId)
  if (held === undefined) return []
  return [...held.values()].map((entry) => ({
    questionId: entry.questionId,
    commandId: entry.commandId,
    workspace: entry.workspace,
    at: entry.at,
    questions: entry.questions
  }))
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
  const payload = JSON.stringify({ type: 'questions', nodeId, questions: pendingQuestionsOf(nodeId) })
  for (const res of subscribers) res.write(`data: ${payload}\n\n`)
  broadcastRoster()
}
/** Notify every browser subscriber with the current roster. */
function broadcastRoster() {
  const payload = JSON.stringify({ type: 'roster', nodes: [...nodes.values()].map(publicNode) })
  for (const res of subscribers) {
    res.write(`data: ${payload}\n\n`)
  }
}

/**
 * Append one transcript line and fan it out to browsers.
 *
 * @param {NodeRecord} node - owning node.
 * @param {object} entry - transcript entry without `at` or `seq`.
 */
function appendTranscript(node, entry) {
  const record = { seq: (node.transcriptSeq += 1), at: Date.now(), nodeId: node.nodeId, ...entry }
  node.transcript.push(record)
  if (node.transcript.length > config.transcriptLimit) {
    node.transcript.splice(0, node.transcript.length - config.transcriptLimit)
  }
  const payload = JSON.stringify({ type: 'transcript', entry: record })
  for (const res of subscribers) res.write(`data: ${payload}\n\n`)
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
 * @param {object} body - `{ nodeId, name?, platform?, version?, workspaces? }`.
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
  node.lastSeenAt = Date.now()
  broadcastRoster()
  return { nodeId: node.nodeId, name: node.name, pollHoldMs: config.pollHoldMs }
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
    inFlight.delete(commandId)
    const result = body.result !== null && typeof body.result === 'object' ? body.result : {}
    appendTranscript(node, {
      kind: result.ok === true ? 'answer' : 'error',
      commandId,
      prompt: typeof result.prompt === 'string' ? result.prompt : '',
      workspace: typeof result.workspace === 'string' ? result.workspace : '',
      sessionId: typeof result.sessionId === 'string' ? result.sessionId : '',
      text: typeof result.text === 'string' ? result.text : '',
      error: typeof result.error === 'string' ? result.error : '',
      durationMs: typeof result.durationMs === 'number' ? result.durationMs : 0
    })
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
  const entry = {
    questionId,
    commandId,
    workspace,
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
 * @returns {object} roster plus requested transcript.
 */
function controlState(url) {
  const focus = url.searchParams.get('nodeId')
  return {
    nodes: [...nodes.values()].map(publicNode),
    transcript: focus === null ? [] : (nodes.get(focus)?.transcript ?? []),
    pollHoldMs: config.pollHoldMs,
    offlineAfterMs: config.offlineAfterMs
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
  if (Date.now() - node.lastSeenAt > config.offlineAfterMs) {
    throw new HttpError(409, `node ${node.nodeId} is offline; the command was not queued`)
  }
  const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
  if (prompt === '') throw new HttpError(400, 'prompt must not be empty')
  const workspace = typeof body.workspace === 'string' && body.workspace.trim() !== '' ? body.workspace.trim() : undefined
  if (workspace === undefined) throw new HttpError(400, 'workspace is required')
  const known = node.workspaces.some((entry) => entry.path === workspace)
  if (!known) throw new HttpError(400, `workspace ${JSON.stringify(workspace)} is not advertised by ${node.nodeId}`)
  const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() !== '' ? body.sessionId.trim() : undefined
  const command = {
    commandId: randomUUID(),
    kind: 'question',
    workspace,
    prompt,
    ...(sessionId === undefined ? {} : { sessionId }),
    issuedAt: Date.now()
  }
  inFlight.set(command.commandId, { nodeId: node.nodeId, commandId: command.commandId })
  appendTranscript(node, { kind: 'question', commandId: command.commandId, prompt, workspace, sessionId: sessionId ?? '' })
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
  const nodeId = typeof body.nodeId === 'string' ? body.nodeId.trim() : ''
  const questionId = typeof body.questionId === 'string' ? body.questionId.trim() : ''
  if (nodeId === '' || questionId === '') throw new HttpError(400, 'nodeId and questionId are required')
  // Deliberately resolved through the map rather than `requireNode`: answering an
  // unregistered node's question has to be a 404 about the question, not a
  // liveness refresh for a node that is not there.
  const entry = openQuestions.get(nodeId)?.get(questionId)
  if (entry === undefined) throw new HttpError(409, 'that question is no longer waiting for an answer')
  if (entry.settled) throw new HttpError(409, 'that question was already settled')
  const answers = admitAnswers(body.answers, entry.questions)
  if (answers === undefined) {
    throw new HttpError(400, 'answers must match the questions that were asked, using the option labels they offered')
  }
  entry.deliver({ questionId, answers })
  return { ok: true, questionId, commandId: entry.commandId }
}

/**
 * `GET /api/events` — server-sent roster and transcript updates.
 *
 * The control page is a thin client: every fact it renders arrives here.
 *
 * @param {import('node:http').ServerResponse} res - response to hold open.
 */
function controlEvents(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  })
  res.write('retry: 3000\n\n')
  res.write(`data: ${JSON.stringify({ type: 'roster', nodes: [...nodes.values()].map(publicNode) })}\n\n`)
  subscribers.add(res)
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
 * Every POST route and the method it accepts.
 *
 * Routing is table-driven so that "does this path exist" and "is this the right
 * verb" stay separate answers.
 */
const ROUTE_METHODS = {
  '/api/agent/hello': 'POST',
  '/api/agent/poll': 'POST',
  '/api/agent/report': 'POST',
  '/api/agent/ask': 'POST',
  '/api/agent/question/settled': 'POST',
  '/api/command': 'POST',
  '/api/answer': 'POST'
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay.invalid')
  const token = presentedToken(req, url)

  const run = async () => {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      await servePage(res, req.headers['x-forwarded-prefix'])
      return
    }

    const isAgentRoute = url.pathname.startsWith('/api/agent/')
    const expected = isAgentRoute ? config.agentToken : config.controlToken
    if (token === undefined || !secretEquals(token, expected)) {
      sendJson(res, 401, { error: 'unauthorized' })
      return
    }

    // The EventSource subscriber cannot send headers, so its token rides the
    // query string and is the only route that accepts that form.
    if (req.method === 'GET' && url.pathname === '/api/events') {
      controlEvents(res)
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/state') {
      sendJson(res, 200, controlState(url))
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
    const body = await readJsonBody(req)
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

/** Mark nodes offline whose last poll is older than the threshold. */
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
  if (changed) broadcastRoster()
}, 5_000)
reaper.unref()

server.listen(config.port, config.host, () => {
  process.stdout.write(
    `dsh-remote-control relay listening on http://${config.host}:${String(config.port)}` +
      `${config.publicOrigin === '' ? '' : ` (public: ${config.publicOrigin})`}\n`
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
  for (const res of subscribers) res.end()
  subscribers.clear()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
