/**
 * The question vocabulary, in the one place both halves read it.
 *
 * The relay accepts a question and the node admits an answer, and those two
 * checks have to agree exactly: a page that can build an answer the node will
 * reject produces a card whose submission silently falls back to the local GUI,
 * while a node that accepts more than the relay validated lets the relay widen
 * what reaches the model. Sharing the functions is cheaper than keeping two
 * copies honest.
 *
 * **The relay is not trusted.** Nothing here performs authentication; it only
 * decides what shape a fact may have. Option labels are checked against the
 * questions that were actually asked, so the relay cannot invent a choice, and
 * the only free-form field that survives is `custom` — the user's own words.
 *
 * @module dsh-remote-control/answers
 */

/**
 * Read one string field from a loosely shaped object.
 *
 * @param {unknown} value - candidate container.
 * @param {string} key - property to read.
 * @returns {string|undefined} the non-empty string, if present.
 */
function stringField(value, key) {
  if (value === null || typeof value !== 'object') return undefined
  const field = value[key]
  return typeof field === 'string' && field.trim() !== '' ? field : undefined
}

/**
 * Normalize one model-authored question into the wire shape.
 *
 * @param {object} question - the model's question.
 * @returns {object} `{ id, question, header?, options?, multiSelect? }`.
 */
function normalizeQuestion(question) {
  const options = Array.isArray(question?.options)
    ? question.options
        .filter((option) => option !== null && typeof option === 'object')
        .map((option) => ({
          label: typeof option.label === 'string' ? option.label : ''
        }))
        .filter((option) => option.label !== '')
    : undefined
  return {
    id: typeof question?.id === 'string' ? question.id : '',
    question: typeof question?.question === 'string' ? question.question : '',
    ...(typeof question?.header === 'string' && question.header !== '' ? { header: question.header } : {}),
    ...(options === undefined || options.length === 0 ? {} : { options }),
    ...(question?.multiSelect === true ? { multiSelect: true } : {})
  }
}

/**
 * Project a model request into the question list the page may render.
 *
 * A request with no askable question is refused rather than forwarded: the page
 * would render a card it could never submit, which is strictly worse than
 * letting the local GUI handle it.
 *
 * @param {unknown} questions - the model's `questions` array.
 * @returns {Array<object>|undefined} the forwarded list, or undefined when unusable.
 */
export function admitQuestions(questions) {
  if (!Array.isArray(questions)) return undefined
  const normalized = questions.map(normalizeQuestion).filter((question) => question.id !== '' && question.question !== '')
  return normalized.length === 0 ? undefined : normalized
}

/**
 * Validate one answer against the question it claims to answer.
 *
 * @param {unknown} received - `{ id?, selected?, custom? }` from the page.
 * @param {object} asked - the question being answered.
 * @param {boolean} checkLabels - whether `selected` labels must be ones that were offered.
 * @returns {{ id: string, selected: string[], custom?: string }|undefined} the answer, or undefined.
 */
function admitAnswer(received, asked, checkLabels) {
  if (received === null || typeof received !== 'object') return undefined
  if (received.id !== asked.id) return undefined
  const selected = Array.isArray(received.selected) ? received.selected.filter((label) => typeof label === 'string') : []
  if (checkLabels) {
    const offered = new Set((asked.options ?? []).map((option) => option.label))
    if (selected.some((label) => !offered.has(label))) return undefined
  }
  const custom = typeof received.custom === 'string' && received.custom.trim() !== '' ? received.custom : undefined
  // A single-select answer is one choice or one piece of text, never both: the
  // local composer enforces the same rule, so accepting it here would let the
  // relay deliver an answer the machine's own UI could not have produced.
  if (custom === undefined && !asked.multiSelect && selected.length > 1) return undefined
  if (custom === undefined && selected.length === 0) return undefined
  const keepSelected = custom === undefined || asked.multiSelect === true
  return { id: asked.id, selected: keepSelected ? selected : [], ...(custom === undefined ? {} : { custom }) }
}

/**
 * Validate a whole answer batch against the questions that were asked.
 *
 * Every asked question must be present; answering nothing is `{ selected: [] }`,
 * the same blank result the local composer sends for a skipped question.
 *
 * @param {unknown} answers - the page's `answers` array.
 * @param {Array<object>} asked - the forwarded questions.
 * @param {boolean} checkLabels - whether `selected` labels must have been offered.
 * @returns {Array<object>|undefined} the batch, or undefined when inadmissible.
 */
export function admitAnswers(answers, asked, checkLabels = true) {
  if (!Array.isArray(answers) || answers.length !== asked.length) return undefined
  const admitted = []
  for (const question of asked) {
    const received = answers.find((answer) => answer !== null && typeof answer === 'object' && answer.id === question.id)
    if (received === undefined) return undefined
    const selected = Array.isArray(received.selected) ? received.selected : []
    const custom = typeof received.custom === 'string' ? received.custom.trim() : ''
    if (selected.length === 0 && custom === '') {
      admitted.push({ id: question.id, selected: [] })
      continue
    }
    const answer = admitAnswer(received, question, checkLabels)
    if (answer === undefined) return undefined
    admitted.push(answer)
  }
  return admitted
}

/**
 * Read a session id off a live agent, or off anything carrying one.
 *
 * The documented path is `agent.session.id`; the agent's own `id` is accepted as
 * a fallback because for a root agent they are the same identity, and a question
 * that cannot be attributed must never be forwarded.
 *
 * @param {object} agent - the live calling agent.
 * @returns {string|undefined} its session id, or undefined when unreadable.
 */
export function sessionIdOfAgent(agent) {
  if (agent === null || typeof agent !== 'object') return undefined
  return (
    stringField(agent.session, 'id') ??
    stringField(agent, 'sessionId') ??
    stringField(agent, 'id')
  )
}
