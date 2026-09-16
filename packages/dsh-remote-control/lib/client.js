/**
 * The wire between this node and the relay.
 *
 * It is a thin `fetch` wrapper, not a protocol implementation: every exchange
 * is one JSON request and one JSON response, because long-polling was chosen
 * over a socket precisely so this file needs nothing but Node built-ins. That
 * matters for the install story — a Windows machine with a stock Node install
 * can run this plugin with no `pnpm add`.
 *
 * Every call carries the node's own token. The relay keeps a *separate* token
 * for the browser page, so a leaked control token cannot impersonate a node
 * and a leaked node token cannot read other nodes' transcripts.
 *
 * @module dsh-remote-control/client
 */

/** The relay refused this node's token. Retrying cannot help. */
export class RelayAuthError extends Error {
  /** @param {string} message - server-supplied reason. */
  constructor(message) {
    super(message)
    this.name = 'RelayAuthError'
  }
}

/** The relay is unreachable, slow, or answered nonsense. Retrying can help. */
export class RelayUnreachableError extends Error {
  /** @param {string} message - what went wrong. */
  constructor(message) {
    super(message)
    this.name = 'RelayUnreachableError'
  }
}

/**
 * Normalize a configured relay URL to an origin without a trailing slash.
 *
 * @param {string} relayUrl - user-configured base URL.
 * @returns {string} the normalized origin.
 * @throws {TypeError} when the value is not an absolute http(s) URL.
 */
export function normalizeRelayUrl(relayUrl) {
  let parsed
  try {
    parsed = new URL(relayUrl)
  } catch {
    throw new TypeError(`relayUrl must be an absolute URL, got ${JSON.stringify(relayUrl)}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TypeError(`relayUrl must use http or https, got ${JSON.stringify(parsed.protocol)}`)
  }
  return parsed.origin + parsed.pathname.replace(/\/+$/, '')
}

/** One node's view of the relay. */
export class RelayClient {
  /**
   * @param {object} options - `{ relayUrl, nodeToken, fetchImpl?, logger? }`.
   */
  constructor({ relayUrl, nodeToken, fetchImpl, logger }) {
    /** Normalized relay base URL. */
    this.baseUrl = normalizeRelayUrl(relayUrl)
    /** Token this node presents. */
    this.nodeToken = nodeToken
    this.fetch = fetchImpl ?? globalThis.fetch
    this.logger = logger
    if (typeof this.fetch !== 'function') {
      throw new RelayUnreachableError('global fetch is unavailable; dsh-remote-control needs Node 18 or newer')
    }
  }

  /**
   * Perform one authenticated POST.
   *
   * @param {string} path - relay path starting with `/`.
   * @param {object} body - JSON request body.
   * @param {object} [options] - `{ timeoutMs }`; omit to wait indefinitely.
   * @returns {Promise<object>} parsed response body.
   */
  async post(path, body, options = {}) {
    const signal = options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs)
    let response
    try {
      response = await this.fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.nodeToken}`
        },
        body: JSON.stringify(body),
        ...(signal === undefined ? {} : { signal })
      })
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.message ?? String(error))
      throw new RelayUnreachableError(`${path} failed: ${reason}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new RelayAuthError(`relay rejected this node's token (HTTP ${String(response.status)})`)
    }
    if (!response.ok) {
      throw new RelayUnreachableError(`${path} answered HTTP ${String(response.status)}`)
    }
    try {
      const payload = await response.json()
      if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
        throw new Error('response was not a JSON object')
      }
      return payload
    } catch (error) {
      throw new RelayUnreachableError(`${path} returned an unreadable body: ${error.message}`)
    }
  }

  /**
   * Announce this node and learn the relay's current hold window.
   *
   * @param {object} identity - `{ nodeId, name, platform, version, workspaces }`.
   * @returns {Promise<{ pollHoldMs?: number }>} relay acknowledgement.
   */
  hello(identity) {
    return this.post('/api/agent/hello', identity, { timeoutMs: 15_000 })
  }

  /**
   * Park one long-poll for the next command.
   *
   * The timeout is deliberately longer than the relay's own hold so that a
   * healthy "no work" answer is never mistaken for a dead relay; the abort is
   * only a backstop against a half-open connection.
   *
   * @param {object} body - `{ nodeId, idle }`.
   * @param {number} holdMs - the relay's advertised hold window.
   * @param {AbortSignal} [signal] - node shutdown.
   * @returns {Promise<object|null>} the command, or null when there was none.
   */
  async poll(body, holdMs, signal) {
    const timeoutMs = Math.max(holdMs + 15_000, 20_000)
    const timeout = AbortSignal.timeout(timeoutMs)
    const combined = signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    let response
    try {
      response = await this.fetch(`${this.baseUrl}/api/agent/poll`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${this.nodeToken}`
        },
        body: JSON.stringify(body),
        signal: combined
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      const reason = error?.name === 'TimeoutError' ? 'timed out' : (error?.message ?? String(error))
      throw new RelayUnreachableError(`/api/agent/poll failed: ${reason}`)
    }
    if (response.status === 401 || response.status === 403) {
      throw new RelayAuthError(`relay rejected this node's token (HTTP ${String(response.status)})`)
    }
    if (!response.ok) throw new RelayUnreachableError(`/api/agent/poll answered HTTP ${String(response.status)}`)
    const payload = await response.json()
    const command = payload?.command
    return command === null || command === undefined ? null : command
  }

  /**
   * Report status and, when a command finished, its outcome.
   *
   * @param {object} body - `{ nodeId, status?, detail?, commandId?, result? }`.
   * @returns {Promise<void>} resolves once the relay acknowledged.
   */
  async report(body) {
    await this.post('/api/agent/report', body, { timeoutMs: 20_000 })
  }

  /**
   * Best-effort report that never throws, for shutdown paths.
   *
   * @param {object} body - report body.
   */
  async reportQuietly(body) {
    try {
      await this.report(body)
    } catch {
      /* a node that is going away has nothing useful to say about a failure */
    }
  }
}
