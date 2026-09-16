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
    queued: node.queue.length
  }
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
  '/api/command': 'POST'
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
      case '/api/agent/poll':
        await agentPoll(body, res)
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
  for (const res of subscribers) res.end()
  subscribers.clear()
  server.close(() => process.exit(0))
  setTimeout(() => process.exit(0), 2_000).unref()
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
