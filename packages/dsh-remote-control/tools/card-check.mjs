#!/usr/bin/env node
/**
 * `card-check` — prove the configuration card reaches the browser.
 *
 * The card is the deliverable, so "the files exist and the syntax parses" is not
 * evidence. This boots an isolated profile with the package installed the way a
 * user installs it, then follows the same path a browser takes: exchange the
 * launch token for the auth cookie, read `window.__DSH_BOOT__` from the served
 * index, fetch the application bundle it preloads, and assert the card's registry
 * call is inside it and that the host row served the namespace the card binds to.
 *
 * That chain is what the earlier `ERR_MODULE_NOT_FOUND` incident taught: a plugin
 * can be installed, listed in the composed tree, and still never reach a browser.
 *
 * @module dsh-remote-control/tools/card-check
 */

import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnGuarded, stopGuarded, trackedCount } from './spawn-guard.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGE_ROOT = join(HERE, '..')
const CLIENT_ROOT = join(PACKAGE_ROOT, 'client')
const RUNTIME_NODE_MODULES = join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness', 'runtime', 'node_modules')

const HOST_PACKAGE = 'dsh-remote-control'
const CLIENT_PACKAGE = 'dsh-remote-control-client'
const NAMESPACE = 'remote-control'

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
  process.stdout.write('card-check\n')
  process.stdout.write('  \u25CB no dsh launcher found; skipping.\n')
  process.stdout.write('card-check: skipped\n')
  process.exit(0)
}

const workdir = await mkdtemp(join(tmpdir(), 'dsh-remote-card-check-'))
const dshHome = join(workdir, 'home')
const profileDir = join(dshHome, 'profiles', 'web')
let backend

try {
  process.stdout.write('card-check\n')

  await mkdir(workdir, { recursive: true })
  await new Promise((resolve, reject) => {
    const init = spawn(launcher, ['--profile', 'web', '--dump-default-config'], {
      cwd: workdir,
      env: { ...process.env, DSH_HOME: dshHome },
      stdio: 'ignore'
    })
    init.once('exit', (code) => (code === 0 ? resolve() : reject(new Error(`profile init exited ${String(code)}`))))
  })

  // Install both halves the way the profile does: symlinks, because that is also
  // what `dsh plugin add <git url>` produces for a linked checkout.
  await mkdir(join(profileDir, 'node_modules'), { recursive: true })
  await symlink(PACKAGE_ROOT, join(profileDir, 'node_modules', HOST_PACKAGE), 'dir')
  await symlink(CLIENT_ROOT, join(profileDir, 'node_modules', CLIENT_PACKAGE), 'dir')
  await symlink(join(RUNTIME_NODE_MODULES, '@deepseek-ai'), join(profileDir, 'node_modules', '@deepseek-ai'), 'dir')

  const manifestPath = join(profileDir, 'package.json')
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  manifest.dependencies[HOST_PACKAGE] = `link:${PACKAGE_ROOT}`
  manifest.dependencies[CLIENT_PACKAGE] = `link:${CLIENT_ROOT}`
  // Pin the bundle list, so this check is not a function of whatever else the
  // operator has installed (the mistake that broke the sibling client-check).
  //
  // Only the *host* package belongs in `bundles`. A bundle entry must declare
  // `dsh.bundle`, and a client package declares `dsh.client` instead — listing it
  // makes the loader refuse the profile outright ("declares no dsh.bundle"). The
  // client half is discovered from the Loader entries by `dsh-client-modules`,
  // which scans for `dsh.client` declarations; it needs the dependency, not a
  // bundle entry. That asymmetry is exactly what the installed profile shows for
  // the sibling bridge, and getting it backwards is what made this check fail.
  manifest.dsh.profile.bundles = (manifest.dsh.profile.bundles ?? []).filter((entry) => entry.startsWith('@deepseek-ai/'))
  manifest.dsh.profile.bundles.push(HOST_PACKAGE)
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2))

  await writeFile(
    join(profileDir, 'cordis.patch.yml'),
    `- id: remote-control\n  config:\n    relayUrl: 'http://127.0.0.1:9/stub'\n    nodeToken: 'card-check-token'\n` +
      `    displayName: 'card-check'\n    workspaces: ['${workdir.replace(/\\/g, '/')}']\n`
  )

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

  const url = await (async () => {
    const deadline = Date.now() + 60_000
    while (Date.now() < deadline) {
      const match = /dsh web: (http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s]+)/.exec(log)
      if (match !== null) return match[1]
      if (backend.exitCode !== null) throw new Error(`backend exited ${String(backend.exitCode)}:\n----- log -----\n${log}\n----- end -----`)
      await sleep(250)
    }
    throw new Error(`no URL line within 60s:\n----- log -----\n${log}\n----- end -----`)
  })()

  // ── 1. the browser handshake: launch token in, auth cookie out ───────────
  const root = await fetch(url, { redirect: 'manual' })
  const setCookie = root.headers.get('set-cookie')
  check('the launch token is exchanged for an auth cookie', root.status === 303 && setCookie !== null, `HTTP ${String(root.status)}`)
  const cookie = (setCookie ?? '').split(';')[0]

  const base = new URL(url).origin
  const index = await fetch(`${base}/`, { headers: { cookie } }).then((response) => response.text())

  // ── 2. the boot manifest must carry the card's entry ─────────────────────
  // Read the entry graph, not the rendered HTML. An earlier version of this check
  // asserted the package name appeared in the index text, which passed for the
  // wrong reason (the name is elsewhere on the page) while the card was in fact
  // absent from the graph and its bundle 404'd. Assert the structured fact.
  const boot = /__DSH_BOOT__"\]\s*=\s*(\{.*?\})<\/script>/s.exec(index)
  check('the served index carries the boot manifest', boot !== null)
  const parsed = boot === null ? undefined : JSON.parse(boot[1])
  const entry = (parsed?.entries ?? []).find((candidate) => candidate.id === CLIENT_PACKAGE)
  check(
    'the boot manifest carries an entry for the client package',
    entry !== undefined,
    `entries: ${(parsed?.entries ?? []).map((e) => e.id).join(', ')}`
  )
  check(
    'the entry injects the settings UI the card registers into',
    entry !== undefined && (entry.inject ?? []).some((name) => String(name).includes('dsh-client-ui-settings')),
    JSON.stringify(entry?.inject)
  )

  // ── 3. the bundle the graph names must be served, and contain the card ───
  // The URL comes from the graph rather than being constructed here. Client
  // bundles are served through a combo route (`/plugins/??<a>,<b>&rev=…`), so a
  // hand-built `/plugins/<pkg>/client.js` is not a route that exists.
  if (entry !== undefined) {
    // Build the combo URL rather than reading `entry.url` verbatim: the route is
    // `/plugins/??<pkg>/client.js&rev=<rev>`, and the manifest's copy of it travels
    // through an HTML-embedded JSON string where `&` arrives escaped. Rebuilding it
    // from the entry's own revision keeps the request honest — it still asks for the
    // exact artifact the graph names — without depending on that encoding.
    const clientUrl = `/plugins/??${CLIENT_PACKAGE}/client.js&rev=${String(entry.rev)}`
    const response = await fetch(new URL(clientUrl, base), { headers: { cookie } })
    const bundle = await response.text()
    check('the client bundle named by the graph is served', response.status === 200, `HTTP ${String(response.status)} for ${clientUrl}`)
    check('the served bundle is substantial', bundle.length > 1_000, `${String(bundle.length)} bytes`)
    // The registration is `slots.register({ name: 'settings.plugin.item', key: NAMESPACE }, Card)`,
    // so the slot name and the namespace key must both be in the served artifact.
    check(
      'the bundle registers the card into the keyed settings slot',
      bundle.includes('settings.plugin.item') && bundle.includes(NAMESPACE),
      `slot=${String(bundle.includes('settings.plugin.item'))} key=${String(bundle.includes(NAMESPACE))}`
    )
    check('the bundle carries the card component itself', bundle.includes('RemoteControlCard'))
    check(
      'the bundle declares the services the card reads config through',
      bundle.includes('settingsScope') && bundle.includes('slots'),
      'the card would mount without the scope it needs'
    )
  }

  // ── 5. the host row must serve the namespace the card binds to ───────────
  const settingsPath = join(dshHome, 'settings.yaml')
  check('the host registered the settings namespace it serves', !log.includes('settings are not editable'), log.split('\n').filter((l) => l.includes('settings')).slice(0, 2).join(' | '))

  process.stdout.write(`\ncard-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\ncard-check: harness error — ${error?.stack ?? error}\n`)
  process.stdout.write(`card-check: workdir kept at ${workdir}\n`)
} finally {
  await stopGuarded(backend)
  if (trackedCount() > 0) {
    failures += 1
    process.stdout.write(`card-check: leaked ${String(trackedCount())} child process(es)\n`)
  }
  if (failures === 0 && process.env.DSH_REMOTE_CONTROL_CHECK_KEEP !== '1') {
    await rm(workdir, { recursive: true, force: true }).catch(() => {})
  }
}

if (failures > 0) process.exitCode = 1
