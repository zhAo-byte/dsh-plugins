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
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(req.url === '/relay/api/agent/hello' ? { nodeId: body?.nodeId, pollHoldMs: relayState.holdMs } : { ok: true }))
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

  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `# Written by tools/live-check.mjs in a throwaway DSH_HOME.\n- id: remote-control\n  config:\n` +
      `    relayUrl: '${relayUrl}'\n` +
      `    nodeToken: 'live-check-node-token'\n` +
      `    displayName: 'live-check node'\n` +
      `    workspaces:\n      - { name: livecheck, path: ${JSON.stringify(workdir)} }\n`
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
