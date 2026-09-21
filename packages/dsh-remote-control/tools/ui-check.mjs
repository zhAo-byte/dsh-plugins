#!/usr/bin/env node
/**
 * `ui-check` — drive the control page in a real browser, through the whole loop.
 *
 * The relay and node checks prove the wire works; they say nothing about the
 * page, and the page is what a person actually uses. A renamed element id, a
 * typo in the inline script, or an event stream that never renders would leave a
 * relay that passes every other check next to a page that does nothing.
 *
 * So this drives the real `relay/public/index.html` in headless Chromium over the
 * DevTools protocol: it seeds the token the way the page expects to find it,
 * loads the real page against a real relay, types a question, clicks the page's
 * own send button, and then plays the part of a node — picking the command up off
 * the long-poll, answering it, and asserting the answer renders on the page. That
 * last step is the point: it is the only check in this project that exercises the
 * browser's half of the full round trip.
 *
 * It needs a Chromium binary. One is looked up in the Playwright cache by
 * default, or taken from `DSH_REMOTE_CHROMIUM`; with none available the check
 * reports a skip rather than a failure, because a missing browser is not a defect
 * in this project.
 *
 * @module dsh-remote-control/tools/ui-check
 */

import { spawnGuarded, stopGuarded, trackedCount } from './spawn-guard.mjs'
import { createServer } from 'node:http'
import { readdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const SERVER = join(PACKAGE_ROOT, 'relay', 'server.js')

const AGENT_TOKEN = 'ui-check-agent-token'
const CONTROL_TOKEN = 'ui-check-control-token'

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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Find a Chromium binary.
 *
 * @returns {Promise<string|undefined>} the executable path.
 */
async function findChromium() {
  if (typeof process.env.DSH_REMOTE_CHROMIUM === 'string' && existsSync(process.env.DSH_REMOTE_CHROMIUM)) {
    return process.env.DSH_REMOTE_CHROMIUM
  }
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH,
    join(homedir(), 'Library', 'Caches', 'ms-playwright'),
    join(homedir(), '.cache', 'ms-playwright')
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const root of roots) {
    if (!existsSync(root)) continue
    const entries = (await readdir(root).catch(() => [])).sort().reverse()
    for (const entry of entries) {
      if (!entry.startsWith('chromium')) continue
      for (const relative of [
        ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
        ['chrome-linux', 'chrome'],
        ['chrome-win', 'chrome.exe']
      ]) {
        const candidate = join(root, entry, ...relative)
        if (existsSync(candidate)) return candidate
      }
    }
  }
  return undefined
}

/**
 * Wait for a Chromium DevTools endpoint to answer.
 *
 * Reading the WebSocket URL from stderr is how a browser with
 * `--remote-debugging-port=0` avoids a port race.
 *
 * @param {import('node:child_process').ChildProcess} child - browser process.
 * @returns {Promise<string>} the browser WebSocket URL.
 */
function waitForDevTools(child) {
  return new Promise((resolve, reject) => {
    let buffered = ''
    const timer = setTimeout(() => reject(new Error('chromium never announced a DevTools endpoint')), 30_000)
    const scan = (chunk) => {
      buffered += chunk
      const match = /ws:\/\/[^\s]+/.exec(buffered)
      if (match !== null) {
        clearTimeout(timer)
        resolve(match[0])
      }
    }
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', scan)
    child.once('exit', (code) => {
      clearTimeout(timer)
      reject(new Error(`chromium exited ${String(code)} before DevTools was ready`))
    })
  })
}

/**
 * A minimal DevTools-protocol client.
 *
 * Only three commands are needed (`Target.*`, `Page.*`, `Runtime.evaluate`), so a
 * full protocol library would be more surface than value — and this project's
 * self-checks stay dependency-free on purpose.
 */
class DevTools {
  /**
   * @param {string} url - browser WebSocket URL.
   */
  constructor(url) {
    this.url = url
    this.nextId = 1
    this.pending = new Map()
    this.sessions = new Map()
  }

  /** @returns {Promise<void>} resolves once connected. */
  connect() {
    return new Promise((resolve, reject) => {
      this.socket = new WebSocket(this.url)
      this.socket.addEventListener('open', () => resolve())
      this.socket.addEventListener('error', (event) => reject(new Error(`devtools socket failed: ${event?.message ?? 'error'}`)))
      this.socket.addEventListener('message', (event) => this.#dispatch(String(event.data)))
      this.socket.addEventListener('close', () => {
        for (const { reject: rejectPending } of this.pending.values()) rejectPending(new Error('devtools socket closed'))
        this.pending.clear()
      })
    })
  }

  /**
   * Route one protocol message.
   *
   * @param {string} raw - message text.
   */
  #dispatch(raw) {
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error !== undefined) reject(new Error(`${message.error.message} (${String(message.error.code)})`))
      else resolve(message.result ?? {})
      return
    }
    const key = message.sessionId
    if (key !== undefined && message.method !== undefined) {
      const waiters = this.sessions.get(key)
      if (waiters !== undefined) waiters.push(message)
    }
  }

  /**
   * Send one protocol command.
   *
   * @param {string} method - protocol method.
   * @param {object} [params] - parameters.
   * @param {string} [sessionId] - page session.
   * @returns {Promise<object>} the result.
   */
  send(method, params = {}, sessionId) {
    const id = this.nextId++
    const payload = { id, method, params }
    if (sessionId !== undefined) payload.sessionId = sessionId
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify(payload))
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} timed out`))
      }, 30_000)
    })
  }

  /**
   * Attach to the first page target, creating one if the browser has none.
   *
   * @returns {Promise<string>} the page session id.
   */
  async attachToPage() {
    const { targetInfos } = await this.send('Target.getTargets')
    const page = targetInfos.find((info) => info.type === 'page')
    const targetId = page?.targetId ?? (await this.send('Target.createTarget', { url: 'about:blank' })).targetId
    return this.#attach(targetId)
  }

  /**
   * Open an additional page target, for checking a second mount point in the
   * same browser process.
   *
   * @returns {Promise<string>} the page session id.
   */
  async createPage() {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' })
    return this.#attach(targetId)
  }

  /**
   * Attach to one target and enable the domains the checks use.
   *
   * @param {string} targetId - browser target id.
   * @returns {Promise<string>} the page session id.
   */
  async #attach(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    await this.send('Page.enable', {}, sessionId)
    await this.send('Runtime.enable', {}, sessionId)
    return sessionId
  }

  /**
   * Evaluate an expression in the page and return its value.
   *
   * @param {string} sessionId - page session.
   * @param {string} expression - expression to evaluate.
   * @returns {Promise<any>} the value.
   */
  async evaluate(sessionId, expression) {
    const result = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue: true, awaitPromise: true },
      sessionId
    )
    if (result.exceptionDetails !== undefined) {
      throw new Error(`page script threw: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`)
    }
    return result.result?.value
  }

  /**
   * Navigate and wait for the load event.
   *
   * @param {string} sessionId - page session.
   * @param {string} url - destination.
   * @returns {Promise<void>} resolves after load.
   */
  async navigate(sessionId, url) {
    const loaded = new Promise((resolve) => {
      const waiters = this.sessions.get(sessionId) ?? []
      this.sessions.set(sessionId, waiters)
      const poll = setInterval(() => {
        const index = waiters.findIndex((message) => message.method === 'Page.loadEventFired')
        if (index >= 0) {
          waiters.splice(index, 1)
          clearInterval(poll)
          resolve()
        }
      }, 25)
      setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, 20_000)
    })
    await this.send('Page.navigate', { url }, sessionId)
    await loaded
  }

  /** @returns {void} */
  close() {
    try {
      this.socket?.close()
    } catch {
      /* already gone */
    }
  }
}

const workdir = await mkdtemp(join(tmpdir(), 'dsh-remote-ui-check-'))
let relay
let browser
let devtools
let keepAlive

try {
  process.stdout.write('ui-check\n')

  const binary = await findChromium()
  if (binary === undefined) {
    process.stdout.write('  \u25CB no Chromium binary found; skipping (set DSH_REMOTE_CHROMIUM to run this)\n')
    process.stdout.write('ui-check: skipped\n')
    await rm(workdir, { recursive: true, force: true })
    process.exit(0)
  }
  check('a Chromium binary was found', existsSync(binary))

  // ── a real relay, and a real node identity registered into it ────────────
  const relayPort = 19_000 + Math.floor(Math.random() * 1_000)
  const relayUrl = `http://127.0.0.1:${String(relayPort)}`
  relay = spawnGuarded(process.execPath, [SERVER], {
    env: {
      ...process.env,
      DSH_REMOTE_RELAY_HOST: '127.0.0.1',
      DSH_REMOTE_RELAY_PORT: String(relayPort),
      DSH_REMOTE_AGENT_TOKEN: AGENT_TOKEN,
      DSH_REMOTE_CONTROL_TOKEN: CONTROL_TOKEN,
      DSH_REMOTE_POLL_HOLD_MS: '20000',
      DSH_REMOTE_OFFLINE_AFTER_MS: '60000'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('relay did not start')), 15_000)
    relay.stdout.setEncoding('utf8')
    relay.stdout.on('data', (chunk) => {
      if (String(chunk).includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    relay.once('exit', (code) => reject(new Error(`relay exited ${String(code)}`)))
  })

  /**
   * Call the relay as the node.
   *
   * @param {string} path - path.
   * @param {object} [body] - POST body.
   * @returns {Promise<object>} parsed body.
   */
  const asNode = async (path, body) => {
    const response = await fetch(`${relayUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${AGENT_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return response.json()
  }

  await asNode('/api/agent/hello', {
    nodeId: 'mac-1',
    name: 'Studio Mac',
    platform: 'darwin 24.0.0',
    workspaces: [
      { name: 'deepseek', path: '/Users/dev/deepseek' },
      { name: 'notes', path: '/Users/dev/notes' }
    ],
    // One machine with a visitor door open, so the guest section below drives the
    // real page against a real roster instead of a fixture it invented.
    guest: {
      enabled: true,
      agentPreset: 'reader',
      permissionPreset: 'read-only',
      workspaces: [{ name: 'notes', path: '/Users/dev/notes' }]
    }
  })

  // Seed one answered turn so the page has real history to render on load. The
  // control route is the only one that mints commands, so the seed goes through
  // it rather than through a hand-built envelope.
  const seededAnswer = {
    ok: true,
    prompt: '昨天改了什么？',
    workspace: '/Users/dev/deepseek',
    sessionId: 'remote-seeded',
    text: '改了远程控制插件的中转协议。',
    durationMs: 4200
  }

  /**
   * Call the relay as the browser page.
   *
   * @param {string} path - path.
   * @param {object} [body] - POST body.
   * @returns {Promise<object>} parsed body.
   */
  const control = async (path, body) => {
    const response = await fetch(`${relayUrl}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${CONTROL_TOKEN}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) })
    })
    return response.json()
  }

  const seedCommand = await control('/api/command', {
    nodeId: 'mac-1',
    workspace: '/Users/dev/deepseek',
    prompt: seededAnswer.prompt
  })
  await asNode('/api/agent/report', {
    nodeId: 'mac-1',
    status: 'idle',
    commandId: seedCommand.commandId,
    result: seededAnswer
  })
  // The real node re-sends its whole identity on every hello, guest block included;
  // this stand-in does the same, because a hello that omits the block now means
  // "this machine has no door".
  keepAlive = setInterval(() => {
    void asNode('/api/agent/hello', {
      nodeId: 'mac-1',
      name: 'Studio Mac',
      workspaces: [
        { name: 'deepseek', path: '/Users/dev/deepseek' },
        { name: 'notes', path: '/Users/dev/notes' }
      ],
      guest: {
        enabled: true,
        agentPreset: 'reader',
        permissionPreset: 'read-only',
        workspaces: [{ name: 'notes', path: '/Users/dev/notes' }]
      }
    }).catch(() => {})
  }, 5_000)

  // ── the browser ──────────────────────────────────────────────────────────
  const debuggingPort = 9_000 + Math.floor(Math.random() * 900)
  browser = spawnGuarded(
    binary,
    [
      '--headless=new',
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--window-size=1160,820',
      `--remote-debugging-port=${String(debuggingPort)}`,
      `--user-data-dir=${join(workdir, 'profile')}`,
      `http://127.0.0.1:${String(debuggingPort)}/json/version`
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  )
  const wsUrl = await waitForDevTools(browser).catch(async (error) => {
    // Some builds print the DevTools line on stdout instead of stderr.
    const response = await fetch(`http://127.0.0.1:${String(debuggingPort)}/json/version`)
    if (!response.ok) throw error
    return (await response.json()).webSocketDebuggerUrl
  })
  devtools = new DevTools(wsUrl)
  await devtools.connect()
  const sessionId = await devtools.attachToPage()

  // ── first load, fresh profile: the gate ──────────────────────────────────
  await devtools.navigate(sessionId, `${relayUrl}/`)
  const gateVisible = await devtools.evaluate(sessionId, `getComputedStyle(document.getElementById('gate')).display !== 'none'`)
  check('the login gate is shown when no token is stored', gateVisible === true)
  const gateShot = join(workdir, '01-gate.png')
  const gateImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(gateShot, Buffer.from(gateImage.data, 'base64'))

  // ── reload with the token seeded, exactly where the page looks for it ─────
  await devtools.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: `localStorage.setItem('dsh-remote-control-token', ${JSON.stringify(CONTROL_TOKEN)});` },
    sessionId
  )
  await devtools.navigate(sessionId, `${relayUrl}/`)
  const entered = await devtools.evaluate(
    sessionId,
    `document.getElementById('app').classList.contains('on') && getComputedStyle(document.getElementById('gate')).display === 'none'`
  )
  check('the gate closes once a token is stored', entered === true)

  // The roster arrives over SSE, and the auto-selection that follows it loads the
  // workspaces and the transcript asynchronously. Wait for the rendered result
  // rather than for a fixed delay, so the check tests the page and not the clock.
  const ready = await waitFor(
    () =>
      devtools.evaluate(
        sessionId,
        `JSON.stringify({
           nodes: document.getElementById('nodes').textContent,
           workspaces: document.getElementById('workspaces').textContent,
           log: document.getElementById('log').textContent
         })`
      ),
    (text) => {
      const snapshot = JSON.parse(String(text))
      return (
        snapshot.nodes.includes('Studio Mac') &&
        snapshot.workspaces.includes('notes') &&
        snapshot.log.includes('改了远程控制插件的中转协议。')
      )
    },
    20_000
  )
  check('the roster, workspaces, and history all render after auto-selection', ready, 'the page never reached a usable state')

  const view = await devtools.evaluate(
    sessionId,
    `JSON.stringify({
       nodes: document.getElementById('nodes').textContent,
       workspaces: document.getElementById('workspaces').textContent,
       log: document.getElementById('log').textContent,
       hint: document.getElementById('hint').textContent,
       sendDisabled: document.getElementById('send').disabled
     })`
  )
  const parsed = JSON.parse(view)
  check('the node is reported idle', parsed.nodes.includes('空闲'), parsed.nodes)
  check('the node reports its workspace count', parsed.nodes.includes('2 个工作台'), parsed.nodes)
  check('both workbenches are listed', parsed.workspaces.includes('deepseek') && parsed.workspaces.includes('notes'))
  check('the seeded question is rendered', parsed.log.includes('昨天改了什么？'))
  check('the seeded answer is rendered', parsed.log.includes('改了远程控制插件的中转协议。'))
  check('the answer carries its duration', parsed.log.includes('4.2s'), parsed.log)
  check('the composer states the permission posture', parsed.hint.includes('workspace-write + ask'), parsed.hint)
  check('the composer is enabled with a node and workspace selected', parsed.sendDisabled === false)
  const appShot = join(workdir, '02-app.png')
  const appImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(appShot, Buffer.from(appImage.data, 'base64'))

  // ── typing a question and pressing the page's own send button ────────────
  await devtools.evaluate(
    sessionId,
    `(() => {
       const box = document.getElementById('prompt');
       box.value = '总结一下今天的改动';
       box.dispatchEvent(new Event('input', { bubbles: true }));
       document.getElementById('send').click();
       return box.value;
     })()`
  )
  // The composer must clear immediately: it is the only part of sending a person
  // waits on, and making it depend on the round trip is the difference between a
  // responsive page and a laggy one on a slow link.
  const composerCleared = await devtools.evaluate(sessionId, `document.getElementById('prompt').value === ''`)
  check('the composer clears immediately after sending', composerCleared === true)

  const submitted = await waitFor(
    () => control('/api/state?nodeId=mac-1').then((state) => JSON.stringify(state.transcript)),
    (transcript) => String(transcript).includes('总结一下今天的改动'),
    15_000
  )
  check('the page submitted the question to the relay', submitted, 'the send button never reached /api/command')

  // ── play the node: pick the question up and answer it ────────────────────
  // The queued seed command comes back first, because this check registered the
  // node after seeding and never drained it. A real node would have run it, so the
  // stand-in does the same and then waits for the question the page just sent.
  let command
  const commandDeadline = Date.now() + 20_000
  while (Date.now() < commandDeadline) {
    const polled = await asNode('/api/agent/poll', { nodeId: 'mac-1' })
    if (polled.command === null || polled.command === undefined) continue
    command = polled.command
    if (command.prompt === '总结一下今天的改动') break
    await asNode('/api/agent/report', {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: command.commandId,
      result: { ok: true, prompt: command.prompt, workspace: command.workspace, sessionId: 'remote-seeded', text: '（历史命令）', durationMs: 10 }
    })
  }
  check('the pending question is waiting on the node long-poll', command?.prompt === '总结一下今天的改动', JSON.stringify(command))
  await asNode('/api/agent/report', {
    nodeId: 'mac-1',
    status: 'idle',
    commandId: command.commandId,
    result: {
      ok: true,
      prompt: command.prompt,
      workspace: command.workspace,
      sessionId: 'remote-seeded',
      // The answer is Markdown on purpose: this is what a DSH agent actually
      // writes, and it is the only way the page's rendering is exercised. The
      // trailing tag is not decoration — the page renders text a model produced,
      // so the check below asserts it stays text.
      text: [
        '今天把中转协议抽成了独立的一层，并补齐了四个自检。',
        '',
        '- **relay**：长轮询不再丢命令',
        '- `node`：多了回落',
        '',
        '```ts',
        'const ok: boolean = true',
        '```',
        '',
        '| 文件 | 变化 |',
        '| --- | ---: |',
        '| relay/server.js | +40 |',
        '',
        '见 [relay 那一层](https://example.com/relay?x=1)，以及 [别点这个](javascript:alert(1))。',
        '',
        '<script>window.__mdInjected = true</script>'
      ].join('\n'),
      durationMs: 1500
    }
  })

  const rendered = await waitFor(
    () => devtools.evaluate(sessionId, `document.getElementById('log').textContent`),
    (text) => String(text).includes('今天把中转协议抽成了独立的一层'),
    15_000
  )
  check('the node’s answer appears on the page without a reload', rendered, 'the SSE transcript push never reached the page')

  // ── the answer is Markdown, and rendering it cannot execute it ───────────
  // Agents answer in Markdown, and two things have to hold at once. The
  // constructs must become real elements — a fenced block is the difference
  // between a readable answer and one long wrapped line, which is the whole
  // complaint this rendering answers. And none of the text may become markup:
  // the page renders what a model wrote, so a tag in an answer has to stay
  // visible characters. A `textContent`+`innerHTML` renderer passes the first
  // and fails the second, which is why both are asserted in one place.
  const markdown = JSON.parse(String(await devtools.evaluate(sessionId, `(() => {
    const row = [...document.querySelectorAll('#log .a')].find((el) => el.textContent.includes('今天把中转协议抽成了独立的一层'));
    if (row === undefined) return '{}';
    const body = row.querySelector('.a-text');
    return JSON.stringify({
      rendered: body.classList.contains('md'),
      code: [...body.querySelectorAll('pre code')].map((el) => el.textContent).join('\\n'),
      lang: body.querySelector('.md-lang')?.textContent ?? '',
      strong: [...body.querySelectorAll('strong')].map((el) => el.textContent).join('|'),
      inline: [...body.querySelectorAll('code')].filter((el) => el.closest('pre') === null).map((el) => el.textContent).join('|'),
      items: [...body.querySelectorAll('li')].map((el) => el.textContent).join('|'),
      cells: [...body.querySelectorAll('th')].map((el) => el.textContent + ':' + el.style.textAlign).join('|'),
      links: [...body.querySelectorAll('a')].map((el) => el.textContent + ':' + el.getAttribute('href')).join('|'),
      refused: [...body.querySelectorAll('a')].some((el) => (el.getAttribute('href') ?? '').startsWith('javascript:')),
      refusedLiteral: body.textContent.includes('[别点这个](javascript:alert(1))'),
      paragraphs: body.querySelectorAll('p').length,
      script: body.querySelector('script') !== null,
      injected: window.__mdInjected === true,
      literal: body.textContent.includes('<script>window.__mdInjected = true</script>')
    });
  })()`)))
  check(
    'an answer is rendered as markdown, not as one pre-wrapped string',
    markdown.rendered === true && markdown.paragraphs >= 2,
    JSON.stringify(markdown)
  )
  check('a fenced code block keeps its own lines', markdown.code === 'const ok: boolean = true', JSON.stringify(markdown.code))
  check('a fence language is labelled', markdown.lang === 'ts', JSON.stringify(markdown))
  check('emphasis becomes markup', markdown.strong === 'relay', JSON.stringify(markdown.strong))
  check('an inline code span becomes an element', markdown.inline === 'node', JSON.stringify(markdown.inline))
  check('a list becomes list items', markdown.items === 'relay：长轮询不再丢命令|node：多了回落', JSON.stringify(markdown.items))
  check('a pipe table becomes a table, with its alignment', markdown.cells === '文件:left|变化:right', JSON.stringify(markdown.cells))
  check('a link becomes an anchor with its label', markdown.links === 'relay 那一层:https://example.com/relay?x=1', JSON.stringify(markdown.links))
  // `[x](javascript:…)` is valid Markdown and this page renders model output, so
  // the refused scheme has to end up as visible text rather than as an href.
  check(
    'a link with a refused scheme stays literal, with no anchor',
    markdown.refused === false && markdown.refusedLiteral === true,
    JSON.stringify(markdown)
  )
  check(
    'markup inside an answer stays text and never executes',
    markdown.script === false && markdown.injected === false && markdown.literal === true,
    JSON.stringify(markdown)
  )

  const finalShot = join(workdir, '03-answered.png')
  const finalImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(finalShot, Buffer.from(finalImage.data, 'base64'))

  // ── a second target, and the isolation that makes it worth having ────────
  // Everything above proves that one machine in one workspace works. The whole
  // point of the tab strip is that a second target works *alongside* the first
  // without either leaking into the other, so this opens a second workspace on
  // the same node and checks exactly that — through the sidebar, the way a
  // person would.
  const opened = await devtools.evaluate(
    sessionId,
    `(() => {
       const buttons = [...document.querySelectorAll('#workspaces .ws')];
       const notes = buttons.find((button) => button.textContent.includes('notes'));
       if (notes === undefined) return 'no notes workspace in the sidebar';
       notes.click();
       return 'clicked';
     })()`
  )
  check('the sidebar offers the second workspace as a target', opened === 'clicked', String(opened))

  const twoTabs = await waitFor(
    () => devtools.evaluate(sessionId, `document.querySelectorAll('#tabs .tab').length`),
    (count) => Number(count) === 2,
    5_000
  )
  check('opening a second workspace adds a second tab', twoTabs, 'the tab strip never reached two tabs')

  const secondTab = await devtools.evaluate(
    sessionId,
    `JSON.stringify({
       label: document.querySelectorAll('#tabs .tab')[1]?.textContent ?? '',
       selected: document.querySelectorAll('#tabs .tab')[1]?.classList.contains('sel') ?? false,
       log: document.getElementById('log').textContent
     })`
  )
  const parsedSecond = JSON.parse(secondTab)
  check('the new tab is the active one', parsedSecond.selected === true, secondTab)
  check('the new tab names its own workspace', parsedSecond.label.includes('notes'), parsedSecond.label)
  // The relay keeps one transcript per node, so without partitioning the second
  // tab would open showing the first workspace's conversation.
  check(
    'the first workspace history does not leak into the second tab',
    !parsedSecond.log.includes('改了远程控制插件的中转协议。'),
    parsedSecond.log
  )

  await devtools.evaluate(
    sessionId,
    `(() => {
       const box = document.getElementById('prompt');
       box.value = 'notes 里有什么？';
       box.dispatchEvent(new Event('input', { bubbles: true }));
       document.getElementById('send').click();
       return box.value;
     })()`
  )
  let notesCommand
  const notesDeadline = Date.now() + 20_000
  while (Date.now() < notesDeadline) {
    const polled = await asNode('/api/agent/poll', { nodeId: 'mac-1' })
    if (polled.command === null || polled.command === undefined) continue
    if (polled.command.prompt === 'notes 里有什么？') {
      notesCommand = polled.command
      break
    }
    // A straggler from an earlier step: answer it so the poll moves on.
    await asNode('/api/agent/report', {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: polled.command.commandId,
      result: {
        ok: true,
        prompt: polled.command.prompt,
        workspace: polled.command.workspace,
        sessionId: 'remote-straggler',
        text: '（历史命令）',
        durationMs: 10
      }
    })
  }
  check(
    'the second tab dispatches to its own workspace',
    notesCommand?.workspace === '/Users/dev/notes',
    JSON.stringify(notesCommand)
  )
  // The regression this guards: a session belongs to the workspace it was
  // created in, so inheriting the first workspace's `sessionId` here would run
  // the question in the wrong directory and still report success.
  check(
    'the second tab does not inherit the first workspace session',
    notesCommand !== undefined && notesCommand.sessionId === undefined,
    JSON.stringify(notesCommand)
  )

  if (notesCommand !== undefined) {
    await asNode('/api/agent/report', {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: notesCommand.commandId,
      result: {
        ok: true,
        prompt: notesCommand.prompt,
        workspace: notesCommand.workspace,
        sessionId: 'remote-notes',
        text: 'notes 工作台里只有会议记录。',
        durationMs: 700
      }
    })
  }
  const notesRendered = await waitFor(
    () => devtools.evaluate(sessionId, `document.getElementById('log').textContent`),
    (text) => String(text).includes('notes 工作台里只有会议记录。'),
    15_000
  )
  check('the second tab renders its own answer', notesRendered)

  await devtools.evaluate(sessionId, `document.querySelectorAll('#tabs .tab')[0].click(); 'ok'`)
  const backToFirst = await waitFor(
    () => devtools.evaluate(sessionId, `document.getElementById('log').textContent`),
    (text) => String(text).includes('改了远程控制插件的中转协议。') && !String(text).includes('notes 工作台里只有会议记录。'),
    5_000
  )
  check('switching tabs swaps the transcript back', backToFirst)
  const tabsShot = join(workdir, '05-two-targets.png')
  const tabsImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(tabsShot, Buffer.from(tabsImage.data, 'base64'))

  // ── the agent's question, answered from the page ─────────────────────────
  // This is the flow the whole feature exists for, driven the way a person does
  // it: the node parks a question, the card appears without a reload, an option is
  // clicked on the page's own control, and the parked request receives the answer.
  // A unit check cannot cover it, because the pieces that can break are the DOM
  // and the push that fills it.
  const pageCommand = await control('/api/command', {
    nodeId: 'mac-1',
    workspace: '/Users/dev/deepseek',
    prompt: '帮我回顾一下这次的改动'
  })
  let reviewCommand
  const reviewDeadline = Date.now() + 20_000
  while (Date.now() < reviewDeadline) {
    const polled = await asNode('/api/agent/poll', { nodeId: 'mac-1' })
    if (polled.command === null || polled.command === undefined) continue
    if (polled.command.commandId === pageCommand.commandId) {
      reviewCommand = polled.command
      break
    }
    // Anything else queued on this node is history from an earlier section.
    await asNode('/api/agent/report', {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: polled.command.commandId,
      result: { ok: true, prompt: polled.command.prompt, workspace: polled.command.workspace, text: '（历史命令）', durationMs: 10 }
    })
  }
  check('the turn that will ask the question is running', reviewCommand !== undefined, JSON.stringify(pageCommand))

  const askPromise = fetch(`${relayUrl}/api/agent/ask`, {
    method: 'POST',
    headers: { authorization: `Bearer ${AGENT_TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      nodeId: 'mac-1',
      questions: [
        {
          id: 'scope',
          header: '范围',
          // A question is model-written text too, and a backticked path in it is
          // the normal case; the card has to render it rather than print it.
          question: '这次回顾要覆盖哪一部分？\n\n只看 `relay/public` 还是整个包？',
          options: [
            { label: '全部改动 (Recommended)', description: '从上一个版本开始算。' },
            { label: '仅这个工作台' }
          ]
        }
      ]
    })
  }).then((response) => response.json())

  // The card has to land in the turn that asked it, not at the end of the
  // transcript: with several targets and a queued turn, "somewhere in the log" is
  // how a card ends up looking like it belongs to a different question.
  const cardInTurn = await waitFor(
    () => devtools.evaluate(sessionId, `(() => {
      const card = document.querySelector('.ask');
      if (card === null) return 'missing';
      const turn = card.closest('.turn');
      return JSON.stringify({
        turnText: turn === null ? '' : turn.textContent,
        options: card.querySelectorAll('.ask-opt').length,
        submitDisabled: card.querySelector('.ask-foot .btn').disabled,
        inViewport: (() => { const r = card.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1 })()
      });
    })()`),
    (value) => String(value) !== 'missing' && String(value).includes('这次回顾要覆盖哪一部分？'),
    15_000
  )
  check('the agent question reaches the page without a reload', cardInTurn, 'the question push never rendered a card')
  const cardState = JSON.parse(String(await devtools.evaluate(sessionId, `(() => {
    const card = document.querySelector('.ask');
    if (card === null) return '{}';
    const turn = card.closest('.turn');
    return JSON.stringify({
      turnText: turn === null ? '' : turn.textContent,
      options: card.querySelectorAll('.ask-opt').length,
      askCode: card.querySelector('.ask-text code')?.textContent ?? '',
      submitDisabled: card.querySelector('.ask-foot .btn').disabled,
      inViewport: (() => { const r = card.getBoundingClientRect(); return r.width > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1 })()
    });
  })()`)))
  check(
    'the card is rendered in the turn that asked it',
    String(cardState.turnText).includes('帮我回顾一下这次的改动'),
    JSON.stringify(cardState.turnText)
  )
  check('the question card renders the model’s markdown', cardState.askCode === 'relay/public', JSON.stringify(cardState.askCode))
  check('the card offers every option the model sent', cardState.options === 2, JSON.stringify(cardState))
  // Submitting before choosing would answer nothing, so the button has to start
  // disabled rather than let the page post an empty batch.
  check('the card refuses to submit an unanswered question', cardState.submitDisabled === true, JSON.stringify(cardState))
  // The card lives in the transcript, so it is subject to its scroll container: a
  // card rendered outside the viewport is the same failure as one never rendered.
  check('the card is inside the viewport when it appears', cardState.inViewport === true, JSON.stringify(cardState))
  const cardShot = join(workdir, '06-agent-question.png')
  const cardImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, sessionId)
  await writeFile(cardShot, Buffer.from(cardImage.data, 'base64'))

  await devtools.evaluate(sessionId, `document.querySelectorAll('.ask-opt')[0].click(); 'ok'`)
  const readyToSubmit = await waitFor(
    () => devtools.evaluate(sessionId, `document.querySelector('.ask-foot .btn').disabled`),
    (disabled) => disabled === false,
    3_000
  )
  check('choosing an option enables submission', readyToSubmit === true)
  await devtools.evaluate(sessionId, `document.querySelector('.ask-foot .btn').click(); 'ok'`)
  const asked = await Promise.race([askPromise, sleep(10_000).then(() => undefined)])
  check(
    'the page’s answer reaches the parked question',
    asked?.answers?.[0]?.selected?.[0] === '全部改动 (Recommended)',
    JSON.stringify(asked)
  )
  const cardRetired = await waitFor(
    () => devtools.evaluate(sessionId, `document.querySelector('.ask') === null`),
    (gone) => gone === true,
    8_000
  )
  check('the answered card is retired from the page', cardRetired === true)
  if (reviewCommand !== undefined) {
    await asNode('/api/agent/report', {
      nodeId: 'mac-1',
      status: 'idle',
      commandId: reviewCommand.commandId,
      result: {
        ok: true,
        prompt: reviewCommand.prompt,
        workspace: reviewCommand.workspace,
        sessionId: 'remote-seeded',
        text: '按你选的「全部改动」回顾了一遍。',
        durationMs: 900
      }
    })
  }

  // ── a transient message has to be somewhere a person can see it ──────────
  // The toast is `position: absolute` against the composer, so a missing
  // `position: relative` on that ancestor silently resolves it against the
  // viewport and flings it above the top of the page: in the DOM, invisible on
  // screen, and passing any check that only asked whether it existed.
  await devtools.evaluate(sessionId, `document.getElementById('newchat').click(); 'ok'`)
  const toastBox = await devtools.evaluate(
    sessionId,
    `(() => {
       const el = document.getElementById('toast');
       if (el.hidden) return 'hidden';
       const rect = el.getBoundingClientRect();
       return JSON.stringify({
         top: Math.round(rect.top), bottom: Math.round(rect.bottom),
         width: Math.round(rect.width), height: window.innerHeight
       });
     })()`
  )
  let toastOnScreen = false
  if (toastBox !== 'hidden') {
    const box = JSON.parse(String(toastBox))
    toastOnScreen = box.width > 0 && box.top >= 0 && box.bottom <= box.height
  }
  check('a transient message renders inside the viewport', toastOnScreen, String(toastBox))

  // ── the visitor's door, in a real browser ────────────────────────────────
  // The relay checks above prove the protocol; this proves the *page* a stranger
  // actually lands on. Three things have to be true at once: nobody is asked for a
  // password, the visitor is told which door they came in through, and the machine
  // offers only the directories it opened to visitors.
  {
    const guestPage = await devtools.createPage()
    await devtools.navigate(guestPage, `${relayUrl}/guest`)
    const entered = await waitFor(
      () => devtools.evaluate(guestPage, `document.body.classList.contains('booting') || document.getElementById('app').classList.contains('on')`),
      (value) => value === true,
      15_000
    )
    check('the guest page enters without being asked for anything', entered)
    const gateShown = await devtools.evaluate(guestPage, `getComputedStyle(document.getElementById('gate')).display !== 'none'`)
    check('no login card is left on screen for a visitor', gateShown === false, 'the gate is still visible on /guest')
    const badge = await devtools.evaluate(guestPage, `(() => {
      const el = document.getElementById('mode-badge');
      return JSON.stringify({ hidden: el.hidden, text: el.textContent });
    })()`)
    check('the page says it is the visitor door', JSON.parse(String(badge)).text === '游客' && JSON.parse(String(badge)).hidden === false, String(badge))
    const guestNodes = await waitFor(
      () => devtools.evaluate(guestPage, `document.getElementById('nodes').textContent`),
      (text) => String(text).includes('Studio Mac'),
      15_000
    )
    check('the visitor sees the machine that opened a door', guestNodes)
    const guestWorkspaces = await devtools.evaluate(guestPage, `document.getElementById('workspaces').textContent`)
    check(
      'the visitor is offered the guest workspace',
      String(guestWorkspaces).includes('notes'),
      String(guestWorkspaces)
    )
    check(
      'and not the operator workspace beside it',
      !String(guestWorkspaces).includes('deepseek'),
      `the sidebar listed an operator-only directory: ${String(guestWorkspaces)}`
    )
    // Visibility, not the `hidden` property: `hidden` is only `display: none` in
    // the UA stylesheet, so an author `display` rule (`.btn { display:inline-flex }`)
    // silently wins. The first version of this page set the attribute and left the
    // broadcast button on screen, which is exactly what this reads for.
    const guestChrome = await devtools.evaluate(guestPage, `(() => {
      const hint = document.getElementById('hint').textContent;
      return JSON.stringify({
        broadcastVisible: getComputedStyle(document.getElementById('broadcast')).display !== 'none',
        readOnlyHint: hint.includes('只读'),
        carriesOwnerSession: hint.includes('续接会话'),
        ownerUrlVisible: getComputedStyle(document.getElementById('guest-door')).display !== 'none'
      });
    })()`)
    const chrome = JSON.parse(String(guestChrome))
    check('the visitor is not offered a broadcast button', chrome.broadcastVisible === false, String(guestChrome))
    check('the visitor is told the agent is read-only', chrome.readOnlyHint === true, String(guestChrome))
    check(
      'the visitor does not inherit the operator’s stored conversation',
      chrome.carriesOwnerSession === false,
      `the guest page continued the operator's session id: ${String(guestChrome)}`
    )
    check('a visitor is not shown the operator’s door panel', chrome.ownerUrlVisible === false, String(guestChrome))
    const guestShot = join(workdir, '07-guest.png')
    const guestImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, guestPage)
    await writeFile(guestShot, Buffer.from(guestImage.data, 'base64'))

    // A visitor arrives with a stored identity that the relay no longer knows —
    // it expired, or the relay restarted — which is the ordinary case rather than
    // an error case. The page must quietly mint a new one instead of showing the
    // visitor a credential failure for something they never had.
    const stalePage = await devtools.createPage()
    await devtools.send(
      'Page.addScriptToEvaluateOnNewDocument',
      { source: `localStorage.setItem('dsh-remote-control-guest-token', 'a-token-the-relay-forgot');` },
      stalePage
    )
    await devtools.navigate(stalePage, `${relayUrl}/guest`)
    const recovered = await waitFor(
      () => devtools.evaluate(stalePage, `document.getElementById('app').classList.contains('on')`),
      (value) => value === true,
      15_000
    )
    check('a stale visitor identity is replaced rather than reported as an error', recovered)
    const recoveryError = await devtools.evaluate(stalePage, `document.getElementById('gate-err').textContent`)
    check('and no error is left on screen for it', String(recoveryError) === '', String(recoveryError))

    // The operator's own page is where the door is discoverable, so the link has
    // to be there and has to point at the mount point this page was served from.
    const ownerLink = await devtools.evaluate(
      sessionId,
      `(() => {
        const box = document.getElementById('guest-door');
        return JSON.stringify({ hidden: box.hidden, url: document.getElementById('guest-door-url').textContent });
      })()`
    )
    const link = JSON.parse(String(ownerLink))
    check('the operator page offers the visitor link', link.hidden === false && link.url.endsWith('/guest'), String(ownerLink))
  }

  // ── the production mount: the same page behind a stripped prefix ─────────
  // This is the case that matters in deployment and the one a root-mounted test
  // cannot see. nginx serves the page at `/harness/` but passes `/` to the relay
  // (the trailing slash on `proxy_pass` strips the prefix), so a root-absolute
  // `/api/...` from the page would be answered by whatever else owns the domain
  // root — and the page would load and then do nothing at all. This proxy copies
  // that behaviour exactly: strip the prefix on the way in, advertise it on the
  // way out.
  const proxy = createServer(async (req, res) => {
    const raw = req.url ?? '/'
    const stripped = raw.startsWith('/harness') ? raw.slice('/harness'.length) || '/' : raw
    let upstream
    try {
      upstream = await fetch(`http://127.0.0.1:${String(relayPort)}${stripped}`, {
        method: req.method,
        headers: {
          ...(req.headers.authorization === undefined ? {} : { authorization: req.headers.authorization }),
          'x-forwarded-prefix': '/harness'
        }
      })
    } catch (error) {
      res.writeHead(502).end(String(error))
      return
    }
    const buffer = Buffer.from(await upstream.arrayBuffer())
    res.writeHead(upstream.status, {
      'content-type': upstream.headers.get('content-type') ?? 'application/octet-stream',
      'cache-control': 'no-store'
    })
    res.end(buffer)
  })
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
  const proxyOrigin = `http://127.0.0.1:${String(proxy.address().port)}`

  // The data path is untouched by the prefix hint: only HTML carries a `<base>`.
  const stateThroughProxy = await fetch(`${proxyOrigin}/harness/api/state`, {
    headers: { authorization: `Bearer ${CONTROL_TOKEN}` }
  })
  check('an API call under the prefix reaches the relay', stateThroughProxy.status === 200, `HTTP ${String(stateThroughProxy.status)}`)
  const stateBody = await stateThroughProxy.json()
  check('the prefixed API call returns the roster, not a proxy error', Array.isArray(stateBody.nodes) && stateBody.nodes.length > 0)

  const prefixed = await devtools.createPage()
  await devtools.send(
    'Page.addScriptToEvaluateOnNewDocument',
    { source: `localStorage.setItem('dsh-remote-control-token', ${JSON.stringify(CONTROL_TOKEN)});` },
    prefixed
  )
  await devtools.navigate(prefixed, `${proxyOrigin}/harness/`)
  const prefixedReady = await waitFor(
    () => devtools.evaluate(prefixed, `document.getElementById('nodes').textContent`),
    (text) => String(text).includes('Studio Mac'),
    15_000
  )
  check(
    'the page works when mounted under a stripped sub-path',
    prefixedReady,
    'the roster never arrived under /harness/ — the page is calling the origin root instead of its own mount point'
  )
  const prefixedBase = await devtools.evaluate(prefixed, `document.baseURI`)
  check('the relay advertises the public mount prefix in the page base', String(prefixedBase).endsWith('/harness/'), String(prefixedBase))
  const prefixedShot = join(workdir, '04-prefixed.png')
  const prefixedImage = await devtools.send('Page.captureScreenshot', { format: 'png' }, prefixed)
  await writeFile(prefixedShot, Buffer.from(prefixedImage.data, 'base64'))

  // A prefix the relay cannot sanitize must not reach the markup.
  const hostile = await fetch(`http://127.0.0.1:${String(relayPort)}/`, {
    headers: { 'x-forwarded-prefix': '/harness"><script>alert(1)</script>' }
  })
  const hostileHtml = await hostile.text()
  check('a markup-bearing prefix is refused rather than injected', !hostileHtml.includes('<script>alert(1)</script>'))
  proxy.close()
  proxy.closeAllConnections?.()

  process.stdout.write(`\nui-check: ${String(checks - failures)}/${String(checks)} passed\n`)
  process.stdout.write(`ui-check: screenshots ${workdir}/0{1,2,3,4,5,6,7}-*.png\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nui-check: harness error — ${error?.stack ?? error}\n`)
  process.stdout.write(`ui-check: workdir kept at ${workdir}\n`)
} finally {
  clearInterval(keepAlive)
  devtools?.close()
  await stopGuarded(browser)
  await stopGuarded(relay)
  if (trackedCount() > 0) {
    failures += 1
    process.stdout.write(`ui-check: leaked ${String(trackedCount())} child process(es)\n`)
  }
  if (failures > 0) process.stdout.write(`ui-check: kept ${workdir}\n`)
}

/**
 * Poll an async producer until a predicate holds.
 *
 * Page state arrives over an event stream and a socket, so a fixed sleep would
 * either be flaky or slow. This waits for the observable fact instead.
 *
 * @param {() => Promise<any>} produce - reads the current value.
 * @param {(value: any) => boolean} predicate - the condition to wait for.
 * @param {number} timeoutMs - how long to wait.
 * @returns {Promise<boolean>} whether the predicate ever held.
 */
async function waitFor(produce, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      if (predicate(await produce())) return true
    } catch {
      /* transient: the page may be mid-render */
    }
    await sleep(150)
  }
  return false
}

if (failures > 0) process.exitCode = 1
