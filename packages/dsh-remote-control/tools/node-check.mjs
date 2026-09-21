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
import { RemoteRunner, callerOf, normalizeWorkspaces } from '../lib/runner.js'

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

/**
 * Wait, for the checks that have to watch a real timer.
 *
 * @param {number} ms - how long to wait.
 * @returns {Promise<void>} resolves after the wait.
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Recorded requests from the fake relay. */
const seen = []
let responder = () => ({ status: 200, body: {} })
/** Extra time this fake relay holds a response, to stand in for a long-poll. */
let responseDelayMs = 0

const relay = createServer((req, res) => {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', async () => {
    const raw = Buffer.concat(chunks).toString('utf8')
    let body
    try {
      body = raw === '' ? undefined : JSON.parse(raw)
    } catch {
      body = raw
    }
    seen.push({ path: req.url, method: req.method, auth: req.headers.authorization, body })
    // The real relay holds `/api/agent/ask` open until a person answers; without a
    // delay here the fake answers in a millisecond and a cancellation test would
    // race its own abort.
    if (responseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, responseDelayMs))
    const { status, body: responseBody } = responder(req.url, body)
    if (res.writableEnded) return
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
      'an absent question timeout falls back to the documented wait',
      resolved.questionTimeoutMs === DEFAULT_CONFIG.questionTimeoutMs,
      String(resolved.questionTimeoutMs)
    )
    check(
      'a zero question timeout falls back rather than giving up instantly',
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', questionTimeoutMs: 0 }).questionTimeoutMs === DEFAULT_CONFIG.questionTimeoutMs
    )
    check(
      'an explicit question timeout is honoured',
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', questionTimeoutMs: 12_345 }).questionTimeoutMs === 12_345
    )
    check(
      'a non-list workspaces value falls back instead of throwing later',
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', workspaces: 'nope' }).workspaces.length === 0
    )
  }

  // ── registry mode ────────────────────────────────────────────────────────
  {
    const { resolveConfig, REGISTRY_WORKSPACES } = await import('../lib/config.js')
    const base = { relayUrl: 'https://relay.example/harness', nodeToken: 't' }
    const reg = resolveConfig({ ...base, workspaces: REGISTRY_WORKSPACES })
    check('the registry sentinel is recognised', reg.registryMode === true)
    check('registry mode carries no configured list', Array.isArray(reg.workspaces) && reg.workspaces.length === 0)
    check(
      'the sentinel is accepted case-insensitively and trimmed',
      resolveConfig({ ...base, workspaces: '  Registry ' }).registryMode === true
    )
    check('a list stays a list', resolveConfig({ ...base, workspaces: ['/tmp'] }).registryMode === false)
    check(
      'an absent workspaces value is not registry mode',
      resolveConfig(base).registryMode === false && resolveConfig(base).workspaces.length === 0
    )
    check(
      'an unrelated string is not a sentinel, and does not silently become one',
      resolveConfig({ ...base, workspaces: 'nonsense' }).registryMode === false
    )
  }

  // ── the guest door's configuration ───────────────────────────────────────
  // The guest keys are security-relevant switches, so their *defaults* are
  // asserted rather than assumed: a door that opens because a field was merely
  // present is the failure this block exists to catch.
  {
    const { resolveConfig } = await import('../lib/config.js')
    const base = { relayUrl: 'http://h', nodeToken: 't' }
    const off = resolveConfig(base)
    check('the guest door is closed by default', off.guest.enabled === false)
    check('the guest agent defaults to the bundled read-only one', off.guest.agentPreset === 'reader', off.guest.agentPreset)
    check('the guest permission defaults to read-only', off.guest.permissionPreset === 'read-only', off.guest.permissionPreset)
    check('the guest prompt cap has a default', off.guest.maxPromptChars === 8_000, String(off.guest.maxPromptChars))
    check('a closed door carries no guest workspaces', off.guest.workspaces.length === 0)
    check('the bundled presets are installed by default', off.installBundledPresets === true)
    check('an explicit opt-out is honoured', resolveConfig({ ...base, installBundledPresets: false }).installBundledPresets === false)

    const open = resolveConfig({
      ...base,
      guestEnabled: true,
      guestWorkspaces: ['/tmp/demo'],
      guestAgentPreset: 'reader',
      guestPermissionPreset: 'read-only',
      guestMaxPromptChars: 500
    })
    check('an explicit boolean true opens the door', open.guest.enabled === true)
    check('the guest list is carried through for normalization', open.guest.workspaces.length === 1 && open.guest.workspaces[0] === '/tmp/demo')
    check('the guest prompt cap is honoured', open.guest.maxPromptChars === 500)

    // The asymmetry with `enabled` is deliberate and worth pinning: this switch
    // publishes an unauthenticated page, so only a real boolean opens it.
    check(
      'the string "true" does not open the door',
      resolveConfig({ ...base, guestEnabled: 'true' }).guest.enabled === false
    )
    check('a truthy non-boolean does not open the door', resolveConfig({ ...base, guestEnabled: 1 }).guest.enabled === false)
    check(
      'a non-list guest workspace value falls back to none',
      resolveConfig({ ...base, guestEnabled: true, guestWorkspaces: '/tmp' }).guest.workspaces.length === 0
    )
  }

  // ── the guest scope is checked against the owner list ────────────────────
  // The subset rule is the security property behind "guests can only reach what
  // the operator already granted", and it is checkable without a Harness: it is a
  // pure function of the resolved config plus the normalized owner list. A mistake
  // closes the door rather than stopping the node — the operator's own remote
  // control must not go down because of a key about guests.
  {
    const { prepareGuest } = await import('../lib/index.js')
    const { resolveConfig } = await import('../lib/config.js')
    const owner = [
      { name: 'proj', path: '/workspace/proj' },
      { name: 'demo', path: '/workspace/demo' }
    ]
    const resolvedFor = (guest) => resolveConfig({ relayUrl: 'http://h', nodeToken: 't', ...guest })

    const off = prepareGuest(resolvedFor({}), owner)
    check('a closed door needs no problem reported', off.problem === undefined && off.guest.enabled === false)

    const good = prepareGuest(
      resolvedFor({ guestEnabled: true, guestWorkspaces: [{ name: 'demo', path: '/workspace/demo' }] }),
      owner
    )
    check('a guest list inside the owner list is accepted', good.problem === undefined && good.guest.enabled === true, JSON.stringify(good))
    check('and it is normalized like the owner list is', good.guest.workspaces[0]?.path === '/workspace/demo', JSON.stringify(good.guest.workspaces))
    const expanded = prepareGuest(resolvedFor({ guestEnabled: true, guestWorkspaces: ['~/demo'] }), [{ name: 'd', path: homedir() + '/demo' }])
    check(
      'a ~ path is expanded before the subset check',
      expanded.problem === undefined && expanded.guest.workspaces[0].path === join(homedir(), 'demo'),
      JSON.stringify(expanded)
    )

    const outside = prepareGuest(
      resolvedFor({ guestEnabled: true, guestWorkspaces: [{ name: 'elsewhere', path: '/workspace/elsewhere' }] }),
      owner
    )
    check('a guest directory the operator does not offer closes the door', outside.guest.enabled === false, JSON.stringify(outside))
    check('and says which directory was wrong', String(outside.problem).includes('/workspace/elsewhere'), String(outside.problem))
    check('and says the door stayed closed', String(outside.problem).includes('stays closed'), String(outside.problem))

    const empty = prepareGuest(resolvedFor({ guestEnabled: true }), owner)
    check('an open door with no directory closes rather than stopping the node', empty.guest.enabled === false, JSON.stringify(empty))
    check('and names the key that is missing', String(empty.problem).includes('guestWorkspaces'), String(empty.problem))

    const nonsense = prepareGuest(resolvedFor({ guestEnabled: true, guestWorkspaces: ['relative/dir'] }), owner)
    check('an unusable guest path closes the door with a reason', nonsense.guest.enabled === false && typeof nonsense.problem === 'string', JSON.stringify(nonsense))

    // Registry mode has no fixed owner list to compare against, so the explicit
    // guest directories are simply carried: the runtime intersection is what keeps
    // them inside the operator's live set.
    const registry = prepareGuest(
      resolveConfig({ relayUrl: 'http://h', nodeToken: 't', workspaces: 'registry', guestEnabled: true, guestWorkspaces: ['/workspace/anything'] }),
      []
    )
    check('registry mode carries the explicit guest list without a subset check', registry.problem === undefined && registry.guest.enabled === true, JSON.stringify(registry))
  }

  // ── who a relay command is from, and what each caller may do ─────────────
  // The runner is the half that has to refuse a guest turn even when the relay
  // asks for it, so the caller boundary is checked here as a pure function plus a
  // runner that never touches the Harness (only its workspace resolution does).
  {
    check('a command without a role is the operator’s', callerOf({}).role === 'owner', JSON.stringify(callerOf({})))
    check('an explicit owner role stays the operator’s', callerOf({ role: 'owner' }).role === 'owner')
    check('a guest role is carried with its principal', callerOf({ role: 'guest', principal: 'g-1' }).principal === 'g-1')
    check('a guest command with no principal resolves empty, to be refused', callerOf({ role: 'guest' }).principal === '')
    check('a blank principal is trimmed away', callerOf({ role: 'guest', principal: '   ' }).principal === '')
    check('an unknown role is treated as the operator’s', callerOf({ role: 'root' }).role === 'owner')

    const runnerFor = (guest) =>
      new RemoteRunner({
        ctx: {},
        config: {
          nodeId: 'n',
          workspaces: [
            { name: 'proj', path: '/workspace/proj' },
            { name: 'notes', path: '/workspace/notes' },
            { name: 'secret', path: '/workspace/secret' }
          ],
          agentPreset: 'standard',
          permissionPreset: 'workspace-write',
          guest
        },
        logger: {}
      })

    const closed = runnerFor({ enabled: false, workspaces: [{ name: 'proj', path: '/workspace/proj' }] })
    check('a closed node offers no guest workspaces', closed.guestWorkspaces().length === 0)
    check(
      'and refuses a guest turn even if one arrives',
      (await closed.run({ commandId: 'c', workspace: '/workspace/proj', prompt: 'hi', role: 'guest', principal: 'g' })).error ===
        'this node does not accept guest turns'
    )

    const openRunner = runnerFor({
      enabled: true,
      workspaces: [
        { name: 'proj', path: '/workspace/proj' },
        { name: 'gone', path: '/workspace/gone' }
      ],
      agentPreset: 'reader',
      permissionPreset: 'read-only',
      maxPromptChars: 10
    })
    check(
      'only guest workspaces the operator still offers are advertised',
      openRunner.guestWorkspaces().length === 1 && openRunner.guestWorkspaces()[0].path === '/workspace/proj',
      JSON.stringify(openRunner.guestWorkspaces())
    )
    check('a guest path resolves for a guest', openRunner.resolveWorkspace('/workspace/proj', 'guest') === '/workspace/proj')
    check(
      'an operator-only path does not resolve for a guest',
      (() => {
        try {
          openRunner.resolveWorkspace('/workspace/notes', 'guest')
          return false
        } catch (error) {
          // The refusal may name the path the guest asked for and the paths it was
          // offered — but never the operator's other directories, which would make
          // a rejected guess into a directory listing.
          return error.message.includes('not offered to guests') && !error.message.includes('/workspace/secret')
        }
      })()
    )
    check('the same path still resolves for the operator', openRunner.resolveWorkspace('/workspace/notes', 'owner') === '/workspace/notes')
    const guestPosture = openRunner.postureFor({ role: 'guest', principal: 'g-1' })
    check(
      'a guest posture carries the guest preset, permission and principal',
      guestPosture.agentPreset === 'reader' && guestPosture.permissionPreset === 'read-only' && guestPosture.principal === 'g-1',
      JSON.stringify(guestPosture)
    )
    const ownerPosture = openRunner.postureFor({ role: 'owner', principal: 'owner' })
    check(
      'an operator posture carries the configured preset and permission',
      ownerPosture.agentPreset === 'standard' && ownerPosture.permissionPreset === 'workspace-write',
      JSON.stringify(ownerPosture)
    )
    const tooLong = await openRunner.run({
      commandId: 'c2',
      workspace: '/workspace/proj',
      prompt: 'x'.repeat(11),
      role: 'guest',
      principal: 'g-1'
    })
    check('an over-long guest question is refused by the node too', String(tooLong.error).includes('longer than'), JSON.stringify(tooLong))
    const noPrincipal = await openRunner.run({
      commandId: 'c3',
      workspace: '/workspace/proj',
      prompt: 'hi',
      role: 'guest'
    })
    check('a guest turn without a principal is refused', String(noPrincipal.error).includes('visitor'), JSON.stringify(noPrincipal))
  }

  // ── the busy heartbeat ───────────────────────────────────────────────────
  // A turn blocks the poll loop, and the relay reads silence as death, so a turn
  // longer than the liveness window showed the machine as 离线 and made the relay
  // refuse new questions. These are the two halves that matter: the interval is
  // derived from what the relay said its window is, and a beat can never affect
  // the turn it is covering.
  {
    const { DEFAULT_HEARTBEAT_MS, heartbeatMsFor, startBusyHeartbeat } = await import('../lib/heartbeat.js')

    check('an unknown window falls back to the documented interval', heartbeatMsFor(undefined) === DEFAULT_HEARTBEAT_MS, String(heartbeatMsFor(undefined)))
    check('a nonsense window falls back too', heartbeatMsFor(0) === DEFAULT_HEARTBEAT_MS && heartbeatMsFor('45s') === DEFAULT_HEARTBEAT_MS)
    check('the interval is a third of the relay’s window', heartbeatMsFor(45_000) === 15_000, String(heartbeatMsFor(45_000)))
    check('a tight window gets a proportional beat', heartbeatMsFor(9_000) === 3_000, String(heartbeatMsFor(9_000)))
    check('an aggressive window is clamped so it cannot flood the relay', heartbeatMsFor(300) === 1_000, String(heartbeatMsFor(300)))
    check('a very wide window is clamped to the ceiling', heartbeatMsFor(3_600_000) === DEFAULT_HEARTBEAT_MS, String(heartbeatMsFor(3_600_000)))

    // Real timers, small interval: beats arrive, stop() is final, and a rejecting
    // report is swallowed rather than becoming an unhandled rejection.
    let beats = 0
    const stop = startBusyHeartbeat({ intervalMs: 20, report: () => { beats += 1 } })
    await sleep(120)
    stop()
    const afterStop = beats
    check('a running turn gets its heartbeats', afterStop >= 2, `${String(afterStop)} beats in 120ms`)
    await sleep(80)
    check('stopping the heartbeat ends it', beats === afterStop, `${String(beats)} vs ${String(afterStop)}`)

    let rejections = 0
    const stopRejecting = startBusyHeartbeat({
      intervalMs: 20,
      report: () => {
        rejections += 1
        return Promise.reject(new Error('relay is down'))
      }
    })
    await sleep(120)
    stopRejecting()
    check('a failing heartbeat is swallowed, never thrown at the turn', rejections >= 2, `${String(rejections)} attempts`)

    let slowCalls = 0
    const stopSlow = startBusyHeartbeat({
      intervalMs: 10,
      // A heartbeat that never settles must not queue up work either: the timer
      // fires again regardless, because the beat is not awaited.
      report: () => {
        slowCalls += 1
        return new Promise(() => {})
      }
    })
    await sleep(80)
    stopSlow()
    check('a heartbeat that hangs does not stall the timer', slowCalls >= 2, `${String(slowCalls)} attempts`)

    check('a nonsense interval starts nothing at all', (() => {
      let called = 0
      const noop = startBusyHeartbeat({ intervalMs: 0, report: () => { called += 1 } })
      noop()
      return called === 0
    })())
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

  // ── minting an invite code ───────────────────────────────────────────────
  // The settings card's button goes through this call, so the two things worth
  // pinning are the wire shape (the relay's agent route, with the node's token) and
  // that a refusal reaches the caller with the relay's own words rather than as a
  // bare status code.
  {
    responder = () => ({ status: 200, body: { code: 'K7M4-2QXP', nodeId: 'n1', expiresAt: 1, ttlMs: 900_000 } })
    const invite = await client.createInvite('n1')
    check('createInvite returns the code', invite?.code === 'K7M4-2QXP', JSON.stringify(invite))
    const call1 = seen.at(-1)
    check('createInvite posts to the relay invite route', call1.path === '/harness/api/agent/invite', call1.path)
    check('createInvite presents the node token', call1.auth === 'Bearer node-secret')
    check('createInvite names the machine the invite is for', call1.body?.nodeId === 'n1', JSON.stringify(call1.body))

    responder = () => ({ status: 409, body: { error: 'node n1 has no guest door open' } })
    const refused = await rejects('a refused invite is retryable-but-reported', () => client.createInvite('n1'), RelayUnreachableError)
    check(
      'the relay’s own explanation survives into the error',
      String(refused?.message).includes('no guest door open'),
      String(refused?.message)
    )

    responder = () => ({ status: 401, body: { error: 'unauthorized' } })
    await rejects('a rejected token is an auth failure, not a retry', () => client.createInvite('n1'), RelayAuthError)
  }


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

  // ── the question long-poll ───────────────────────────────────────────────
  // `ask` is the blocking half of the interaction protocol, so the two things it
  // has to get right are the wire shape and the timeout arithmetic: the node's
  // own wait must expire before the relay's, or the fallback to the local GUI
  // would be reported as a dead relay instead.
  responder = () => ({ status: 200, body: { questionId: 'q1', answers: [{ id: 'scope', selected: [] }] } })
  const asked = await client.ask({ nodeId: 'n1', questions: [{ id: 'scope', question: 'which part?' }] }, { timeoutMs: 200 })
  check('ask returns the page answer', asked?.answers?.[0]?.id === 'scope', JSON.stringify(asked))
  const askCall = seen.at(-1)
  check('ask posts to the question route', askCall.path === '/harness/api/agent/ask', askCall.path)
  check('ask sends the questions verbatim', askCall.body?.questions?.[0]?.id === 'scope', JSON.stringify(askCall.body))

  responder = () => ({ status: 200, body: { questionId: 'q1', settled: true, reason: 'timeout' } })
  const settled = await client.ask({ nodeId: 'n1', questions: [{ id: 'scope', question: 'which part?' }] })
  check('a settled ask is returned without answers so the node can fall back', settled?.settled === true && settled.answers === undefined)

  await client.settleQuestion({ nodeId: 'n1', questionId: 'q1' })
  check('settleQuestion posts to the settled route', seen.at(-1).path === '/harness/api/agent/question/settled', seen.at(-1).path)
  check('settleQuestion names the question', seen.at(-1).body?.questionId === 'q1')

  // A cancelled turn is not an unreachable relay: the bridge has to be able to
  // tell them apart to know whether falling back is appropriate.
  responder = () => ({ status: 200, body: { questionId: 'q1', answers: [] } })
  responseDelayMs = 400
  const aborted = new AbortController()
  const cancelled = client.ask({ nodeId: 'n1', questions: [{ id: 'scope', question: 'x' }] }, { signal: aborted.signal })
  setTimeout(() => aborted.abort(new Error('turn cancelled')), 40)
  let cancelError
  try {
    await cancelled
  } catch (error) {
    cancelError = error
  }
  responseDelayMs = 0
  check('a cancelled ask rejects instead of resolving', cancelError !== undefined)
  check(
    'a cancellation is not reported as an unreachable relay',
    cancelError?.name !== 'RelayUnreachableError',
    `got ${cancelError?.name}: ${cancelError?.message}`
  )
  check('the cancellation keeps its own reason', cancelError?.message === 'turn cancelled', cancelError?.message)

  responder = () => ({ status: 401, body: { error: 'unauthorized' } })
  await rejects('ask classifies a rejected token as an auth failure', () => client.ask({ nodeId: 'n1', questions: [] }), RelayAuthError)

  // ── the question bridge: who may answer for whom ─────────────────────────
  // The bridge is what routes a remote session's question to the page, and the
  // ownership test is the safety property that keeps a local user's question on
  // the local GUI. Getting it wrong in either direction is bad: too narrow and
  // the page never sees the question, too wide and every question in the Harness
  // is shipped to a public web page.
  const { RemoteQuestionBridge } = await import('../lib/questions.js')
  const calls = []
  const fakeClient = {
    ask: async (body, options) => {
      calls.push({ path: 'ask', body, options })
      return { questionId: 'q1', answers: [{ id: 'scope', selected: ['全部'] }] }
    },
    settleQuestion: async (body) => {
      calls.push({ path: 'settle', body })
      return { ok: true }
    }
  }
  const warnings = []
  const bridge = new RemoteQuestionBridge({
    client: fakeClient,
    nodeId: 'n1',
    logger: { info: () => {}, warn: (line) => warnings.push(line) },
    timeoutMs: 300_000
  })
  bridge.track('remote-1')
  check('a tracked session is owned', bridge.owns({ session: { id: 'remote-1' } }) === true)
  check('an untracked session is not owned', bridge.owns({ session: { id: 'remote-2' } }) === false)
  check('an agent with no readable identity is not owned', bridge.owns({}) === false)
  bridge.release('remote-1')
  check('a released session stops being owned', bridge.owns({ session: { id: 'remote-1' } }) === false)

  bridge.track('remote-1')
  const answered = await bridge.answer({
    questions: [{ id: 'scope', question: 'range?', options: [{ label: '全部' }, { label: '仅改动' }] }],
    agent: { session: { id: 'remote-1' } }
  })
  check('an owned question is answered from the relay', answered?.answers?.[0]?.selected?.[0] === '全部', JSON.stringify(answered))
  check('the bridge forwarded the questions verbatim', calls.at(-1)?.body?.questions?.[0]?.id === 'scope')
  check('the bridge forwarded its own timeout', calls.at(-1)?.options?.timeoutMs === 300_000)

  // A request with nothing askable is not forwarded; delegating is what keeps the
  // local GUI's behaviour for it.
  const nothing = await bridge.answer({ questions: [], agent: { session: { id: 'remote-1' } } })
  check('a question list with nothing askable is delegated, not relayed', nothing === undefined)

  // An answer the node cannot admit must fall back rather than reach the model.
  fakeClient.ask = async () => ({ questionId: 'q2', answers: [{ id: 'scope', selected: ['invented'] }] })
  const inadmissible = await bridge.answer({
    questions: [{ id: 'scope', question: 'range?', options: [{ label: '全部' }] }],
    agent: { session: { id: 'remote-1' } }
  })
  check('an answer naming an option the model never offered is refused', inadmissible === undefined)
  check('the refusal is reported rather than silent', warnings.some((line) => line.includes('inadmissible')), warnings.join(' | '))

  // A dead relay is the ordinary case for a laptop on a train: it must fall back
  // on the first attempt, not hold the question for the full window.
  fakeClient.ask = async (body, options) => {
    throw new Error('relay is down')
  }
  const unreachable = await bridge.answer({
    questions: [{ id: 'scope', question: 'range?' }],
    agent: { session: { id: 'remote-1' } }
  })
  check('an unreachable relay delegates instead of hanging the turn', unreachable === undefined)
  check('the relay failure is reported', warnings.some((line) => line.includes('relaying the question failed')), warnings.join(' | '))
  bridge.client = undefined
  const stopped = await bridge.answer({ questions: [{ id: 's', question: 'q' }] })
  check('a stopped node relays nothing', stopped === undefined)

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
  // A session this node shares with the local GUI can hold the person's own turn
  // in the same window, and the relay page asks one question at a time. Reporting
  // their turn as the remote reply is a wrong answer with no visible symptom, so
  // the walk stops at the end of the turn it started reading.
  check(
    'a later turn in the same window is not reported as the reply',
    (() => {
      const summary = summarizeTurn(
        {
          seq: 6,
          eventAt: (seq) =>
            [
              { type: 'turn/start' },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'ours' }] } } },
              { type: 'turn/end', data: { reason: { kind: 'completed' } } },
              { type: 'turn/start' },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'somebody else' }] } } },
              { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'X', message: 'y' } } } }
            ][seq]
        },
        0,
        (value) => value
      )
      return summary.text === 'ours' && turnFailure(summary.reason) === undefined
    })()
  )
  // The ordering that a real Harness produces for a *freshly created* session, taken
  // from an actual session log: `turn/start` (seq 6) comes before the admitted
  // prompt (seq 10), the answer (19) and the `turn/end` (21). `firstSeq` is inside
  // that turn, because `ask()` captures it after `whenIdle()` returns while turn 1
  // is already running. Requiring a `turn/start` after the prompt made this the one
  // case that failed: the answer was in the log and the plugin reported "the turn
  // ended without recording an outcome" instead of showing it.
  check(
    'a turn that opens before the admitted prompt still yields its answer',
    (() => {
      const events = [
        { type: 'permission/preset' },
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start' },
        { type: 'user/message', data: { id: 'ours' } },
        { type: 'request/header' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'the answer' }] } } },
        { type: 'step/end' },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      ]
      const summary = summarizeTurn({ seq: events.length, eventAt: (seq) => events[seq] }, 3, (value) => value, 'ours')
      return summary.text === 'the answer' && turnFailure(summary.reason) === undefined
    })()
  )
  check(
    'a second turn in the window is still not ours, even with the prompt located',
    (() => {
      const events = [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'user/message', data: { id: 'ours' } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'our answer' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'turn/start', data: { turn: 2 } },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'somebody else' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'error', error: { code: 'X', message: 'y' } } } }
      ]
      const summary = summarizeTurn({ seq: events.length, eventAt: (seq) => events[seq] }, 1, (value) => value, 'ours')
      return summary.text === 'our answer' && turnFailure(summary.reason) === undefined
    })()
  )
  check(
    'the reply is attributed to the admitted prompt, not to the first turn in the window',
    (() => {
      const events = [
        { type: 'user/message', data: { id: 'theirs' } },
        { type: 'turn/start' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'their answer' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } },
        { type: 'user/message', data: { id: 'ours' } },
        { type: 'turn/start' },
        { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'our answer' }] } } },
        { type: 'turn/end', data: { reason: { kind: 'completed' } } }
      ]
      const summary = summarizeTurn({ seq: events.length, eventAt: (seq) => events[seq] }, 0, (value) => value, 'ours')
      return summary.text === 'our answer'
    })()
  )
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
