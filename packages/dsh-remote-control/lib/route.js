/**
 * `dsh-remote-control` — the one route the settings card calls.
 *
 * Invite codes are minted by the relay (it is the only party a visitor talks to,
 * so it has to be the one that accepts or refuses a code), and the operator needs
 * a way to ask for one from inside the Harness rather than by `ssh`-ing to a
 * server. That is this route: `POST /dsh-remote-control/api/invite`, called by the
 * card in this package's browser half, answered with a fresh code.
 *
 * The shape follows the sibling `dsh-git-repos` package, which publishes its own
 * JSON RPC surface the same way. Two properties are deliberate:
 *
 * - **The route reads the *live* node, not a captured one.** A settings edit tears
 *   the node down and builds a new one, so a handler that captured the client at
 *   load time would keep answering with a dead object. It reads through a getter
 *   that the node lifecycle keeps current.
 * - **Nothing is trusted from the caller.** The route mints a code for the
 *   configured node id, whatever the request body says; there is no parameter to
 *   aim it somewhere else. A route that could name any machine would be a way to
 *   invite a stranger to a door the operator did not choose.
 *
 * @module dsh-remote-control/route
 */

import { RelayAuthError, RelayUnreachableError } from './client.js'

/** The prefix this plugin owns on the Harness's own web server. */
export const ROUTE_PATH = '/dsh-remote-control/api'

/**
 * Build the request handler.
 *
 * @param {() => ({ client: object, nodeId: string }|undefined)} liveNode - the currently running node, if any.
 * @returns {(req: object, res: object) => Promise<void>} the handler.
 */
export function createInviteHandler(liveNode) {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://dsh.internal')
    const method = url.pathname.startsWith(`${ROUTE_PATH}/`) ? url.pathname.slice(ROUTE_PATH.length + 1) : ''

    if (req.method === 'GET' && method === 'health') {
      const node = liveNode()
      sendJson(res, 200, { ok: true, value: { connected: node !== undefined, nodeId: node?.nodeId ?? '' } })
      return
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { ok: false, error: { message: 'method not allowed' } })
      return
    }
    if (method !== 'invite') {
      sendJson(res, 404, { ok: false, error: { message: `unknown method: ${method === '' ? '(none)' : method}` } })
      return
    }

    const node = liveNode()
    if (node === undefined) {
      sendJson(res, 503, {
        ok: false,
        error: { message: '这个节点还没有连上中转台，生成邀请码需要连上之后才能做（先看卡片里的中转台地址和节点令牌）。' }
      })
      return
    }

    try {
      // The body is drained and ignored: inviting is not configurable, and a body
      // that could aim the invite at another machine is exactly what must not exist.
      await drain(req)
      const value = await node.client.createInvite(node.nodeId)
      sendJson(res, 200, { ok: true, value })
    } catch (error) {
      // Two failures worth telling apart, because the operator can fix one of them
      // in this very card and cannot fix the other: a rejected token is a
      // configuration mistake, an unreachable relay is the network's.
      const tokenProblem = error instanceof RelayAuthError
      const status = tokenProblem ? 409 : error instanceof RelayUnreachableError ? 502 : 500
      sendJson(res, status, {
        ok: false,
        error: {
          message: tokenProblem
            ? `中转台不认这台机器的节点令牌：${error.message}。把它改对之后立刻就能生成。`
            : `这次生成没能送到中转台：${error?.message ?? error}`
        }
      })
    }
  }
}

/**
 * Read and discard a request body, so a keep-alive connection is not left with
 * bytes the next request has to wait behind.
 *
 * @param {object} req - the request.
 * @returns {Promise<void>} resolves once the body was consumed.
 */
async function drain(req) {
  try {
    for await (const _chunk of req) {
      /* nothing to read */
    }
  } catch {
    /* a body we cannot read is not a reason to refuse the invite */
  }
}

/**
 * Write one JSON response.
 *
 * @param {object} res - the response.
 * @param {number} status - HTTP status.
 * @param {unknown} body - the payload.
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
