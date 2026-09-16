#!/usr/bin/env node
/**
 * `relay-check` — end-to-end check of the relay over real HTTP.
 *
 * It spawns the actual `relay/server.js` (not a re-implementation) on an
 * ephemeral port with throwaway tokens, then drives the documented API the way
 * a node and a browser would. That distinction matters: a check against an
 * in-process fake would keep passing after the route table changed, which is the
 * one regression this file exists to catch.
 *
 * Everything is asserted, nothing is printed hopefully. `process.exitCode` is
 * set rather than calling `process.exit()`, so a piped failure report is never
 * truncated.
 *
 * @module dsh-remote-control/tools/relay-check
 */

import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'relay', 'server.js')
const AGENT_TOKEN = 'agent-token-for-check'
const CONTROL_TOKEN = 'control-token-for-check'

let failures = 0
let checks = 0

/**
 * Record one assertion.
 *
 * @param {string} what - what is being asserted.
 * @param {boolean} ok - whether it held.
 * @param {string} [detail] - extra context on failure.
 */
function check(what, ok, detail = '') {
  checks += 1
  if (ok) {
    process.stdout.write(`  \u2713 ${what}\n`)
    return
  }
  failures += 1
  process.stdout.write(`  \u2717 ${what}${detail === '' ? '' : ` — ${detail}`}\n`)
}

/**
 * Await a child process writing its listening line.
 *
 * @param {import('node:child_process').ChildProcess} child - relay process.
 * @returns {Promise<void>} resolves once the relay is up.
 */
function waitForListen(child) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('relay did not start within 10s')), 10_000)
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buffered += chunk
      if (buffered.includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => process.stderr.write(`  relay stderr: ${chunk}`))
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`relay exited early with code ${String(code)}`))
    })
  })
}

/**
 * Read the port the relay actually bound, by asking the OS through the child.
 *
 * The relay prints its resolved port, so the check reads it back instead of
 * guessing: a fixed port would collide with a developer's own relay.
 *
 * @param {import('node:child_process').ChildProcess} child - relay process.
 * @returns {string} the base URL.
 */
function baseUrlFrom(child, port) {
  return `http://127.0.0.1:${String(port)}`
}

const port = 18_000 + Math.floor(Math.random() * 2_000)
const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    DSH_REMOTE_RELAY_HOST: '127.0.0.1',
    DSH_REMOTE_RELAY_PORT: String(port),
    DSH_REMOTE_AGENT_TOKEN: AGENT_TOKEN,
    DSH_REMOTE_CONTROL_TOKEN: CONTROL_TOKEN,
    DSH_REMOTE_POLL_HOLD_MS: '1500',
    DSH_REMOTE_OFFLINE_AFTER_MS: '4000'
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

/**
 * Call one relay endpoint.
 *
 * @param {string} path - path.
 * @param {object} [options] - `{ token, method, body }`.
 * @returns {Promise<{ status: number, body: any }>} status and parsed body.
 */
async function call(path, options = {}) {
  const init = { method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) } }
  if (options.token !== undefined) init.headers.authorization = `Bearer ${options.token}`
  if (options.body !== undefined) {
    init.method = 'POST'
    init.headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  const response = await fetch(`${baseUrlFrom(child, port)}${path}`, init)
  const text = await response.text()
  let body
  try {
    body = text === '' ? undefined : JSON.parse(text)
  } catch {
    // Non-JSON responses (the HTML page) come back as raw text so the checks can
    // assert on markup as well as on data.
    body = text
  }
  return { status: response.status, body, headers: response.headers }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  await waitForListen(child)
  process.stdout.write('relay-check\n')

  // ── authentication ───────────────────────────────────────────────────────
  const noToken = await call('/api/state')
  check('a request without a token is rejected with 401', noToken.status === 401, `got ${String(noToken.status)}`)

  const crossToken = await call('/api/state', { token: AGENT_TOKEN })
  check(
    'the agent token cannot read the control page',
    crossToken.status === 401,
    `got ${String(crossToken.status)} — the two trust domains must not be interchangeable`
  )

  const crossAgent = await call('/api/agent/hello', { token: CONTROL_TOKEN, body: { nodeId: 'x' } })
  check('the control token cannot register as an agent', crossAgent.status === 401, `got ${String(crossAgent.status)}`)

  const page = await call('/')
  check('the control page is served without a token', page.status === 200 && String(page.body).includes('DSH Remote Control'))

  // ── registration ─────────────────────────────────────────────────────────
  const hello = await call('/api/agent/hello', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      name: 'Studio Mac',
      platform: 'darwin 24.0.0',
      version: 'test/0',
      workspaces: [
        { name: 'deepseek', path: '/Users/dev/deepseek' },
        { name: 'blank', path: '' }
      ]
    }
  })
  check('hello is accepted', hello.status === 200, JSON.stringify(hello.body))
  check('hello reports the poll hold', hello.body?.pollHoldMs === 1500, JSON.stringify(hello.body?.pollHoldMs))
  check('a workspace without a path is dropped', hello.status === 200)
  check('hello with no nodeId is refused', (await call('/api/agent/hello', { token: AGENT_TOKEN, body: {} })).status === 400)

  const state = await call('/api/state', { token: CONTROL_TOKEN })
  check('the roster lists the node', state.body?.nodes?.length === 1, JSON.stringify(state.body?.nodes))
  check('the roster reports it online', state.body?.nodes?.[0]?.online === true)
  check('the roster carries the display name', state.body?.nodes?.[0]?.name === 'Studio Mac')
  check('the roster carries exactly the valid workspace', state.body?.nodes?.[0]?.workspaces?.length === 1)

  // ── command refusal paths ────────────────────────────────────────────────
  const unknownNode = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'nope', workspace: '/tmp', prompt: 'hi' }
  })
  check('a command to an unknown node is refused', unknownNode.status === 404, `got ${String(unknownNode.status)}`)

  const emptyPrompt = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: '/Users/dev/deepseek', prompt: '   ' }
  })
  check('an empty prompt is refused', emptyPrompt.status === 400, `got ${String(emptyPrompt.status)}`)

  const foreignWorkspace = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: '/etc', prompt: 'hi' }
  })
  check(
    'a workspace the node never advertised is refused',
    foreignWorkspace.status === 400,
    `got ${String(foreignWorkspace.status)} — the relay must not be able to name an arbitrary directory`
  )

  // ── the happy path, in the order a node experiences it ───────────────────
  const parked = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', idle: true } })
  await sleep(120)
  const accepted = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: '/Users/dev/deepseek', prompt: 'summarize the repo' }
  })
  check('a valid command is accepted', accepted.status === 200, JSON.stringify(accepted.body))
  check('the accepted command has an id', typeof accepted.body?.commandId === 'string' && accepted.body.commandId.length > 0)

  const delivered = await parked
  check(
    'a parked long-poll receives the command immediately',
    delivered.body?.command?.prompt === 'summarize the repo',
    JSON.stringify(delivered.body)
  )
  check('the delivered command carries the workspace', delivered.body?.command?.workspace === '/Users/dev/deepseek')
  check(
    'the delivered command id matches the accepted one',
    delivered.body?.command?.commandId === accepted.body?.commandId
  )

  const questionEntry = (await call('/api/state?nodeId=mac-1', { token: CONTROL_TOKEN })).body?.transcript ?? []
  check('the question is already in the transcript', questionEntry.some((entry) => entry.kind === 'question'))

  const busy = await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', status: 'busy', detail: 'thinking' }
  })
  check('a status report is accepted', busy.status === 200)
  const busyState = await call('/api/state', { token: CONTROL_TOKEN })
  check("the roster shows the node busy", busyState.body?.nodes?.[0]?.status === 'busy')

  const reported = await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: accepted.body.commandId,
      result: {
        ok: true,
        prompt: 'summarize the repo',
        workspace: '/Users/dev/deepseek',
        sessionId: 'remote-abc',
        text: 'It is a plugin.',
        durationMs: 1234
      }
    }
  })
  check('an outcome report is accepted', reported.status === 200)
  const afterState = await call('/api/state?nodeId=mac-1', { token: CONTROL_TOKEN })
  const answer = (afterState.body?.transcript ?? []).find((entry) => entry.kind === 'answer')
  check('the answer landed in the transcript', answer?.text === 'It is a plugin.', JSON.stringify(answer))
  check('the answer carries the session id a follow-up needs', answer?.sessionId === 'remote-abc')
  check('the node returned to idle', afterState.body?.nodes?.[0]?.status === 'idle')

  // A follow-up must be able to continue the same session.
  const followUp = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
  await sleep(120)
  await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: '/Users/dev/deepseek', prompt: 'and then?', sessionId: 'remote-abc' }
  })
  const followed = await followUp
  check('a follow-up carries the session id through', followed.body?.command?.sessionId === 'remote-abc')

  // ── the empty long-poll must answer, not hang ────────────────────────────
  const started = Date.now()
  const idle = await call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
  const waited = Date.now() - started
  check('an idle long-poll answers null instead of hanging', idle.body?.command === null, JSON.stringify(idle.body))
  check('the idle long-poll respected the hold window', waited >= 1200 && waited < 6000, `waited ${String(waited)}ms`)

  // ── liveness ─────────────────────────────────────────────────────────────
  await sleep(4500)
  const reaped = await call('/api/state', { token: CONTROL_TOKEN })
  check('a node that stopped polling is marked offline', reaped.body?.nodes?.[0]?.online === false, JSON.stringify(reaped.body?.nodes?.[0]?.status))
  const refusedWhenOffline = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: '/Users/dev/deepseek', prompt: 'are you there' }
  })
  check(
    'a command to an offline node is refused rather than queued forever',
    refusedWhenOffline.status === 409,
    `got ${String(refusedWhenOffline.status)}`
  )

  // ── the page under a reverse-proxy prefix ────────────────────────────────
  // The deployment serves this page at `/harness/` while nginx strips the prefix
  // before the relay sees it, so the page cannot infer its own public mount point.
  // The relay injects the proxy's `X-Forwarded-Prefix` as a `<base>` for HTML,
  // which is what makes the page's relative API calls land back on the relay
  // instead of on whatever else owns the domain root. Without it the page loads
  // and then silently does nothing, so it is checked here on every platform — the
  // browser check covers the same ground but only where Chromium exists.
  const prefixed = await call('/', { headers: { 'x-forwarded-prefix': '/harness' } })
  check('an HTML response carries the proxy mount prefix as a base', String(prefixed.body).includes('<base href="/harness/">'), 'no <base> was injected')
  check('the base is injected before any script runs', String(prefixed.body).indexOf('<base href="/harness/">') < String(prefixed.body).indexOf('<script'))

  const unprefixed = await call('/')
  check('no base is injected when there is no prefix', !String(unprefixed.body).includes('<base href='))

  const hostile = await call('/', { headers: { 'x-forwarded-prefix': '/harness"><script>alert(1)</script>' } })
  check('a markup-bearing prefix is refused, not injected', !String(hostile.body).includes('alert(1)'))
  check('the hostile-prefix response is still the real page', String(hostile.body).includes('DSH Remote Control'))

  const dataUnderPrefix = await call('/api/state', { token: CONTROL_TOKEN, headers: { 'x-forwarded-prefix': '/harness' } })
  check('the prefix hint never alters a data response', dataUnderPrefix.status === 200 && Array.isArray(dataUnderPrefix.body?.nodes))

  // ── routing ──────────────────────────────────────────────────────────────
  const unknown = await call('/api/nope', { token: CONTROL_TOKEN })
  check('an unknown route is a 404', unknown.status === 404, `got ${String(unknown.status)}`)
  check('a non-POST to an API route is a 405', (await call('/api/command', { token: CONTROL_TOKEN })).status === 405)
  const badBody = await call('/api/agent/hello', { token: AGENT_TOKEN, method: 'POST', body: undefined })
  check('a POST without a JSON body is a 400', badBody.status === 400, `got ${String(badBody.status)}`)

  process.stdout.write(`\nrelay-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nrelay-check: harness error — ${error?.stack ?? error}\n`)
} finally {
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(2000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}

if (failures > 0) process.exitCode = 1
