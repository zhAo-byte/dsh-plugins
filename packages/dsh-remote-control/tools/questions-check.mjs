#!/usr/bin/env node
/**
 * `questions-check` — the answerer ordering, against the real Cordis and the real
 * `user-questions` seam.
 *
 * Every other check treats the bridge as a function that is called. This one
 * exists because the bridge is only useful if it is called *first*: the local GUI
 * wins by registration order, and the whole feature is one `prepend` option away
 * from silently doing nothing. Re-implementing the waterfall here would prove
 * nothing, so this file loads the Harness's own `@deepseek-ai/cordis` and
 * `@deepseek-ai/dsh-user-questions` and drives them the way the running backend
 * does.
 *
 * It is the second check that needs a Harness installation on disk (the first is
 * `runner-check`), and it reports a skip rather than a failure when none is
 * reachable, for the same reason: `npm test` must run on a bare checkout.
 *
 * @module dsh-remote-control/tools/questions-check
 */

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
 * Resolve one Harness package through the plugin's own dependency roots.
 *
 * @param {string} specifier - package name.
 * @returns {Promise<any>} the module namespace.
 */
async function loadHarness(specifier) {
  const { createRequire } = await import('node:module')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const here = dirname(fileURLToPath(import.meta.url))
  const require = createRequire(join(here, '..', 'package.json'))
  let resolved
  try {
    resolved = require.resolve(specifier)
  } catch (error) {
    // A missing package is the expected "no Harness here" case, not a failure.
    // It is tagged so the caller can tell it apart from a real error, which must
    // still fail the check rather than be swallowed as a skip.
    const absent = new Error(`${specifier} is not installed`)
    absent.noHarness = true
    throw absent
  }
  return await import(resolved)
}

process.stdout.write('questions-check\n')

try {
  const [{ Context }, questionsModule] = await Promise.all([
    loadHarness('@deepseek-ai/cordis'),
    loadHarness('@deepseek-ai/dsh-user-questions')
  ])
  const UserQuestionService = questionsModule.default ?? questionsModule.UserQuestionService
  if (typeof UserQuestionService !== 'function' || typeof Context !== 'function') {
    throw new Error('the Harness answered with unexpected module shapes')
  }

  const { RemoteQuestionBridge } = await import('../lib/questions.js')

  /**
   * Build a root context carrying the real question service.
   *
   * @param {object} [fakeClient] - relay client substitute.
   * @returns {Promise<{ ctx: object, service: object, bridge: object }>} the fixture.
   */
  async function fixture(fakeClient) {
    const ctx = new Context()
    // Constructing the service publishes it on the context it is given, which is
    // how the real composition mounts it: there is no separate `provide` step.
    const service = new UserQuestionService(ctx)
    const bridge = new RemoteQuestionBridge({
      client: fakeClient,
      nodeId: 'n1',
      logger: { info: () => {}, warn: () => {} },
      timeoutMs: 5_000
    })
    // The service authenticates the caller against the live agent registry, and
    // that check is part of what is being exercised: a fixture that skipped it
    // would not be running the real ask() path at all. The registry is one stable
    // object (a service value cannot be replaced after it is provided), mutated as
    // agents are declared.
    const live = new Set()
    ctx.provide('agents', {
      get: (id) => [...live].find((candidate) => candidate.id === id),
      roots: () => [...live]
    })
    /**
     * Declare one agent as a live runtime root.
     *
     * @param {object} agent - `{ id, session }`.
     * @returns {object} the same agent, for inline use.
     */
    const addAgent = (agent) => {
      live.add(agent)
      return agent
    }
    return { ctx, service, bridge, addAgent }
  }

  /** One askable question, in the shape the tool sends. */
  const asked = {
    questions: [{ id: 'scope', question: 'which part?', options: [{ label: '全部' }, { label: '仅改动' }] }]
  }

  // ── the ordering the feature depends on ───────────────────────────────────
  // The local GUI's answerer is registered while the backend composes, which is
  // before this plugin can run. So the fixture registers that one first, exactly
  // like the real tree, and then installs the bridge with `prepend` the way
  // `apply()` does. Without the prepend the browser would claim the question and
  // block, and the relay page would never see it.
  {
    const relayAsks = []
    const { ctx, service, bridge, addAgent } = await fixture({
      ask: async (body) => {
        relayAsks.push(body)
        return { questionId: 'q1', answers: [{ id: 'scope', selected: ['全部'] }] }
      },
      settleQuestion: async () => ({ ok: true })
    })
    bridge.track('remote-1')
    let browserCalls = 0
    // Stands in for `dsh-client-ui-user-questions`: it takes over the composer and
    // only settles when a person answers.
    const browserAnswerer = async () => {
      browserCalls += 1
      return { answers: [{ id: 'scope', selected: ['仅改动'] }] }
    }
    ctx.on('user-questions/request', browserAnswerer)
    ctx.on('user-questions/request', async (request, next) => {
      if (!bridge.owns(request.agent)) return await next()
      const answer = await bridge.answer(request)
      return answer === undefined ? await next() : answer
    }, { prepend: true })

    const agent = addAgent({ id: 'remote-1', session: { id: 'remote-1' } })
    const answer = await service.ask({ ...asked, agent })
    check('the relay answers a remote session’s question', answer?.answers?.[0]?.selected?.[0] === '全部', JSON.stringify(answer))
    check('the question reached the relay', relayAsks.length === 1, JSON.stringify(relayAsks))
    check(
      'the local GUI never saw the question',
      browserCalls === 0,
      'the forwarding listener ran anyway — the prepend no longer wins, so the page would never receive the question'
    )
  }

  // ── and every other question is untouched ─────────────────────────────────
  // This is the other half of the same rule: a local user's own question must
  // still go to the local GUI. A bridge that claimed everything would take the
  // composer hostage for every session on the machine.
  {
    const relayAsks = []
    const { ctx, service, bridge, addAgent } = await fixture({
      ask: async (body) => {
        relayAsks.push(body)
        return { questionId: 'q2', answers: [{ id: 'scope', selected: ['全部'] }] }
      },
      settleQuestion: async () => ({ ok: true })
    })
    bridge.track('remote-1')
    let browserCalls = 0
    ctx.on('user-questions/request', async () => {
      browserCalls += 1
      return { answers: [{ id: 'scope', selected: ['仅改动'] }] }
    })
    ctx.on('user-questions/request', async (request, next) => {
      if (!bridge.owns(request.agent)) return await next()
      const answer = await bridge.answer(request)
      return answer === undefined ? await next() : answer
    }, { prepend: true })

    const localAgent = addAgent({ id: 'session-42', session: { id: 'session-42' } })
    const answer = await service.ask({ ...asked, agent: localAgent })
    check('a local session’s question still goes to the local GUI', answer?.answers?.[0]?.selected?.[0] === '仅改动', JSON.stringify(answer))
    check('a local session’s question is never relayed', relayAsks.length === 0, JSON.stringify(relayAsks))
    check('the local GUI was consulted exactly once', browserCalls === 1, String(browserCalls))
  }

  // ── a dead relay must not hold the turn ───────────────────────────────────
  // The bridge delegates on failure, and delegation is what lets the local GUI
  // answer instead: the agent is only ever suspended on one of them.
  {
    const { ctx, service, bridge, addAgent } = await fixture({
      ask: async () => {
        throw new Error('relay is down')
      },
      settleQuestion: async () => ({ ok: true })
    })
    bridge.track('remote-1')
    let browserCalls = 0
    ctx.on('user-questions/request', async () => {
      browserCalls += 1
      return { answers: [{ id: 'scope', selected: ['仅改动'] }] }
    })
    ctx.on('user-questions/request', async (request, next) => {
      if (!bridge.owns(request.agent)) return await next()
      const answer = await bridge.answer(request)
      return answer === undefined ? await next() : answer
    }, { prepend: true })

    const answer = await service.ask({ ...asked, agent: addAgent({ id: 'remote-1', session: { id: 'remote-1' } }) })
    check('an unreachable relay hands the question to the local GUI', answer?.answers?.[0]?.selected?.[0] === '仅改动', JSON.stringify(answer))
    check('the fallback still consulted the local GUI', browserCalls === 1, String(browserCalls))
  }

  // ── a cancelled turn must not be handed to the local GUI ──────────────────
  // `next()` here would offer the question to the GUI, whose answerer takes over
  // the composer and waits for a person — a prompt for a turn that is already
  // over, which never settles. The cancellation has to surface instead, and the
  // seam is what turns it into the documented ASK_ABORTED.
  {
    const settled = []
    const { ctx, service, bridge, addAgent } = await fixture({
      // Parks like the real held request, then fails the way `RelayClient` does
      // when the turn's signal aborts mid-flight.
      ask: async (body, options) => await new Promise((_resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true })
      }),
      settleQuestion: async (body) => {
        settled.push(body)
        return { ok: true }
      }
    })
    bridge.track('remote-1')
    let browserCalls = 0
    ctx.on('user-questions/request', async () => {
      browserCalls += 1
      return { answers: [{ id: 'scope', selected: ['仅改动'] }] }
    })
    ctx.on('user-questions/request', async (request, next) => {
      if (!bridge.owns(request.agent)) return await next()
      const answer = await bridge.answer(request)
      return answer === undefined ? await next() : answer
    }, { prepend: true })

    // Abort after the ask is under way: aborting before it would be refused by the
    // seam's own up-front guard and never reach the bridge at all.
    const controller = new AbortController()
    setTimeout(() => controller.abort(new Error('user cancelled the turn')), 30)
    let error
    try {
      await service.ask({ ...asked, agent: addAgent({ id: 'remote-1', session: { id: 'remote-1' } }), signal: controller.signal })
    } catch (caught) {
      error = caught
    }
    check('a cancelled turn rejects the ask', error !== undefined, 'the ask resolved')
    check('the cancellation is the seam’s own ASK_ABORTED', error?.code === 'ASK_ABORTED', `${error?.code}: ${error?.message}`)
    check('the local GUI was never offered a cancelled question', browserCalls === 0, String(browserCalls))
  }

  // ── the seam’s own contract is unchanged ──────────────────────────────────
  // With no bridge tracked for the session, the service must behave exactly as it
  // did before this plugin existed, down to the failure it raises when nobody
  // accepts the request.
  {
    const { ctx, service, bridge, addAgent } = await fixture(undefined)
    ctx.on('user-questions/request', async (request, next) => {
      if (!bridge.owns(request.agent)) return await next()
      const answer = await bridge.answer(request)
      return answer === undefined ? await next() : answer
    }, { prepend: true })

    let error
    try {
      await service.ask({ ...asked, agent: addAgent({ id: 'nothing-tracks-this', session: { id: 'nothing-tracks-this' } }) })
    } catch (caught) {
      error = caught
    }
    check('a question nobody accepts still fails with NO_PROVIDER', error?.code === 'NO_PROVIDER', `${error?.code}: ${error?.message}`)
  }

  process.stdout.write(`\nquestions-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  if (error?.noHarness === true) {
    process.stdout.write('  \u25CB no Harness installation reachable; skipping.\n')
    process.stdout.write('     This check drives the Harness’s own event waterfall, so it needs @deepseek-ai/* on disk.\n')
  } else {
    failures += 1
    process.stdout.write(`\nquestions-check: harness error — ${error?.stack ?? error}\n`)
  }
}

if (failures > 0) process.exitCode = 1
