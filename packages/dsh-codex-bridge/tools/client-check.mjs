#!/usr/bin/env node
/**
 * Boot the *real* web profile in an isolated `DSH_HOME` on a throwaway port and
 * prove the browser half of the bridge is actually composed and served.
 *
 * This is the check behind "the card exists" — the one thing `panel-check.mjs`
 * cannot answer, because it never touches the Loader, `dsh-client-modules`, or
 * the settings service. Nothing here touches the running Harness: the temp home
 * gets the profile's config, symlinks to the plugin packages, and its own
 * settings document, so a running backend and this boot cannot see each other.
 *
 *   node tools/client-check.mjs [--port 0] [--timeout 90]
 *
 * The assertions, in boot order:
 *
 *   1. the backend comes up (`node <runtime>/…/dsh/lib/bin.js web`);
 *   2. the boot manifest served to the browser lists `dsh-codex-bridge-client`;
 *   3. the application batch that ships it is actually retrievable;
 *   4. the host row wrote the `codex-bridge` settings namespace.
 *
 * `process.exitCode` (never `process.exit()`) so piping the output cannot
 * truncate it — same rule as the other self-checks in this package.
 */
import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CLIENT_PACKAGE = 'dsh-codex-bridge-client'
const HOST_PACKAGE = 'dsh-codex-bridge'
const NAMESPACE = 'codex-bridge'

const args = process.argv.slice(2)
const port = readFlag(args, '--port') ?? '0'
const timeoutMs = Number(readFlag(args, '--timeout') ?? 90) * 1000

const runtimeRoot = process.env.DSH_RUNTIME_ROOT ?? defaultRuntimeRoot()
const cli = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const dshHome = join(homedir(), '.dsh')
const webProfile = join(dshHome, 'profiles', 'web')
const home = join(tmpdir(), `dsh-codex-bridge-check-${process.pid}`)

const failures = []
const notes = []
let child
let base = ''

try {
  if (!existsSync(cli)) fail(`dsh CLI not found at ${cli} (set DSH_RUNTIME_ROOT to the Harness runtime directory)`)
  else {
    prepareHome()
    child = await boot()
    base = new URL(child.url).origin
    const cookies = await authenticate()
    const index = await request(cookies)
    checkManifest(index)
    await checkBundle(index, cookies)
    await checkNamespace()
  }
} catch (error) {
  fail(`unexpected: ${String(error)}`)
  if (child?.stderrTail?.length) notes.push(`child stderr tail:\n${child.stderrTail.join('')}`)
} finally {
  child?.kill('SIGTERM')
  if (process.env.DSH_CODEX_BRIDGE_CHECK_KEEP !== '1') rmSync(home, { recursive: true, force: true })
}

for (const note of notes) console.log(`\n${note}`)
if (failures.length === 0) {
  console.log('\nclient-check: OK — the browser half is composed, served, and backed by a live namespace')
} else {
  console.log(`\nclient-check: ${failures.length} failure(s)`)
  for (const failure of failures) console.log(`  ✗ ${failure}`)
  process.exitCode = 1
}

// ---------------------------------------------------------------------------

/**
 * The runtime directory the macOS app ships. Overridable because the app's
 * install location is a deployment fact, not a property of this package.
 * @returns the default runtime root for this machine.
 */
function defaultRuntimeRoot() {
  return join(homedir(), 'Library', 'Application Support', 'DeepSeekHarness', 'runtime')
}

function readFlag(argv, flag) {
  const index = argv.indexOf(flag)
  return index === -1 ? undefined : argv[index + 1]
}

function ok(message) {
  console.log(`  ✓ ${message}`)
}

function fail(message) {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}

/** Copy the profile's own config, with symlinks to the plugin packages under test. */
function prepareHome() {
  const profile = join(home, 'profiles', 'web')
  mkdirSync(join(profile, 'node_modules'), { recursive: true })
  mkdirSync(join(home, 'storages'), { recursive: true })
  symlinkSync(join(dshHome, 'profiles', 'node_modules'), join(home, 'profiles', 'node_modules'))
  for (const file of ['package.json', 'cordis.yml', 'cordis.patch.yml', 'pnpm-workspace.yaml']) {
    const source = join(webProfile, file)
    if (existsSync(source)) copyFileSync(source, join(profile, file))
  }
  // The profile's own node_modules is not copied wholesale: the two packages
  // under test get deliberate links, and everything else resolves through the
  // shared hoisted tree linked above.
  for (const [name, target] of [
    [HOST_PACKAGE, PACKAGE_ROOT],
    [CLIENT_PACKAGE, join(PACKAGE_ROOT, 'client')]
  ]) {
    const link = join(profile, 'node_modules', name)
    if (!existsSync(link)) symlinkSync(target, link)
  }
  // Pin the bundle list to the packages under test.
  //
  // The copied package.json is the operator's, and copying it wholesale made this
  // check a function of whatever else they had installed: the moment an unrelated
  // plugin appeared in their `bundles`, the isolated profile tried to resolve it
  // and the backend exited with "cannot resolve profile bundle" — a red result
  // that said nothing about this package. A test fixture should be the smallest
  // environment that exercises the thing under test, so it names its own bundles
  // and inherits everything else (the user patch layer, the hoisted tree) as-is.
  pinBundles(join(profile, 'package.json'))
  notes.push(`isolated DSH_HOME: ${home}`)
}

/**
 * Rewrite one profile manifest so its bundle list contains only this package.
 *
 * @param {string} manifestPath - the copied profile `package.json`.
 */
function pinBundles(manifestPath) {
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const shipped = (manifest.dsh?.profile?.bundles ?? []).filter((entry) => entry.startsWith('@deepseek-ai/'))
  manifest.dsh.profile.bundles = [...shipped, HOST_PACKAGE]
  if (!manifest.dependencies?.[HOST_PACKAGE]) manifest.dependencies = { ...manifest.dependencies, [HOST_PACKAGE]: `link:${PACKAGE_ROOT}` }
  if (!manifest.dependencies?.[CLIENT_PACKAGE]) {
    manifest.dependencies = { ...manifest.dependencies, [CLIENT_PACKAGE]: `link:${join(PACKAGE_ROOT, 'client')}` }
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

/** Start the web profile and wait for its URL line. */
function boot() {
  return new Promise((resolveBoot, rejectBoot) => {
    const proc = spawn(process.execPath, [cli, 'web', '--port', port, '--no-open'], {
      cwd: runtimeRoot,
      env: { ...process.env, DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    proc.stderrTail = []
    const onData = (chunk) => {
      const text = String(chunk)
      for (const line of text.split('\n')) if (line.trim() !== '') proc.stderrTail.push(`${line}\n`)
      if (proc.stderrTail.length > 60) proc.stderrTail.splice(0, proc.stderrTail.length - 60)
      if (proc.url !== undefined) return
      const match = text.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[A-Za-z0-9_-]+/)
      if (match === null) return
      proc.url = match[0]
      resolveBoot(proc)
    }
    proc.stdout.on('data', onData)
    proc.stderr.on('data', onData)
    proc.on('exit', (code) => {
      if (proc.url === undefined) rejectBoot(new Error(`backend exited with ${String(code)} before printing its URL`))
    })
    setTimeout(() => {
      if (proc.url === undefined) rejectBoot(new Error(`backend printed no URL within ${String(timeoutMs / 1000)}s`))
    }, timeoutMs).unref()
  })
}

/** Exchange the bootstrap token for the auth cookie. */
async function authenticate() {
  const response = await fetch(child.url, { redirect: 'manual' })
  const cookie = response.headers.get('set-cookie')
  if (cookie === null) throw new Error(`token exchange returned ${String(response.status)} without a cookie`)
  return cookie.split(';')[0]
}

async function request(cookies, path = '/') {
  const response = await fetch(`${base}${path}`, { headers: { cookie: cookies } })
  if (!response.ok) throw new Error(`GET ${path} → ${String(response.status)}`)
  return response.text()
}

/** Assertion 2: the boot manifest lists the client row and it is prefetched. */
function checkManifest(index) {
  const marker = `"id":"${CLIENT_PACKAGE}"`
  if (index.includes(marker)) ok(`boot manifest lists ${CLIENT_PACKAGE}`)
  else return fail(`boot manifest does not list ${CLIENT_PACKAGE} — is the codex-panel-client row enabled?`)

  const boot = index.match(/__DSH_BOOT__"\]\s*=\s*(\{.*?\})<\/script>/s)
  if (boot === null) return fail('could not read window.__DSH_BOOT__ from the index')
  const graph = JSON.parse(boot[1])
  const entry = graph.entries.find((row) => row.id === CLIENT_PACKAGE)
  if (entry === undefined) return fail(`${CLIENT_PACKAGE} is absent from the composed entry graph`)
  ok(`entry graph row present (rev ${entry.rev}, inject [${(entry.inject ?? []).join(', ')}])`)
}

/** Assertion 3: the batch that carries the row is retrievable, byte for byte. */
async function checkBundle(index, cookies) {
  const preload = index.match(/<link rel="preload" as="script" href="([^"]+)"[^>]*>/)
  if (preload === null) return fail('the index carries no application-batch preload to fetch')
  const href = preload[1].replaceAll('&amp;', '&')
  const bundle = await request(cookies, href)
  const source = readFileSync(join(PACKAGE_ROOT, 'client', 'lib', 'client.js'), 'utf8')
  if (!bundle.includes(`id: "${CLIENT_PACKAGE}"`)) return fail(`served batch does not register ${CLIENT_PACKAGE}`)
  if (!bundle.includes(source.slice(0, 400))) return fail('served batch does not match the bundle on disk')
  ok(`served application batch carries the bundle (${(bundle.length / 1024 / 1024).toFixed(1)} MB composite)`)
}

/** Assertion 4: the host row published the namespace the card reads. */
async function checkNamespace() {
  const settingsPath = join(home, 'settings.yaml')
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    const text = existsSync(settingsPath) ? readFileSync(settingsPath, 'utf8') : ''
    if (text.includes(`${NAMESPACE}:`)) {
      const fields = text.slice(text.indexOf(`${NAMESPACE}:`))
      for (const field of ['authState', 'skillsUsable', 'mcpServers', 'skillsSkippedReasons', 'mcpSkippedReasons']) {
        if (!fields.includes(field)) return fail(`namespace ${NAMESPACE} is missing ${field}`)
      }
      return ok(`settings namespace ${NAMESPACE} published by the host row`)
    }
    await new Promise((done) => setTimeout(done, 250))
  }
  fail(`settings namespace ${NAMESPACE} never appeared in the isolated settings document`)
}
