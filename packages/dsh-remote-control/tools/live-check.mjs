#!/usr/bin/env node
/**
 * `live-check` — load the node plugin in a real Harness boot.
 *
 * The three unit checks drive the plugin's own code, but none of them prove the
 * plugin can be *installed*: that the row loads, that the loader validates the
 * config, that `ctx.inject` actually fires, and that the node then reaches a
 * relay. That last gap is what this file closes, and it is not a hypothetical —
 * the first version of this plugin passed all three unit checks while never
 * running at all, because `apply()` threw on an undefined config field inside
 * its own setup, where nothing could report it.
 *
 * It runs against a throwaway `DSH_HOME` and a throwaway relay, and it never
 * touches the running backend or `~/.dsh`.
 *
 * @module dsh-remote-control/tools/live-check
 */

import { spawnGuarded, stopGuarded, trackedCount } from './spawn-guard.mjs'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNTIME_NODE_MODULES = join(
  homedir(),
  'Library',
  'Application Support',
  'DeepSeekHarness',
  'runtime',
  'node_modules'
)

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
 * Locate the `dsh` launcher.
 *
 * @returns {string} absolute path to the launcher.
 * @throws {Error} when no launcher is present.
 */
function findDsh() {
  const candidates = [
    process.env.DSH_BIN,
    join(RUNTIME_NODE_MODULES, '.bin', 'dsh'),
    join(PACKAGE_ROOT, 'node_modules', '.bin', 'dsh')
  ].filter((entry) => typeof entry === 'string' && entry !== '')
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  throw new Error('no dsh launcher found; set DSH_BIN to the launcher path')
}

/** A tiny stand-in relay that records what the node sends. */
const relayState = { seen: [], holding: null, holdMs: 1_500 }

/**
 * @param {import('node:http').IncomingMessage} req - request.
 * @param {import('node:http').ServerResponse} res - response.
 */
function handleRelay(req, res) {
  const chunks = []
  req.on('data', (chunk) => chunks.push(chunk))
  req.on('end', () => {
    let body = {}
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      body = null
    }
    relayState.seen.push({ path: req.url, auth: req.headers.authorization, body })
    if (req.url === '/relay/api/agent/poll') {
      // Park, the way the real relay does, so the check observes the node
      // waiting rather than spinning.
      relayState.holding = res
      return
    }
    let answer = { ok: true }
    if (req.url === '/relay/api/agent/hello') answer = { nodeId: body?.nodeId, pollHoldMs: relayState.holdMs, offlineAfterMs: 45_000 }
    // The invite route has to answer with a code, or the card's button would have
    // nothing to show and this check would be proving an empty object.
    if (req.url === '/relay/api/agent/invite') answer = { code: 'LIVE-CHECK-CODE', nodeId: body?.nodeId, expiresAt: Date.now() + 900_000, ttlMs: 900_000 }
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(answer))
  })
}

const workdir = await mkdtemp(join(tmpdir(), 'dsh-remote-live-check-'))
const dshHome = join(workdir, 'home')
const profileDir = join(dshHome, 'profiles', 'web')
const keep = process.env.DSH_REMOTE_CONTROL_CHECK_KEEP === '1'
let relay
let backend

// This check is the one that needs a real Harness *launcher*, so it reports a
// skip where there is none instead of failing. The distinction matters: a missing
// launcher is an environment fact, not a defect in this package, and a check that
// cannot tell those apart trains people to ignore red output.
{
  let launcher
  try {
    launcher = findDsh()
  } catch {
    launcher = undefined
  }
  if (launcher === undefined) {
    process.stdout.write('live-check\n')
    process.stdout.write('  \u25CB no dsh launcher found; skipping.\n')
    process.stdout.write('     Set DSH_BIN to the launcher, or install @deepseek-ai/dsh, then run `npm run test:harness`.\n')
    process.stdout.write('live-check: skipped\n')
    await rm(workdir, { recursive: true, force: true })
    process.exit(0)
  }
}

try {
  process.stdout.write('live-check\n')

  // ── an isolated profile, installed the way a user would install it ───────
  const dsh = findDsh()
  check('a dsh launcher was found', existsSync(dsh), dsh)

  await mkdir(workdir, { recursive: true })
  const init = spawnGuarded(dsh, ['--profile', 'web', '--dump-default-config'], {
    cwd: workdir,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let initErr = ''
  init.stderr.setEncoding('utf8')
  init.stderr.on('data', (chunk) => {
    initErr += chunk
  })
  const initCode = await new Promise((resolve) => init.once('exit', resolve))
  check('an isolated web profile initializes', initCode === 0, initErr.slice(0, 400))

  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(PACKAGE_ROOT, join(profileDir, 'node_modules', 'dsh-remote-control'), 'dir')
  // The client half too: the bundle patch declares its row, and a profile that
  // cannot resolve it fails the whole tree with ERR_MODULE_NOT_FOUND — which is
  // exactly what happened when the card was added and this check still installed
  // only the host package.
  await symlink(join(PACKAGE_ROOT, 'client'), join(profileDir, 'node_modules', 'dsh-remote-control-client'), 'dir')
  await symlink(join(RUNTIME_NODE_MODULES, '@deepseek-ai'), join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')

  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['dsh-remote-control'] = `link:${PACKAGE_ROOT}`
  manifest.dsh.profile.bundles.push('dsh-remote-control')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  // ── start the stand-in relay ─────────────────────────────────────────────
  const { createServer } = await import('node:http')
  relay = createServer((req, res) => handleRelay(req, res))
  await new Promise((resolve) => relay.listen(0, '127.0.0.1', resolve))
  const relayPort = relay.address().port
  const relayUrl = `http://127.0.0.1:${String(relayPort)}/relay`

  // The guest door is switched on here on purpose: it is the configuration that
  // makes the plugin install its bundled agent preset and resolve two preset names
  // against the real Harness, and both of those are invisible in a config where
  // the door is shut. The guest directory is a sub-directory of the operator's, so
  // the two lists differ and the role boundary can be exercised.
  const guestArea = join(workdir, 'guest-area')
  await mkdir(guestArea, { recursive: true })
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `# Written by tools/live-check.mjs in a throwaway DSH_HOME.\n- id: remote-control\n  config:\n` +
      `    relayUrl: '${relayUrl}'\n` +
      `    nodeToken: 'live-check-node-token'\n` +
      `    displayName: 'live-check node'\n` +
      `    workspaces:\n` +
      `      - { name: livecheck, path: ${JSON.stringify(workdir)} }\n` +
      `      - { name: guest-area, path: ${JSON.stringify(guestArea)} }\n` +
      `    guestEnabled: true\n` +
      `    guestWorkspaces:\n      - { name: guest-area, path: ${JSON.stringify(guestArea)} }\n`
  )

  // ── the composed tree must carry the row and its config ──────────────────
  const dump = spawnGuarded(dsh, ['--profile', 'web', '--dump-config'], {
    cwd: workdir,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let composed = ''
  dump.stdout.setEncoding('utf8')
  dump.stdout.on('data', (chunk) => {
    composed += chunk
  })
  await new Promise((resolve) => dump.once('exit', resolve))
  check('the bundle patch contributes the remote-control row', /id:\s*remote-control/.test(composed))
  check('the row resolves to this package', /name:\s*dsh-remote-control/.test(composed))

  // ── boot for real ────────────────────────────────────────────────────────
  backend = spawnGuarded(dsh, ['--profile', 'web', '--port', '0', '--no-open'], {
    cwd: workdir,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  backend.stdout.setEncoding('utf8')
  backend.stdout.on('data', (chunk) => {
    log += chunk
  })
  backend.stderr.setEncoding('utf8')
  backend.stderr.on('data', (chunk) => {
    log += chunk
  })

  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !log.includes('dsh-remote-control: node "')) {
    if (backend.exitCode !== null) break
    await sleep(250)
  }

  check(
    'the plugin announces itself in the backend log',
    log.includes('dsh-remote-control: node "'),
    log.split('\n').filter((line) => line.includes('dsh-remote-control')).slice(0, 4).join(' | ') || 'no plugin output at all'
  )
  check('the announcement names the relay', log.includes(relayUrl))
  check('the announcement reports the configured permission preset', log.includes('permission workspace-write'))
  check('the backend did not exit early', backend.exitCode === null, `exit ${String(backend.exitCode)}`)

  const hello = relayState.seen.find((entry) => entry.path === '/relay/api/agent/hello')
  check('the node reached the relay', hello !== undefined, JSON.stringify(relayState.seen.map((entry) => entry.path)))
  check('the node presented its bearer token', hello?.auth === 'Bearer live-check-node-token')
  check('the node advertised its display name', hello?.body?.name === 'live-check node')
  check(
    'the node advertised the configured workspace',
    Array.isArray(hello?.body?.workspaces) && hello.body.workspaces.some((entry) => entry.path === workdir),
    JSON.stringify(hello?.body?.workspaces)
  )
  check('the node advertised a platform string', typeof hello?.body?.platform === 'string' && hello.body.platform !== '')
  check('the node advertised a stable node id', /^node-[0-9a-f]{12}$/.test(String(hello?.body?.nodeId)), String(hello?.body?.nodeId))

  // ── the bundled agent preset, and the two names it needs ─────────────────
  // Guest mode's agent is not something DSH can fetch — the preset root takes a
  // path — so the plugin writes its own snapshot into the DSH home at load. Both
  // the file landing there and the name *resolving* are asserted, because they fail
  // differently: a missing file is an install bug, an unresolvable name is a
  // composition bug, and either one turns every guest turn into an opaque error on
  // a public page.
  const installedPreset = join(dshHome, '.agent-presets', 'reader')
  check(
    'the bundled agent preset is installed into the DSH home',
    existsSync(join(installedPreset, 'agent.cordis.yml')) && existsSync(join(installedPreset, 'preset.yml')),
    installedPreset
  )
  check('the installed preset carries the ownership stamp', existsSync(join(installedPreset, '.dsh-bundled-preset.json')))
  check('the installed preset keeps its read-only gate', existsSync(join(installedPreset, 'readonly-tools.mjs')))
  check(
    'the audit line says the preset was installed rather than already current',
    log.includes('agent preset "reader"'),
    log.split('\n').filter((line) => line.includes('agent preset')).join(' | ') || 'no preset line'
  )
  check(
    'the guest agent preset resolves in the real Harness',
    !log.includes('agent preset "reader" does not resolve'),
    log.split('\n').filter((line) => line.includes('guest agent preset')).join(' | ')
  )
  check(
    'the guest permission preset resolves in the real Harness',
    !log.includes('guest permission preset') || !log.includes('does not resolve'),
    log.split('\n').filter((line) => line.includes('guest permission preset')).join(' | ')
  )
  check(
    'the announcement states the door is open',
    /guest on \(1 workspace\(s\)/.test(log),
    log.split('\n').filter((line) => line.includes('workspace(s)')).join(' | ')
  )
  check(
    'the open door is called out as a warning',
    log.includes('guest mode: anyone who opens the relay') && log.includes(guestArea),
    log.split('\n').filter((line) => line.includes('guest mode')).join(' | ') || 'no guest-mode line'
  )

  const helloGuestBlock = hello?.body?.guest
  check('the node advertised the guest door to the relay', helloGuestBlock?.enabled === true, JSON.stringify(helloGuestBlock))
  check(
    'the advertised guest list is the guest one, not the operator one',
    Array.isArray(helloGuestBlock?.workspaces) &&
      helloGuestBlock.workspaces.length === 1 &&
      helloGuestBlock.workspaces[0].path === guestArea,
    JSON.stringify(helloGuestBlock?.workspaces)
  )
  check('the advertisement names the guest presets', helloGuestBlock?.agentPreset === 'reader' && helloGuestBlock?.permissionPreset === 'read-only', JSON.stringify(helloGuestBlock))

  const polled = relayState.seen.find((entry) => entry.path === '/relay/api/agent/poll')
  check('the node parked a long-poll for work', polled !== undefined)
  check('the poll reports the node idle', polled?.body?.idle === true)

  // ── releasing the long-poll with a command must run a real turn ──────────
  // A real turn needs a model adapter and credentials, which a throwaway home
  // does not have. So the command carries a workspace the node never advertised:
  // the node must refuse it *before* touching the Harness, and the refusal must
  // come back through the relay. That exercises the whole loop — delivery,
  // runner entry, report — without pretending to answer with a model.
  if (relayState.holding !== null) {
    const held = relayState.holding
    relayState.holding = null
    held.writeHead(200, { 'content-type': 'application/json' })
    held.end(
      JSON.stringify({
        command: {
          commandId: 'live-check-cmd-1',
          kind: 'question',
          workspace: '/definitely/not/advertised',
          prompt: 'this must be refused'
        }
      })
    )
  }
  const outcomeDeadline = Date.now() + 30_000
  let outcome
  while (Date.now() < outcomeDeadline) {
    outcome = relayState.seen.find((entry) => entry.path === '/relay/api/agent/report' && entry.body?.result !== undefined)
    if (outcome !== undefined) break
    await sleep(200)
  }
  check('the node reported the outcome back to the relay', outcome !== undefined)
  check('the runner refused the unadvertised workspace', outcome?.body?.result?.ok === false, JSON.stringify(outcome?.body?.result))
  check(
    'the refusal names the allow-list boundary',
    String(outcome?.body?.result?.error).includes('not advertised'),
    String(outcome?.body?.result?.error)
  )
  check('the node went busy before running', relayState.seen.some((entry) => entry.path === '/relay/api/agent/report' && entry.body?.status === 'busy'))
  check('the node returned to idle', outcome?.body?.status === 'idle')

  // ── a guest turn is refused at the role boundary, without a model ────────
  // The operator's own directory is advertised to the relay but was never opened
  // to visitors, so a guest command naming it must die on the role check. That
  // exercises delivery → runner entry → the caller boundary → report, through the
  // real plugin, with no model and no credentials involved.
  if (relayState.holding !== null) {
    const held = relayState.holding
    relayState.holding = null
    held.writeHead(200, { 'content-type': 'application/json' })
    held.end(
      JSON.stringify({
        command: {
          commandId: 'live-check-cmd-2',
          kind: 'question',
          workspace: workdir,
          prompt: 'the operator directory, as a visitor',
          role: 'guest',
          principal: 'guest-live-check'
        }
      })
    )
  }
  const guestDeadline = Date.now() + 30_000
  let guestOutcome
  while (Date.now() < guestDeadline) {
    guestOutcome = relayState.seen.find((entry) => entry.body?.result?.commandId === 'live-check-cmd-2')
    if (guestOutcome !== undefined) break
    await sleep(200)
  }
  check('a guest turn reaches the runner and is reported back', guestOutcome !== undefined)
  check('the guest turn is refused', guestOutcome?.body?.result?.ok === false, JSON.stringify(guestOutcome?.body?.result))
  check(
    'the refusal is the guest boundary, not a missing model',
    String(guestOutcome?.body?.result?.error).includes('not offered to guests'),
    String(guestOutcome?.body?.result?.error)
  )
  check(
    'the refusal does not leak the operator workspace list',
    !String(guestOutcome?.body?.result?.error).includes('not advertised by this node'),
    String(guestOutcome?.body?.result?.error)
  )
  check('the guest turn is reported as a guest turn', guestOutcome?.body?.result?.role === 'guest', JSON.stringify(guestOutcome?.body?.result?.role))

  // ── the card's button, through the plugin's own route on the web server ──
  // This is the one path the relay checks cannot see: the settings card asks the
  // *node* (this route), the node asks the relay, and the relay mints. It exists so
  // that inviting somebody is a button in the Harness rather than an ssh session,
  // which makes it worth asserting end to end.
  {
    const urlLine = log.split('\n').find((line) => line.includes('dsh web: http')) ?? ''
    const origin = urlLine.match(/https?:\/\/127\.0\.0\.1:\d+/)?.[0]
    check('the backend announced its own web origin', typeof origin === 'string', urlLine.slice(0, 120))
    if (origin !== undefined) {
      const health = await fetch(`${origin}/dsh-remote-control/api/health`)
      const healthBody = await health.json().catch(() => ({}))
      check(
        'the invite route is mounted on the harness web server',
        health.status === 200 && healthBody?.value?.connected === true,
        `HTTP ${String(health.status)} ${JSON.stringify(healthBody).slice(0, 160)}`
      )
      const invited = await fetch(`${origin}/dsh-remote-control/api/invite`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}'
      })
      const invitedBody = await invited.json().catch(() => ({}))
      check(
        'the card can get an invite code without leaving the harness',
        invited.status === 200 && invitedBody?.value?.code === 'LIVE-CHECK-CODE',
        `HTTP ${String(invited.status)} ${JSON.stringify(invitedBody).slice(0, 160)}`
      )
      const wrong = await fetch(`${origin}/dsh-remote-control/api/nonsense`, { method: 'POST', body: '{}' })
      check('an unknown method on that route is a 404', wrong.status === 404, `HTTP ${String(wrong.status)}`)
      const wrongVerb = await fetch(`${origin}/dsh-remote-control/api/invite`)
      check('and the invite route only accepts POST', wrongVerb.status === 405, `HTTP ${String(wrongVerb.status)}`)
    }
  }

  // ── a broken guest config must not take the operator down ───────────────
  // `guestEnabled: true` with no directories is the mistake the settings card makes
  // easiest — the two keys sit side by side and only one of them is a switch. The
  // door must stay shut and say why, while the node the operator actually relies on
  // keeps registering. Asserting this needs a second boot, and it is worth one: the
  // tempting implementation (throw during `apply`) would make the whole plugin a
  // no-op, and the symptom of that is "remote control stopped working" with the
  // reason buried in a log nobody read.
  {
    await stopGuarded(backend)
    backend = undefined
    await writeFile(
      join(profileDir, 'cordis.patch.yml'),
      `# Written by tools/live-check.mjs in a throwaway DSH_HOME.\n- id: remote-control\n  config:\n` +
        `    relayUrl: '${relayUrl}'\n` +
        `    nodeToken: 'live-check-node-token'\n` +
        `    displayName: 'live-check broken guest'\n` +
        `    workspaces:\n      - { name: livecheck, path: ${JSON.stringify(workdir)} }\n` +
        `    guestEnabled: true\n`
    )
    const mark = relayState.seen.length
    const second = spawnGuarded(dsh, ['--profile', 'web', '--port', '0', '--no-open'], {
      cwd: workdir,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    backend = second
    let brokenLog = ''
    second.stdout.setEncoding('utf8')
    second.stdout.on('data', (chunk) => {
      brokenLog += chunk
    })
    second.stderr.setEncoding('utf8')
    second.stderr.on('data', (chunk) => {
      brokenLog += chunk
    })
    const brokenDeadline = Date.now() + 60_000
    while (Date.now() < brokenDeadline && !brokenLog.includes('dsh-remote-control: node "')) {
      if (second.exitCode !== null) break
      await sleep(250)
    }
    check(
      'the node still starts with a broken guest config',
      brokenLog.includes('dsh-remote-control: node "'),
      brokenLog.split('\n').filter((line) => line.includes('dsh-remote-control')).slice(0, 4).join(' | ') || 'no plugin output'
    )
    check(
      'the mistake is reported at error level',
      brokenLog.includes('the guest door stays closed: guestEnabled is true but guestWorkspaces is empty'),
      brokenLog.split('\n').filter((line) => line.includes('guest door')).join(' | ') || 'the mistake was not reported'
    )
    const brokenHello = relayState.seen.slice(mark).filter((entry) => entry.path === '/relay/api/agent/hello').at(-1)
    check('the relay is told the door is closed', brokenHello?.body?.guest?.enabled === false, JSON.stringify(brokenHello?.body?.guest))
    check(
      'and no guest directory is advertised',
      Array.isArray(brokenHello?.body?.guest?.workspaces) && brokenHello.body.guest.workspaces.length === 0,
      JSON.stringify(brokenHello?.body?.guest)
    )
    check('the operator announcement still happens', brokenLog.includes('guest off'), brokenLog.split('\n').filter((line) => line.includes('workspace(s)')).join(' | '))
    check('the backend is still alive after the mistake', second.exitCode === null, `exit ${String(second.exitCode)}`)
  }

  process.stdout.write(`\nlive-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nlive-check: harness error — ${error?.stack ?? error}\n`)
} finally {
  // Stopping the backend means stopping its group: `dsh` is a launcher, so the
  // process holding the port may be a descendant. A plain kill here is what left
  // orphaned backends behind in the first place.
  await stopGuarded(backend)
  relay?.close()
  relay?.closeAllConnections?.()
  if (trackedCount() > 0) {
    failures += 1
    process.stdout.write(`live-check: leaked ${String(trackedCount())} child process(es)\n`)
  }
  if (keep) process.stdout.write(`live-check: kept ${workdir}\n`)
  else await rm(workdir, { recursive: true, force: true })
}

if (failures > 0) process.exitCode = 1
