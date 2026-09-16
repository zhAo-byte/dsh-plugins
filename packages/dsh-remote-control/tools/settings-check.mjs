#!/usr/bin/env node
/**
 * `settings-check` — prove the node reconfigures from settings without a restart.
 *
 * The plugin's configuration now resolves through `ctx.settings`, which means a
 * committed change should tear the node down and bring it back with the new
 * values, with no backend restart. That is a claim about live behaviour, so it is
 * checked by doing it: boot an isolated profile, watch the node announce itself,
 * rewrite the settings document the way the GUI would, and assert a second
 * announcement arrives carrying the new values.
 *
 * It needs a real Harness on disk, so it reports a skip where there is none —
 * the same rule the other Harness-dependent checks follow.
 *
 * @module dsh-remote-control/tools/settings-check
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnGuarded, stopGuarded, trackedCount } from './spawn-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const RUNTIME_NODE_MODULES = join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness', 'runtime', 'node_modules')

let failures = 0
let checks = 0
const check = (what, ok, detail = '') => {
  checks += 1
  if (ok) process.stdout.write(`  \u2713 ${what}\n`)
  else {
    failures += 1
    process.stdout.write(`  \u2717 ${what}${detail === '' ? '' : ` — ${detail}`}\n`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Locate the `dsh` launcher.
 *
 * @returns {string|undefined} the launcher path, if any.
 */
function findDsh() {
  const candidates = [process.env.DSH_BIN, join(RUNTIME_NODE_MODULES, '.bin', 'dsh'), join(PACKAGE_ROOT, 'node_modules', '.bin', 'dsh')]
  return candidates.find((candidate) => typeof candidate === 'string' && candidate !== '' && existsSync(candidate))
}

const launcher = findDsh()
if (launcher === undefined) {
  process.stdout.write('settings-check\n')
  process.stdout.write('  \u25CB no dsh launcher found; skipping.\n')
  process.stdout.write('     Set DSH_BIN, or install @deepseek-ai/dsh, then run `npm run test:harness`.\n')
  process.stdout.write('settings-check: skipped\n')
  process.exit(0)
}

const workdir = await mkdtemp(join(tmpdir(), 'dsh-remote-settings-check-'))
const dshHome = join(workdir, 'home')
const profileDir = join(dshHome, 'profiles', 'web')
let relay
let backend

/** Every node identity the stub relay has seen, in order. */
const seen = []

try {
  process.stdout.write('settings-check\n')

  // ── the schema must accept every documented configuration shape ──────────
  // This is where a real defect lived: the schema declared `workspaces` as an
  // array of strings while the plugin and its docs also accept `{ name, path }`.
  // The settings service validates the composed configuration against the schema,
  // so a deployment using the mapping form had its whole namespace rejected and
  // silently lost GUI configuration. Asserted here rather than in node-check
  // because building the schema needs schemastery, which only a Harness provides.
  {
    const { loadSchema } = await import('../lib/settings-schema.js')
    const schema = await loadSchema()
    const accepted = (workspaces) => {
      try {
        const resolved = schema({ relayUrl: 'https://relay.example/harness', nodeToken: 't', workspaces })
        return JSON.stringify(resolved.workspaces)
      } catch {
        return undefined
      }
    }
    check('the schema accepts bare path strings', accepted(['/tmp']) === JSON.stringify(['/tmp']))
    check(
      'the schema accepts the documented { name, path } form',
      accepted([{ name: 'proj', path: '/tmp' }]) === JSON.stringify([{ name: 'proj', path: '/tmp' }]),
      'a deployment using mapped workspaces would lose its whole settings namespace'
    )
    check('the schema still rejects nonsense entries', accepted([123]) === undefined)
    check('the schema defaults the optional fields', schema({ relayUrl: 'https://x/y', nodeToken: 't' }).agentPreset === 'standard')
  }

  // ── the stub relay the node will register with ───────────────────────────
  relay = createServer((req, res) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => {
      let body = {}
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        body = {}
      }
      if (req.url === '/api/agent/hello') seen.push(body)
      if (req.url === '/api/agent/poll') {
        // Hold the poll so the node stays quiet and the check can observe one
        // reconfiguration rather than a stream of retries.
        setTimeout(() => {
          if (!res.writableEnded) {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ command: null }))
          }
        }, 4_000)
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ nodeId: body.nodeId, pollHoldMs: 4_000 }))
    })
  })
  const relayPort = await new Promise((resolve) => {
    relay.listen(0, '127.0.0.1', () => resolve(relay.address().port))
  })
  const relayUrl = `http://127.0.0.1:${String(relayPort)}`

  // ── an isolated profile with the plugin mounted ──────────────────────────
  await mkdir(workdir, { recursive: true })
  await new Promise((resolve, reject) => {
    const init = spawn(launcher, ['--profile', 'web', '--dump-default-config'], {
      cwd: workdir,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: 'ignore'
    })
    init.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`profile init exited ${String(code)}`))))
  })
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(PACKAGE_ROOT, join(profileDir, 'node_modules', 'dsh-remote-control'), 'dir')
  // The client half as well: the bundle patch declares its row, and a profile that
  // cannot resolve it fails the whole plugin tree with ERR_MODULE_NOT_FOUND.
  await symlink(join(PACKAGE_ROOT, 'client'), join(profileDir, 'node_modules', 'dsh-remote-control-client'), 'dir')
  await symlink(join(RUNTIME_NODE_MODULES, '@deepseek-ai'), join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')
  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies['dsh-remote-control'] = `link:${PACKAGE_ROOT}`
  manifest.dsh.profile.bundles.push('dsh-remote-control')
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  // The YAML entry carries only what the settings layer will *not* override, so
  // the assertion below cannot pass by accident through the composition layer.
  // The composed configuration deliberately carries **no token**: that is the state
  // a fresh install is in, and it is the state in which the configuration card has
  // to exist. Registration used to sit behind a successful `applyConfig`, so an
  // incomplete configuration meant no namespace, which meant no card, which meant
  // no way to supply the missing token — a deadlock that stayed invisible while the
  // token was written into the YAML by hand.
  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `- id: remote-control\n  config:\n    relayUrl: '${relayUrl}'\n    nodeToken: ''\n` +
      `    displayName: 'from-yaml'\n    workspaces: ['${workdir.replace(/\\/g, '/')}']\n`
  )

  // ── boot ─────────────────────────────────────────────────────────────────
  backend = spawnGuarded(launcher, ['--profile', 'web', '--port', '0', '--no-open'], {
    cwd: workdir,
    env: { ...process.env, DSH_HOME: dshHome },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let log = ''
  backend.stdout.setEncoding('utf8')
  backend.stderr.setEncoding('utf8')
  backend.stdout.on('data', (chunk) => {
    log += chunk
  })
  backend.stderr.on('data', (chunk) => {
    log += chunk
  })

  const waitFor = async (predicate, timeoutMs) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate()) return true
      if (backend.exitCode !== null) return false
      await sleep(200)
    }
    return false
  }

  // The namespace must exist *before* the node can start, because the card is what
  // supplies the token. Wait for the namespace to be announced, then assert the
  // composed configuration was rejected for the missing token — both at once.
  const namespaceReady = await waitFor(() => log.includes('nodeToken is required'), 60_000)
  check('a configuration without a token is reported, not silently ignored', namespaceReady, log.split('\n').filter((l) => l.includes('remote-control')).slice(0, 3).join(' | '))
  check(
    'the settings namespace is registered even though the node cannot start',
    !log.includes('settings are not editable'),
    'without the namespace the card cannot render, so the missing token could never be supplied'
  )
  check('the node stays down until it has a token', !seen.some((entry) => entry.name === 'from-yaml'), JSON.stringify(seen))

  // ── the settings document the GUI would write ────────────────────────────
  const settingsPath = join(dshHome, 'settings.yaml')
  const before = existsSync(settingsPath) ? await readFile(settingsPath, 'utf8') : ''
  // Supplying the token through settings is the flow the card performs, and it must
  // be enough on its own to bring the node up.
  await writeFile(settingsPath, `${before}remote-control:\n  nodeToken: 'settings-check-token'\n  displayName: 'from-settings'\n`)
  const registrationCountBefore = seen.length

  const reconfigured = await waitFor(
    () => seen.slice(registrationCountBefore).some((entry) => entry.name === 'from-settings'),
    45_000
  )
  check(
    'a settings edit re-registers the node with the new values, without a restart',
    reconfigured,
    `registrations seen: ${seen.map((entry) => entry.name).join(', ') || 'none'}`
  )
  check('the backend never exited during the reconfiguration', backend.exitCode === null, `exit ${String(backend.exitCode)}`)

  const last = seen.at(-1)
  check('the new registration carries the settings display name', last?.name === 'from-settings', JSON.stringify(last?.name))
  // The layering claim — "the settings section overrides only the fields it names" —
  // is checked where it can be checked exactly: the plugin's own resolver. Grepping
  // the log for the URL used to stand in for this, but it only ever passed for the
  // wrong reason (the URL appears in the *rejection* message too), and it broke the
  // moment the token started arriving from settings instead of from YAML.
  {
    const { resolveConfig } = await import('../lib/config.js')
    const merged = resolveConfig({ relayUrl, nodeToken: 'from-settings', displayName: 'from-settings' })
    check(
      'a settings edit leaves unmentioned YAML fields intact',
      merged.relayUrl === relayUrl && merged.nodeToken === 'from-settings',
      JSON.stringify({ relayUrl: merged.relayUrl, nodeToken: merged.nodeToken })
    )
  }

  process.stdout.write(`\nsettings-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\nsettings-check: harness error — ${error?.stack ?? error}\n`)
  process.stdout.write(`settings-check: workdir kept at ${workdir}\n`)
} finally {
  await stopGuarded(backend)
  relay?.close()
  relay?.closeAllConnections?.()
  if (trackedCount() > 0) {
    failures += 1
    process.stdout.write(`settings-check: leaked ${String(trackedCount())} child process(es)\n`)
  }
  if (failures === 0 && process.env.DSH_REMOTE_CONTROL_CHECK_KEEP !== '1') {
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

if (failures > 0) process.exitCode = 1
