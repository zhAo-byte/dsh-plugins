#!/usr/bin/env node
/**
 * `node-check` — the node half of the wire, against a fake relay.
 *
 * The sibling `relay-check` drives the real relay. This one drives the real node
 * client, so the two together cover both ends of the same contract without
 * needing a live Harness. What is *not* covered here is the Harness API surface
 * itself (`ctx.agents`, presets, workspaces) — `runner-check` covers the pure
 * parts of that, and a real session is covered by `live-check`, which needs a
 * running backend.
 *
 * @module dsh-remote-control/tools/node-check
 */

import { spawn } from 'node:child_process'
import { readFile, readdir } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { RelayAuthError, RelayClient, RelayUnreachableError, normalizeRelayUrl } from '../lib/client.js'
import { deriveNodeId } from '../lib/config.js'
import { normalizeWorkspaces } from '../lib/runner.js'

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
 * Assert that a call rejects with a specific error class.
 *
 * @param {string} what - description.
 * @param {Function} run - thunk returning a promise.
 * @param {Function} expected - expected error constructor.
 * @returns {Promise<Error|undefined>} the caught error.
 */
async function rejects(what, run, expected) {
  try {
    await run()
    check(what, false, 'it resolved instead of rejecting')
    return undefined
  } catch (error) {
    check(what, error instanceof expected, `got ${error?.name}: ${error?.message}`)
    return error
  }
}

/** Recorded requests from the fake relay. */
const seen = []
let responder = () => ({ status: 200, body: {} })

const relay = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw === '' ? undefined : JSON.parse(raw)
    } catch {
      body = raw
    }
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body })
    const { status, body: responseBody } = responder(req.url, body)
    const payload = JSON.stringify(responseBody)
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(payload)
  })
})

await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
const port = relay.address().port
const base = `http://127.0.0.1:${String(port)}`

try {
  process.stdout.write('node-check\n')

  // ── the plugin module must load without the Harness present ──────────────
  // A real regression, caught by CI on all three platforms: `lib/index.js` used
  // to begin with a static `import Schema from '@deepseek-ai/schemastery'`. A peer
  // dependency imported at module top level is a hard requirement to *load* the
  // module — so every check, and every non-Harness context, died with
  // ERR_MODULE_NOT_FOUND while the schema itself was never read. It never showed
  // up locally because the development symlink made the package visible.
  //
  // Two assertions: no `@deepseek-ai/*` static import anywhere in the package's
  // own lib, and the entry point actually importing in a subprocess.
  {
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

    const offenders = []
    for (const file of await readdir(join(packageRoot, 'lib'))) {
      if (!file.endsWith('.js')) continue
      const source = await readFile(join(packageRoot, 'lib', file), 'utf8')
      for (const line of source.split('\n')) {
        if (/^\s*import\b/.test(line) && line.includes('@deepseek-ai/')) {
          offenders.push(`lib/${file}: ${line.trim()}`)
        }
      }
    }
    check(
      'no package-internal module statically imports a Harness peer dependency',
      offenders.length === 0,
      offenders.join(' | ')
    )

    // The value helpers are reached through a lazy `require`-based resolver, so
    // the entry point must import cleanly even with no `@deepseek-ai` in sight.
    const probe = spawn(
      process.execPath,
      [
        '-e',
        // `import()` takes a URL, not a path. Handing it a bare Windows path
        // (`D:\a\...`) fails with ERR_UNSUPPORTED_ESM_URL_SCHEME, which is a bug
        // in this check rather than in the plugin — and one that only ever shows
        // up on Windows.
        `import(${JSON.stringify(pathToFileURL(join(packageRoot, 'lib', 'index.js')).href)})` +
          `.then((m) => { console.log(typeof m.apply === 'function' ? 'apply-ok' : 'no-apply'); process.exit(0) })` +
          `.catch((e) => { console.error(e.code ?? e.message); process.exit(3) })`
      ],
      { env: { ...process.env, DSH_REMOTE_CONTROL_PROFILE_DIR: '/nonexistent-on-purpose' } }
    )
    let out = ''
    let err = ''
    probe.stdout.setEncoding('utf8')
    probe.stdout.on('data', (chunk) => {
      out += chunk
    })
    probe.stderr.setEncoding('utf8')
    probe.stderr.on('data', (chunk) => {
      err += chunk
    })
    const code = await new Promise((resolve) => probe.once('exit', resolve))
    check(
      'the entry point imports with no Harness packages reachable',
      code === 0 && out.includes('apply-ok'),
      `${err.trim().slice(0, 200)} (exit ${String(code)})`
    )
  }

  // ── URL normalization ────────────────────────────────────────────────────
  check('a bare origin survives normalization', normalizeRelayUrl('https://icyu.online') === 'https://icyu.online')
  check(
    'a sub-path is preserved and a trailing slash dropped',
    normalizeRelayUrl('https://icyu.online/harness/') === 'https://icyu.online/harness'
  )
  check('a non-URL is rejected', (() => {
    try {
      normalizeRelayUrl('not a url')
      return false
    } catch {
      return true
    }
  })())
  check('a non-http scheme is rejected', (() => {
    try {
      normalizeRelayUrl('ftp://host/relay')
      return false
    } catch (error) {
      return error instanceof TypeError && error.message.includes('http')
    }
  })())

  // ── node identity ────────────────────────────────────────────────────────
  const idA = deriveNodeId()
  const idB = deriveNodeId()
  check('the derived node id is stable across calls', idA === idB)
  check('the derived node id is URL-safe', /^node-[0-9a-f]{12}$/.test(idA), idA)

  // ── workspace normalization ──────────────────────────────────────────────
  // Every path assertion here has to be platform-neutral. `/tmp` is not a place
  // on Windows, so the checks use the home directory (which exists everywhere)
  // and assert relationships rather than literal prefixes — the first version of
  // this block asserted `startsWith('/')` and failed on windows-latest for a
  // reason that had nothing to do with the code under test.
  const stringForm = normalizeWorkspaces(['/tmp', '~/projects'])
  check('a string entry becomes a named workspace', stringForm[0].name === '/tmp' && stringForm[0].path === '/tmp')
  check(
    'a leading ~ expands under the home directory',
    stringForm[1].path.startsWith(homedir()) && !stringForm[1].path.startsWith('~'),
    `${stringForm[1].path} (home is ${homedir()})`
  )
  const objectForm = normalizeWorkspaces([{ name: 'proj', path: '/tmp' }])
  check('an object entry keeps its display name', objectForm[0].name === 'proj' && objectForm[0].path === '/tmp')
  check('a relative path is refused', (() => {
    try {
      normalizeWorkspaces(['relative/dir'])
      return false
    } catch (error) {
      return error instanceof TypeError
    }
  })())
  check('a duplicate path is refused', (() => {
    try {
      normalizeWorkspaces(['/tmp', { name: 'again', path: '/tmp' }])
      return false
    } catch (error) {
      return error instanceof TypeError && error.message.includes('twice')
    }
  })())
  check('an empty entry is refused', (() => {
    try {
      normalizeWorkspaces([{ name: 'x' }])
      return false
    } catch {
      return true
    }
  })())

  // ── configuration resolution ─────────────────────────────────────────────
  // The regression this guards: `apply()` used to read `config.nodeId.trim()`
  // directly, so a Loader that handed it an unvalidated object made the plugin
  // throw during its own setup — silently, before it could log anything.
  {
    const { DEFAULT_CONFIG, resolveConfig } = await import('../lib/config.js')
    const threw = (raw) => {
      try {
        resolveConfig(raw)
        return undefined
      } catch (error) {
        return error
      }
    }
    check('a missing relayUrl is refused by name', String(threw({ nodeToken: 't' })?.message).includes('relayUrl'))
    check('a missing nodeToken is refused by name', String(threw({ relayUrl: 'http://h' })?.message).includes('nodeToken'))
    check('a blank relayUrl is refused, not accepted as a value', threw({ relayUrl: '   ', nodeToken: 't' }) !== undefined)
    check('an undefined config object is refused rather than crashing', threw(undefined) !== undefined)

    const resolved = resolveConfig({ relayUrl: 'http://h', nodeToken: 't' })
    check('an absent nodeId resolves to empty, to be derived later', resolved.nodeId === '')
    check('an absent displayName resolves to empty, to be derived later', resolved.displayName === '')
    check('an absent agentPreset resolves to standard', resolved.agentPreset === DEFAULT_CONFIG.agentPreset)
    check(
      'an absent permissionPreset resolves to workspace-write',
      resolved.permissionPreset === 'workspace-write'
    )
    check('an absent workspaces list resolves to empty', resolved.workspaces.length === 0)
    check('an absent enabled resolves to true', resolved.enabled === true)
    check('an explicit enabled: false is honoured', resolveConfig({ relayUrl: 'http://h', nodeToken: 't', enabled: false }).enabled === false)
    check('values are trimmed', resolveConfig({ relayUrl: 'http://h', nodeToken: 't', nodeId: '  mac  ' }).nodeId === 'mac')
    check(
      'an unusable reconnect delay falls back instead of producing a busy loop',
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', reconnectMinMs: 0 }).reconnectMinMs === DEFAULT_CONFIG.reconnectMinMs
    )
    check(
      'a non-list workspaces value falls back instead of throwing later',
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', workspaces: 'nope' }).workspaces.length === 0
    )
  }

  // ── the client against the fake relay ────────────────────────────────────
  const client = new RelayClient({ relayUrl: `${base}/harness/`, nodeToken: 'node-secret' })
  responder = () => ({ status: 200, body: { nodeId: 'n1', pollHoldMs: 1500 } })
  const ack = await client.hello({ nodeId: 'n1', name: 'Box', workspaces: [{ name: 'w', path: '/tmp' }] })
  check('hello carries the hold window back', ack.pollHoldMs === 1500)
  const hello = seen.at(-1)
  check('hello strips the trailing slash from the base URL', hello.path === '/harness/api/agent/hello', hello.path)
  check('hello presents the bearer token', hello.auth === 'Bearer node-secret')
  check('hello posts the identity verbatim', hello.body?.nodeId === 'n1' && hello.body?.workspaces?.[0]?.path === '/tmp')

  responder = () => ({ status: 200, body: { command: { commandId: 'c1', prompt: 'hi', workspace: '/tmp' } } })
  const command = await client.poll({ nodeId: 'n1', idle: true }, 1500)
  check('poll returns the command', command?.commandId === 'c1', JSON.stringify(command))
  check('poll reports idleness so the roster can settle', seen.at(-1).body?.idle === true)

  responder = () => ({ status: 200, body: { command: null } })
  check('poll maps "no work" to null', (await client.poll({ nodeId: 'n1' }, 1500)) === null)

  responder = () => ({ status: 200, body: { ok: true } })
  await client.report({ nodeId: 'n1', status: 'busy', detail: 'x' })
  check('report posts the status', seen.at(-1).body?.status === 'busy')

  responder = () => ({ status: 401, body: { error: 'unauthorized' } })
  await rejects('a 401 is classified as an auth failure', () => client.hello({ nodeId: 'n1' }), RelayAuthError)

  responder = () => ({ status: 500, body: { error: 'boom' } })
  await rejects('a 500 is classified as retryable', () => client.hello({ nodeId: 'n1' }), RelayUnreachableError)

  responder = () => ({ status: 200, body: 'not json at all' })
  const unreadable = await rejects('an unreadable body is retryable', () => client.hello({ nodeId: 'n1' }), RelayUnreachableError)
  check('the unreadable-body error names the cause', String(unreadable?.message).includes('unreadable'), unreadable?.message)

  // `reportQuietly` is the shutdown path: it must swallow, not propagate.
  responder = () => ({ status: 500, body: {} })
  let quietThrew = false
  try {
    await client.reportQuietly({ nodeId: 'n1' })
  } catch {
    quietThrew = true
  }
  check('reportQuietly never throws', !quietThrew)

  // An unreachable host must be a RelayUnreachableError, not a raw fetch error.
  const dead = new RelayClient({ relayUrl: 'http://127.0.0.1:1/', nodeToken: 'x' })
  await rejects('a refused connection is classified as unreachable', () => dead.hello({ nodeId: 'n1' }), RelayUnreachableError)

  // ── the harness-package resolver ─────────────────────────────────────────
  // The runner resolves `@deepseek-ai/*` out of the profile, because a plugin
  // loaded by absolute path cannot see them through Node's own lookup. With no
  // profile present the failure must name the package rather than surface a
  // bare MODULE_NOT_FOUND.
  const { summarizeTurn, turnFailure } = await import('../lib/runner.js')
  const fakeSession = {
    seq: 3,
    eventAt: (seq) =>
      [
        { type: 'turn/start' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'first' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      ][seq]
  }
  const summary = summarizeTurn(fakeSession, 0, (value) => value)
  check('summarizeTurn reads the committed assistant text', summary.text === 'first', JSON.stringify(summary))
  check('summarizeTurn reports a completed turn', turnFailure(summary.reason) === undefined)
  check(
    'summarizeTurn keeps the last non-empty assistant message',
    summarizeTurn(
      {
        seq: 3,
        eventAt: (seq) =>
          [
            { type: 'turn/start' },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'step' }] } } },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'final' }] } } }
          ][seq]
      },
      0,
      (value) => value
    ).text === 'final'
  )
  check(
    'an empty assistant message does not erase earlier text',
    summarizeTurn(
      {
        seq: 3,
        eventAt: (seq) =>
          [
            { type: 'turn/start' },
            { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'kept' }] } } },
            { type: 'assistant/message', data: { message: { content: [] } } }
          ][seq]
      },
      0,
      (value) => value
    ).text === 'kept'
  )
  check('events before turn/start are ignored', summarizeTurn(
    {
      seq: 2,
      eventAt: (seq) =>
        [
          { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'stale' }] } } },
          { type: 'turn/start' }
        ][seq]
    },
    0,
    (value) => value
  ).text === '')
  check(
    'an error turn becomes a code-and-message line',
    turnFailure({ kind: 'error', error: { code: 'NO_ADAPTER', message: 'no adapter' } }) === 'NO_ADAPTER: no adapter'
  )
  check('a missing outcome is reported, not ignored', String(turnFailure(undefined)).includes('without recording'))
  check('a cancelled turn is named', String(turnFailure({ kind: 'cancelled' })).includes('cancelled'))

  process.stdout.write(`\nnode-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nnode-check: harness error — ${error?.stack ?? error}\n`)
} finally {
  relay.close()
  relay.closeAllConnections?.()
}

if (failures > 0) process.exitCode = 1
