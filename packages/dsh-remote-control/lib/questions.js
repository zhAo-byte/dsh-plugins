/**
 * `dsh-remote-control` — put a remote session's questions on the relay page.
 *
 * A remotely started session is an ordinary local session, so when its agent
 * calls `ask_user_question` the question is dispatched as the scoped
 * `user-questions/request` waterfall event. Two answerers are in play:
 *
 * 1. `@deepseek-ai/dsh-api-remotes` forwards the event to any connected local
 *    browser, whose `dsh-client-ui-user-questions` plugin takes over the
 *    composer and blocks until the person sitting at that machine answers.
 * 2. This bridge, which answers from the relay page instead.
 *
 * Cordis runs waterfall listeners in registration order, and the forwarding
 * listener registers while the backend composes — long before this plugin
 * starts a node. Registration without `prepend` would therefore always lose to
 * the local GUI, and the relay page would never see the question. `prepend` is
 * what makes the relay the answerer; returning `next()` for anything that is not
 * one of our sessions keeps every other question's behaviour untouched.
 *
 * The bridge is deliberately bounded in three ways:
 *
 * - **It only claims sessions this node created.** Anything else is delegated
 *   with `next()` on the first line, so a local user's own question is never
 *   routed to a web page.
 * - **It only carries answers.** The relay can choose among the options the
 *   model offered; it cannot approve a permission request. That asymmetry is the
 *   point: `approval/request` is a different event and stays on the machine.
 * - **It gives up.** When nobody answers within the configured window (or the
 *   relay cannot be reached at all) the bridge delegates to `next()`, which is
 *   exactly the pre-existing behaviour: the local GUI gets the question and the
 *   agent never hangs forever.
 *
 * @module dsh-remote-control/questions
 */

import { admitAnswers, admitQuestions, sessionIdOfAgent } from './answers.js'

/** A question this bridge is currently holding open with the relay. */
export class RemoteQuestionBridge {
  /**
   * @param {object} options - `{ client, nodeId, logger, timeoutMs }`.
   *
   * `client` is the live `RelayClient`, or undefined while no node is running.
   * The bridge is installed once at plugin load and reads the client through
   * this field, because the listener has to exist before any node starts.
   */
  constructor({ client, nodeId, logger, timeoutMs }) {
    /** The node's relay client, swapped on every (re)configure; undefined when stopped. */
    this.client = client
    /** Identity the relay knows this node by. */
    this.nodeId = nodeId
    this.logger = logger
    this.timeoutMs = timeoutMs
    /** @type {Set<string>} session ids this node created and still owns. */
    this.sessions = new Set()
  }

  /**
   * Begin managing one remote session.
   *
   * @param {string} sessionId - the session the runner created.
   */
  track(sessionId) {
    if (typeof sessionId === 'string' && sessionId !== '') this.sessions.add(sessionId)
  }

  /**
   * Stop managing one remote session.
   *
   * @param {string} sessionId - the session being disposed.
   */
  release(sessionId) {
    if (typeof sessionId === 'string') this.sessions.delete(sessionId)
  }

  /**
   * Whether an agent belongs to a session this node created.
   *
   * @param {object} agent - the live calling agent.
   * @returns {boolean} true when this bridge owns its questions.
   */
  owns(agent) {
    const sessionId = sessionIdOfAgent(agent)
    return sessionId !== undefined && this.sessions.has(sessionId)
  }

  /**
   * Answer one question from the relay page, or delegate.
   *
   * The returned value is either a complete `AskUserQuestionAnswer` — which ends
   * the waterfall, so the local GUI never sees this question — or `undefined`,
   * which means "call `next()`": not our session, no relay to ask, timed out, or
   * the user cancelled the turn.
   *
   * @param {object} request - the `user-questions/request` event payload.
   * @returns {Promise<object|undefined>} the answer, or undefined to delegate.
   */
  async answer(request) {
    const questions = admitQuestions(request?.questions)
    if (questions === undefined) return undefined
    const client = this.client
    if (client === undefined) return undefined

    let questionId
    try {
      const accepted = await client.ask(
        { nodeId: this.nodeId, questions },
        { signal: request.signal, timeoutMs: this.timeoutMs }
      )
      questionId = typeof accepted?.questionId === 'string' ? accepted.questionId : undefined
      // The relay only checked the shape and the offered labels; this is the
      // authoritative admission, and it is why a compromised relay still cannot
      // hand the model a choice it never offered.
      const answers = admitAnswers(accepted?.answers, questions)
      if (answers === undefined) {
        this.logger?.warn?.(
          `dsh-remote-control: the page returned an inadmissible answer${questionId === undefined ? '' : ` for ${questionId}`}; asking the local GUI instead`
        )
        return undefined
      }
      this.logger?.info?.(`dsh-remote-control: question ${questionId ?? '(unknown)'} answered from the relay`)
      return { answers }
    } catch (error) {
      // The relay may have accepted an answer while this side gave up. Saying so
      // is what stops the page from offering a card whose answer nobody will read.
      if (questionId !== undefined) void client.settleQuestion({ nodeId: this.nodeId, questionId }).catch(() => {})
      // A cancelled turn must not be delegated. `next()` here would offer the
      // question to the local GUI, whose answerer takes over the composer and
      // waits for a person — a prompt for a turn that no longer exists, which
      // never settles. Throwing lets the question seam translate it into the
      // documented `ASK_ABORTED`, which is what a cancelled tool call looks like.
      if (request?.signal?.aborted === true) throw error
      this.logger?.warn?.(
        `dsh-remote-control: relaying the question failed (${error?.message ?? error}); asking the local GUI instead`
      )
      return undefined
    }
  }
}
