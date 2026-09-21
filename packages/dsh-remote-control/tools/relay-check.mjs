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

import { spawnGuarded, stopGuarded, trackedCount } from './spawn-guard.mjs'
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
const child = spawnGuarded(process.execPath, [SERVER], {
  env: {
    ...process.env,
    DSH_REMOTE_RELAY_HOST: '127.0.0.1',
    DSH_REMOTE_RELAY_PORT: String(port),
    DSH_REMOTE_AGENT_TOKEN: AGENT_TOKEN,
    DSH_REMOTE_CONTROL_TOKEN: CONTROL_TOKEN,
    DSH_REMOTE_POLL_HOLD_MS: '1500',
    DSH_REMOTE_OFFLINE_AFTER_MS: '4000',
    // Small enough to exercise the mint limit inside one check run, and explicit
    // so the assertion does not depend on the shipped default staying 20.
    DSH_REMOTE_GUEST_ENTERS_PER_HOUR: '3',
    DSH_REMOTE_GUEST_MAX_PROMPT: '200'
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
  // The liveness window rides the ack so a node can keep its "still working"
  // heartbeat inside it. Without this a long turn is reported as an offline
  // machine, and the relay then refuses the next question instead of queueing it.
  check(
    'hello reports the liveness window the heartbeat must fit',
    hello.body?.offlineAfterMs === 4000,
    JSON.stringify(hello.body?.offlineAfterMs)
  )
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
  // Close the follow-up before the question exercise: a question is attributed to
  // the turn that is running *now*, and leaving the previous turn in flight would
  // make that attribution ambiguous rather than wrong.
  await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: followed.body.command.commandId,
      result: { ok: true, prompt: 'and then?', workspace: '/Users/dev/deepseek', text: 'done', durationMs: 1 }
    }
  })

  // ── the agent's own question, held open for the page ─────────────────────
  // This is the second long-poll of the protocol: the node's `ask_user_question`
  // is a blocking call, so the question has to be parked the same way a command
  // is. The checks below are written in the order the two halves experience it —
  // park, render, answer, settle — because every failure mode here is a hang on
  // one side or the other.
  const asExercise = '/Users/dev/deepseek'
  // The order matters and mirrors the real thing: the command is submitted first,
  // which is what puts it in flight, and only then does the agent ask. Asking
  // first would make the question unattributable — the `commandId` is what tells
  // the page which tab the card belongs to.
  const exerciseCommand = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
  await sleep(150)
  const askedCommand = await call('/api/command', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', workspace: asExercise, prompt: 'review my change' }
  })
  const deliveredExercise = await exerciseCommand
  check('the turn that will ask the question was delivered', deliveredExercise.body?.command?.commandId === askedCommand.body?.commandId)
  const parkedAsk = call('/api/agent/ask', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      questions: [
        { id: 'scope', header: '范围', question: '要包含哪一部分？', options: [{ label: '全部' }, { label: '仅改动' }] }
      ]
    }
  })
  await sleep(150)

  // Subscribe after the park so the push below is unambiguous, but the state
  // snapshot is checked first: a page that loads mid-question must see the card
  // from `/api/state` alone, since it missed every push that came before it.
  const askedState = await call('/api/state', { token: CONTROL_TOKEN })
  const pending = askedState.body?.nodes?.[0]?.questions ?? []
  check('the roster carries the pending question', pending.length === 1, JSON.stringify(pending))
  check('the pending question names the command it belongs to', pending[0]?.commandId === askedCommand.body?.commandId, JSON.stringify(pending[0]))
  check(
    'the pending question is attributed to the workspace of that command',
    pending[0]?.workspace === asExercise,
    `got ${JSON.stringify(pending[0]?.workspace)} — without it the page renders the card in the wrong tab`
  )
  check('the pending question never carries the calling agent', pending[0]?.agent === undefined && pending[0]?.signal === undefined)
  check('the page sees the options the model offered', pending[0]?.questions?.[0]?.options?.length === 2, JSON.stringify(pending[0]?.questions))

  const questionId = pending[0]?.questionId
  check('the question has an id to answer against', typeof questionId === 'string' && questionId.length > 0)

  // A second question on the same node is a bug, not a queue: the node runs one
  // turn at a time and its agent is blocked on the first one. The refusal must
  // also leave the first question untouched — a rejected duplicate that dropped
  // the live card would be worse than accepting it.
  const stacked = await call('/api/agent/ask', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', questions: [{ id: 'other', question: 'second?' }] }
  })
  check('a second open question on one node is refused', stacked.status === 409, `got ${String(stacked.status)}`)
  const afterStacked = await call('/api/state', { token: CONTROL_TOKEN })
  check(
    'the refused duplicate left the first question open',
    afterStacked.body?.nodes?.[0]?.questions?.[0]?.questionId === questionId,
    JSON.stringify(afterStacked.body?.nodes?.[0]?.questions)
  )

  const badQuestions = await call('/api/agent/ask', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', questions: [] } })
  check('a question list with nothing askable is refused', badQuestions.status === 400, `got ${String(badQuestions.status)}`)

  // The relay is a separate trust domain: an option it invents must not reach the
  // model, because the model would read it as a choice it had offered.
  const invented = await call('/api/answer', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', questionId, answers: [{ id: 'scope', selected: ['delete everything'] }] }
  })
  check('an answer using an option that was never offered is refused', invented.status === 400, `got ${String(invented.status)}`)

  const unanswered = await call('/api/answer', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', questionId, answers: [{ id: 'scope', selected: [] }] }
  })
  check('skipping every question is accepted as a blank answer', unanswered.status === 200, JSON.stringify(unanswered.body))

  const parkedQuestion = await parkedAsk
  check('the parked ask returned the page answer', parkedQuestion.body?.answers?.[0]?.id === 'scope', JSON.stringify(parkedQuestion.body))
  check('the blank answer carries an empty selection', Array.isArray(parkedQuestion.body?.answers?.[0]?.selected) && parkedQuestion.body.answers[0].selected.length === 0)

  const settledAfterAnswer = await call('/api/agent/question/settled', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', questionId }
  })
  check('settling an already answered question is a no-op', settledAfterAnswer.body?.settled === false, JSON.stringify(settledAfterAnswer.body))

  const answeredState = await call('/api/state', { token: CONTROL_TOKEN })
  check('the answered question is gone from the roster', (answeredState.body?.nodes?.[0]?.questions ?? []).length === 0, JSON.stringify(answeredState.body?.nodes?.[0]?.questions))

  const doubleAnswer = await call('/api/answer', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', questionId, answers: [{ id: 'scope', selected: ['全部'] }] }
  })
  check('a question cannot be answered twice', doubleAnswer.status === 409, `got ${String(doubleAnswer.status)}`)

  const unknownQuestion = await call('/api/answer', {
    token: CONTROL_TOKEN,
    body: { nodeId: 'mac-1', questionId: 'not-a-question', answers: [] }
  })
  check('an answer to a question nobody asked is refused', unknownQuestion.status === 409, `got ${String(unknownQuestion.status)}`)

  // Nothing is left holding the turn, so the node can report and go idle.
  await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: askedCommand.body.commandId,
      result: { ok: true, prompt: 'review my change', workspace: asExercise, text: 'No findings.', durationMs: 42 }
    }
  })

  // ── the page is told over SSE, which is how a card ever appears ──────────
  // Every path above is also exercised by the browser check, but only where
  // Chromium exists; this one runs everywhere and fails loudly if the push stops
  // being emitted, which would leave the card invisible on a page that is healthy
  // in every other respect.
  const controller = new AbortController()
  const stream = await fetch(`${baseUrlFrom(child, port)}/api/events?token=${encodeURIComponent(CONTROL_TOKEN)}`, { signal: controller.signal })
  const reader = stream.body.getReader()
  const decoder = new TextDecoder()
  let seen = ''
  // The relay writes its headers and its first frame before registering the
  // subscriber, so a fetch that has resolved is not yet a subscribed stream.
  await sleep(150)
  const readFor = async (needle, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (seen.includes(needle)) return true
      const chunk = await Promise.race([reader.read(), sleep(deadline - Date.now()).then(() => ({ done: false, value: undefined }))])
      if (chunk.value !== undefined) seen += decoder.decode(chunk.value, { stream: true })
    }
    return seen.includes(needle)
  }

  const parkedAgain = call('/api/agent/ask', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', questions: [{ id: 'push', question: 'does the card reach the page?' }] }
  })
  const pushed = await readFor('"type":"questions"', 3000)
  check('a new question is pushed to the page over SSE', pushed, seen.slice(-300))
  controller.abort()

  const withdrawn = await call('/api/agent/question/settled', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', questionId: (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.[0]?.questions?.[0]?.questionId }
  })
  check('a node that stopped waiting can withdraw its question', withdrawn.body?.settled === true, JSON.stringify(withdrawn.body))
  check('the withdrawn ask is released instead of hanging', (await parkedAgain).body?.settled === true)

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

  // ── the guest door ───────────────────────────────────────────────────────
  // The passwordless visitor's half of the protocol. Everything below is either a
  // boundary (a guest must not reach the operator's facts or another visitor's
  // conversation) or a limit (an open door must not be an unbounded one), and both
  // kinds are asserted against the real relay over HTTP.
  const OWNER_WORKSPACE = '/Users/dev/deepseek'
  const GUEST_WORKSPACE = '/Users/dev/demo'
  const NESTED_OTHER = '/Users/dev/notes'

  // Re-register: the liveness section let this node go offline on purpose, and a
  // command to an offline node is refused before any guest check is reached.
  const helloGuest = () =>
    call('/api/agent/hello', {
      token: AGENT_TOKEN,
      body: {
        nodeId: 'mac-1',
        name: 'Studio Mac',
        platform: 'darwin 24.0.0',
        version: 'test/0',
        workspaces: [
          { name: 'deepseek', path: OWNER_WORKSPACE },
          { name: 'demo', path: GUEST_WORKSPACE },
          { name: 'notes', path: NESTED_OTHER }
        ],
        guest: {
          enabled: true,
          agentPreset: 'reader',
          permissionPreset: 'read-only',
          workspaces: [
            { name: 'demo', path: GUEST_WORKSPACE },
            // Never advertised to the operator, so the relay must refuse to hold it
            // for a visitor even though the node's own guest list mentions it.
            { name: 'sneaky', path: '/Users/dev/not-advertised' }
          ]
        }
      }
    })
  await helloGuest()
  // A second machine with the door shut: it must be invisible to visitors.
  await call('/api/agent/hello', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-2',
      name: 'Office Box',
      workspaces: [{ name: 'other', path: '/Users/dev/other' }],
      guest: { enabled: false, workspaces: [] }
    }
  })

  const guestPage = await call('/guest')
  check('the guest page is served without a token', guestPage.status === 200 && String(guestPage.body).includes('DSH Remote Control'))

  const guestStateNoToken = await call('/api/guest/state')
  check('a guest route still needs an identity', guestStateNoToken.status === 401, `got ${String(guestStateNoToken.status)}`)

  const enter = await call('/api/guest/enter', { method: 'POST', body: {} })
  check('a visitor mints an identity', enter.status === 200 && typeof enter.body?.token === 'string', JSON.stringify(enter.body))
  const guestToken = enter.body.token
  check('the identity names the visitor', typeof enter.body?.guestId === 'string' && enter.body.guestId.startsWith('guest-'), String(enter.body?.guestId))
  const second = await call('/api/guest/enter', { method: 'POST', body: {} })
  const otherToken = second.body.token
  const otherGuestId = second.body.guestId
  check('a second visitor gets a different identity', otherToken !== guestToken && otherGuestId !== enter.body.guestId)

  // The two trust domains stay separate in both directions.
  check(
    'the operator token cannot call a guest route',
    (await call('/api/guest/state', { token: CONTROL_TOKEN })).status === 401
  )
  check(
    'the agent token cannot call a guest route',
    (await call('/api/guest/state', { token: AGENT_TOKEN })).status === 401
  )
  check(
    'a guest identity cannot read the operator snapshot',
    (await call('/api/state', { token: guestToken })).status === 401
  )
  check(
    'a guest identity cannot register as a node',
    (await call('/api/agent/hello', { token: guestToken, body: { nodeId: 'x' } })).status === 401
  )

  const guestSnap = await call('/api/guest/state', { token: guestToken })
  const guestNodes = guestSnap.body?.nodes ?? []
  check('a visitor sees only machines with a door', guestNodes.length === 1 && guestNodes[0]?.nodeId === 'mac-1', JSON.stringify(guestNodes.map((node) => node.nodeId)))
  check(
    'a visitor sees only the directories it was offered',
    guestNodes[0]?.workspaces?.length === 1 && guestNodes[0]?.workspaces?.[0]?.path === GUEST_WORKSPACE,
    JSON.stringify(guestNodes[0]?.workspaces)
  )
  check(
    'a guest directory the operator was never offered is dropped',
    !(guestNodes[0]?.workspaces ?? []).some((entry) => entry.path === '/Users/dev/not-advertised')
  )
  check(
    'the operator workspace list is not visible to a visitor',
    !(guestNodes[0]?.workspaces ?? []).some((entry) => entry.path === NESTED_OTHER)
  )
  check('a visitor is not told the platform or version', guestNodes[0]?.platform === undefined && guestNodes[0]?.version === undefined)
  check('the visitor sees the door marked as such', guestNodes[0]?.guest === true)
  check('the operator still sees both machines', (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.length === 2)
  check(
    'the operator snapshot reports the door state',
    (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.find((node) => node.nodeId === 'mac-1')?.guest?.enabled === true
  )

  // A hello that says nothing about guests must close the door rather than leave the
  // previous one in place: otherwise a door opened by a process that is gone stays
  // open on the relay, which is exactly the state nobody can see.
  await call('/api/agent/hello', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      name: 'Studio Mac',
      workspaces: [{ name: 'demo', path: GUEST_WORKSPACE }]
    }
  })
  check(
    'a hello with no guest block closes the door',
    (await call('/api/guest/state', { token: guestToken })).body?.nodes?.length === 0,
    JSON.stringify((await call('/api/guest/state', { token: guestToken })).body?.nodes)
  )
  check(
    'and the operator still sees the machine',
    (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.some((node) => node.nodeId === 'mac-1') === true
  )
  await helloGuest()

  // ── what a guest may name ────────────────────────────────────────────────
  const guestOutside = await call('/api/guest/command', {
    token: guestToken,
    body: { nodeId: 'mac-1', workspace: NESTED_OTHER, prompt: 'read this' }
  })
  check(
    'a guest cannot name a directory outside its list',
    guestOutside.status === 400,
    `got ${String(guestOutside.status)} — an operator workspace is not a guest workspace`
  )
  const guestOnClosed = await call('/api/guest/command', {
    token: guestToken,
    body: { nodeId: 'mac-2', workspace: '/Users/dev/other', prompt: 'read this' }
  })
  check('a guest cannot use a machine whose door is shut', guestOnClosed.status === 403, `got ${String(guestOnClosed.status)}`)
  const guestTooLong = await call('/api/guest/command', {
    token: guestToken,
    body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: 'x'.repeat(201) }
  })
  check('an over-long guest question is refused', guestTooLong.status === 400, `got ${String(guestTooLong.status)}`)

  // ── a guest turn reaches the node as a guest turn ────────────────────────
  const guestParked = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
  await sleep(120)
  const guestAccepted = await call('/api/guest/command', {
    token: guestToken,
    body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: 'review this change' }
  })
  check('a valid guest command is accepted', guestAccepted.status === 200, JSON.stringify(guestAccepted.body))
  const guestDelivered = await guestParked
  check(
    'the node is told the turn is a guest turn',
    guestDelivered.body?.command?.role === 'guest',
    JSON.stringify(guestDelivered.body?.command)
  )
  check(
    'the node is given the visitor the turn came from',
    guestDelivered.body?.command?.principal === enter.body.guestId,
    JSON.stringify(guestDelivered.body?.command?.principal)
  )
  check(
    'the operator command stays the operator’s',
    guestDelivered.body?.command?.principal !== CONTROL_TOKEN && guestDelivered.body?.command?.role !== 'owner'
  )

  const guestTranscript = (await call('/api/guest/state?nodeId=mac-1', { token: guestToken })).body?.transcript ?? []
  check(
    'a visitor sees its own question',
    guestTranscript.some((entry) => entry.kind === 'question' && entry.prompt === 'review this change'),
    JSON.stringify(guestTranscript)
  )
  check(
    'and nothing the operator asked',
    !guestTranscript.some((entry) => entry.prompt === 'summarize the repo' || entry.prompt === 'review my change'),
    JSON.stringify(guestTranscript.map((entry) => entry.prompt))
  )
  const ownerTranscript = (await call('/api/state?nodeId=mac-1', { token: CONTROL_TOKEN })).body?.transcript ?? []
  check(
    'the operator sees the visitor’s turn, marked as one',
    ownerTranscript.some((entry) => entry.prompt === 'review this change' && entry.role === 'guest'),
    JSON.stringify(ownerTranscript.filter((entry) => entry.prompt === 'review this change'))
  )

  // ── visitors are isolated from each other ────────────────────────────────
  const otherSnap = await call('/api/guest/state?nodeId=mac-1', { token: otherToken })
  const otherTranscript = otherSnap.body?.transcript ?? []
  check(
    'a second visitor sees none of the first visitor’s turns',
    !otherTranscript.some((entry) => entry.prompt === 'review this change'),
    JSON.stringify(otherTranscript.map((entry) => entry.prompt))
  )
  const foreignSession = await call('/api/guest/command', {
    token: otherToken,
    body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: 'continue that', sessionId: 'remote-abc' }
  })
  check(
    'a visitor cannot continue a session it did not create',
    foreignSession.status === 403,
    `got ${String(foreignSession.status)} — 'remote-abc' belongs to the operator`
  )

  // ── a question belongs to the visitor that caused it ─────────────────────
  await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: guestAccepted.body.commandId,
      result: { ok: true, prompt: 'review this change', workspace: GUEST_WORKSPACE, sessionId: 'guest-session-1', text: 'no findings', durationMs: 12 }
    }
  })
  const guestFollowUp = await call('/api/guest/command', {
    token: guestToken,
    body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: 'and the second file?', sessionId: 'guest-session-1' }
  })
  check(
    'a visitor can continue the session it created',
    guestFollowUp.status === 200,
    `got ${String(guestFollowUp.status)} — the relay remembers the sessions it minted for this identity`
  )

  const guestAskParked = call('/api/agent/ask', {
    token: AGENT_TOKEN,
    body: { nodeId: 'mac-1', questions: [{ id: 'scope', question: 'which file?', options: [{ label: 'all' }] }] }
  })
  await sleep(150)
  const guestPending = (await call('/api/guest/state', { token: guestToken })).body?.nodes?.find((node) => node.nodeId === 'mac-1')?.questions ?? []
  check('the visitor sees the question from its own turn', guestPending.length === 1, JSON.stringify(guestPending))
  check(
    'a second visitor does not see it',
    ((await call('/api/guest/state', { token: otherToken })).body?.nodes?.find((node) => node.nodeId === 'mac-1')?.questions ?? []).length === 0
  )
  const guestQuestionId = guestPending[0]?.questionId
  const stolen = await call('/api/guest/answer', {
    token: otherToken,
    body: { nodeId: 'mac-1', questionId: guestQuestionId, answers: [{ id: 'scope', selected: ['all'] }] }
  })
  check('another visitor cannot answer it', stolen.status === 403, `got ${String(stolen.status)}`)
  const guestAnswered = await call('/api/guest/answer', {
    token: guestToken,
    body: { nodeId: 'mac-1', questionId: guestQuestionId, answers: [{ id: 'scope', selected: ['all'] }] }
  })
  check('the visitor that was asked can answer it', guestAnswered.status === 200, JSON.stringify(guestAnswered.body))
  check('the parked ask received that answer', (await guestAskParked).body?.answers?.[0]?.selected?.[0] === 'all')
  await call('/api/agent/report', {
    token: AGENT_TOKEN,
    body: {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: guestFollowUp.body.commandId,
      result: { ok: true, prompt: 'and the second file?', workspace: GUEST_WORKSPACE, sessionId: 'guest-session-1', text: 'done', durationMs: 5 }
    }
  })

  // ── the door has limits ──────────────────────────────────────────────────
  await helloGuest()
  const flood = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    flood.push(
      await call('/api/guest/command', {
        token: guestToken,
        body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: `queued ${String(attempt)}` }
      })
    )
  }
  check(
    'one visitor cannot queue work without bound',
    flood.some((response) => response.status === 429),
    JSON.stringify(flood.map((response) => response.status))
  )
  check('and the first questions were still accepted', flood[0]?.status === 200, JSON.stringify(flood[0]?.body))

  // Drain the queue so the node is not left holding commands for later sections —
  // and *report* each one. A command that is polled off the queue but never
  // reported keeps its in-flight record, and that record is what the outstanding
  // budget counts: leaving them would make every later guest question look like a
  // flood.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const drained = await call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
    const command = drained.body?.command
    if (command === undefined || command === null) break
    await call('/api/agent/report', {
      token: AGENT_TOKEN,
      body: {
        nodeId: 'mac-1',
        status: 'idle',
        commandId: command.commandId,
        result: { ok: true, prompt: command.prompt, workspace: command.workspace, text: 'ok', durationMs: 1 }
      }
    })
  }

  // ── the visitor's stream is filtered, per subscriber ─────────────────────
  // The roster broadcast reaches both audiences from one loop, so the filter is
  // applied per subscriber rather than per event. Getting that wrong is invisible
  // in every request/response path above: it would only show up as the operator's
  // work appearing on a stranger's screen.
  {
    await helloGuest()
    const controller = new AbortController()
    const stream = await fetch(
      `${baseUrlFrom(child, port)}/api/guest/events?token=${encodeURIComponent(guestToken)}`,
      { signal: controller.signal }
    )
    const reader = stream.body.getReader()
    const decoder = new TextDecoder()
    let frames = ''
    await sleep(150)
    const pump = async (ms) => {
      const deadline = Date.now() + ms
      while (Date.now() < deadline) {
        const chunk = await Promise.race([
          reader.read(),
          sleep(Math.max(1, deadline - Date.now())).then(() => ({ value: undefined }))
        ])
        if (chunk.value !== undefined) frames += decoder.decode(chunk.value, { stream: true })
      }
    }
    const ownerPoll = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
    await sleep(120)
    const ownerSecret = await call('/api/command', {
      token: CONTROL_TOKEN,
      body: { nodeId: 'mac-1', workspace: OWNER_WORKSPACE, prompt: 'operator-only-secret' }
    })
    await ownerPoll
    const guestPoll = call('/api/agent/poll', { token: AGENT_TOKEN, body: { nodeId: 'mac-1' } })
    await sleep(120)
    const guestMarker = await call('/api/guest/command', {
      token: guestToken,
      body: { nodeId: 'mac-1', workspace: GUEST_WORKSPACE, prompt: 'guest-only-marker' }
    })
    await guestPoll
    await pump(800)
    controller.abort()
    check(
      'the visitor stream carries the visitor’s own turn',
      frames.includes('guest-only-marker'),
      frames.slice(-300)
    )
    check(
      'and never the operator’s',
      !frames.includes('operator-only-secret'),
      'an operator prompt reached a visitor’s event stream'
    )
    // Clear both in-flight commands so the queue accounting below is unambiguous.
    await call('/api/agent/report', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', status: 'idle', commandId: ownerSecret.body.commandId, result: { ok: true, prompt: 'operator-only-secret', workspace: OWNER_WORKSPACE, text: 'ok', durationMs: 1 } } })
    await call('/api/agent/report', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', status: 'idle', commandId: guestMarker.body.commandId, result: { ok: true, prompt: 'guest-only-marker', workspace: GUEST_WORKSPACE, text: 'ok', durationMs: 1 } } })
  }

  // The mint route is the one with no credential, so it is the one worth metering.
  const rateLimited = []
  for (let attempt = 0; attempt < 4; attempt += 1) {
    rateLimited.push(
      await call('/api/guest/enter', { method: 'POST', body: {}, headers: { 'x-forwarded-for': '203.0.113.9' } })
    )
  }
  check(
    'one address cannot mint identities without bound',
    rateLimited.at(-1)?.status === 429,
    JSON.stringify(rateLimited.map((response) => response.status))
  )
  check('the earlier mints from that address were accepted', rateLimited[0]?.status === 200)

  // ── the relay's kill switch ──────────────────────────────────────────────
  // Closing the door has to work without any node's cooperation, so it is checked
  // on a second relay process with the switch off rather than assumed.
  {
    const closedPort = port + 1
    const closed = spawnGuarded(process.execPath, [SERVER], {
      env: {
        ...process.env,
        DSH_REMOTE_RELAY_HOST: '127.0.0.1',
        DSH_REMOTE_RELAY_PORT: String(closedPort),
        DSH_REMOTE_AGENT_TOKEN: AGENT_TOKEN,
        DSH_REMOTE_CONTROL_TOKEN: CONTROL_TOKEN,
        DSH_REMOTE_GUEST: 'off'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    try {
      await waitForListen(closed)
      const callClosed = async (path, options = {}) => {
        const init = { method: options.method ?? 'GET', headers: { ...(options.headers ?? {}) } }
        if (options.token !== undefined) init.headers.authorization = `Bearer ${options.token}`
        if (options.body !== undefined) {
          init.method = 'POST'
          init.headers['content-type'] = 'application/json'
          init.body = JSON.stringify(options.body)
        }
        const response = await fetch(`http://127.0.0.1:${String(closedPort)}${path}`, init)
        const text = await response.text()
        let body
        try {
          body = text === '' ? undefined : JSON.parse(text)
        } catch {
          body = text
        }
        return { status: response.status, body }
      }
      const closedEnter = await callClosed('/api/guest/enter', { method: 'POST', body: {} })
      check('the kill switch refuses new visitors', closedEnter.status === 404, `got ${String(closedEnter.status)}`)
      const closedState = await callClosed('/api/guest/state', { token: guestToken })
      check('and refuses every other guest route', closedState.status === 404, `got ${String(closedState.status)}`)
      const stillOwner = await callClosed('/api/state', { token: CONTROL_TOKEN })
      check('while the operator route keeps working', stillOwner.status === 200, `got ${String(stillOwner.status)}`)
      check('and the guest page itself still loads', (await callClosed('/guest')).status === 200)
    } finally {
      await stopGuarded(closed)
    }
  }

  // ── a busy node stays alive by reporting ─────────────────────────────────
  // The relay's liveness rule is fed by polls *and* reports, which is what makes a
  // heartbeat enough. Asserted here on its own because the whole "shown as 离线
  // while working" bug comes down to whether this is true.
  {
    await helloGuest()
    await sleep(4500)
    const stale = (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.find((node) => node.nodeId === 'mac-1')
    check('a silent machine is reported offline', stale?.online === false, JSON.stringify(stale?.status))
    await call('/api/agent/report', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', status: 'busy', detail: 'a long turn' } })
    const revived = (await call('/api/state', { token: CONTROL_TOKEN })).body?.nodes?.find((node) => node.nodeId === 'mac-1')
    check('a status report alone brings it back online', revived?.online === true, JSON.stringify(revived?.status))
    check('and the page can say what it is doing', revived?.status === 'busy' && revived?.detail === 'a long turn', JSON.stringify(revived))
    await call('/api/agent/report', { token: AGENT_TOKEN, body: { nodeId: 'mac-1', status: 'idle' } })
  }

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
  await stopGuarded(child)
  if (trackedCount() > 0) {
    failures += 1
    process.stdout.write(`relay-check: leaked ${String(trackedCount())} child process(es)\n`)
  }
}

if (failures > 0) process.exitCode = 1
