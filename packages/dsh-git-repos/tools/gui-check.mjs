#!/usr/bin/env node
/**
 * End-to-end GUI check for `dsh-git-repos`.
 *
 * Drives a real browser against a running DSH web GUI: opens the right sidebar,
 * picks the plugin's guide capsule, and asserts the panel renders repositories
 * from the workspace with no console errors.
 *
 * `playwright-core` is not a dependency of this plugin. Point the check at an
 * installed copy:
 *
 *     PLAYWRIGHT_CORE=/path/to/playwright-core node tools/gui-check.mjs --url <gui-url>
 *
 * Options:
 *   --url <url>        GUI URL including its `?token=` when the instance asks for one.
 *   --session <title>  session to open first (defaults to the first listed one).
 *   --out <png>        screenshot path (default: a temp file, printed at the end).
 *   --keep-open        leave the browser open (for manual poking).
 */

import { existsSync, readdirSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Read `--flag value` pairs from argv.
 *
 * @returns a plain option map plus positionals.
 */
function parseArgs() {
  const argv = process.argv.slice(2)
  const options = { positional: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--keep-open') {
      options.keepOpen = true
      continue
    }
    if (token.startsWith('--')) {
      options[token.slice(2)] = argv[index + 1]
      index += 1
      continue
    }
    options.positional.push(token)
  }
  return options
}

/**
 * Locate a usable `playwright-core`.
 *
 * @returns a file URL for its ESM entry.
 */
function resolvePlaywright() {
  const candidates = []
  if (process.env.PLAYWRIGHT_CORE) candidates.push(process.env.PLAYWRIGHT_CORE)

  // A sibling install used by the tooling on this machine, then the npx cache.
  candidates.push('/tmp/pw/node_modules/playwright-core')
  const npxRoot = join(homedir(), '.npm', '_npx')
  if (existsSync(npxRoot)) {
    for (const entry of readdirSync(npxRoot)) {
      candidates.push(join(npxRoot, entry, 'node_modules', 'playwright-core'))
    }
  }

  for (const candidate of candidates) {
    const entry = join(candidate, 'index.mjs')
    if (existsSync(entry)) return pathToFileURL(entry).href
  }
  throw new Error('playwright-core not found; set PLAYWRIGHT_CORE to its directory')
}

const options = parseArgs()
const url = options.url
if (!url) {
  console.error('usage: node tools/gui-check.mjs --url <gui-url> [--session <title>] [--out <png>]')
  process.exit(2)
}

const out = options.out ?? join(tmpdir(), `dsh-git-repos-panel-${Date.now()}.png`)
const { chromium } = await import(resolvePlaywright())

let failures = 0

/**
 * Assert a condition.
 *
 * @param label - what is checked.
 * @param condition - must hold.
 * @param detail - printed on failure.
 */
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok   ${label}`)
  else { failures += 1; console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`) }
}

const browser = await chromium.launch({ headless: options.keepOpen !== true })
const context = await browser.newContext({ viewport: { width: 1700, height: 1050 } })
const page = await context.newPage()

const consoleErrors = []
const rpcCalls = []
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()) })
page.on('pageerror', (error) => consoleErrors.push(`pageerror: ${error}`))
page.on('response', (response) => {
  const target = response.url()
  if (target.includes('/dsh-git-repos/api/')) rpcCalls.push({ status: response.status(), path: target.split('/api/')[1] })
})

try {
  console.log('\n# boot')
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  check('the GUI shell rendered', (await page.locator('button').count()) > 0)

  console.log('\n# open a session')
  if (options.session) {
    await page.getByText(options.session, { exact: true }).first().click()
  } else {
    const first = page.locator('[class*="sessionRow"], [role="button"]').first()
    await first.click().catch(() => {})
  }
  await page.waitForTimeout(3500)

  console.log('\n# open the right sidebar')
  const expand = page.getByRole('button', { name: 'Open right sidebar' })
  if (await expand.count()) await expand.first().click()
  await page.waitForTimeout(1800)
  check('a right sidebar surface is present',
    (await page.getByRole('button', { name: 'Collapse right sidebar' }).count()) > 0)

  console.log('\n# open the Git panel')
  const capsule = page.locator('button', { hasText: 'Git 仓库' }).filter({ hasText: '多仓库' })
  const capsuleCount = await capsule.count()
  check('the guide lists the Git 仓库 entry', capsuleCount > 0, `matches=${capsuleCount}`)
  if (capsuleCount > 0) {
    const box = await capsule.first().boundingBox()
    if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.waitForTimeout(6000)
  }

  console.log('\n# panel content')
  const panel = page.locator('div.gr-root').first()
  check('the panel root mounted', (await panel.count()) > 0)
  const panelText = (await panel.count()) ? await panel.innerText() : ''
  check('the toolbar shows the workspace root', panelText.includes('/'), panelText.slice(0, 120))
  check('the repository list section rendered', panelText.includes('仓库'))
  check('at least one repository row rendered', (await page.locator('div.gr-repo').count()) > 0,
    `rows=${await page.locator('div.gr-repo').count()}`)
  check('a branch chip rendered', (await page.locator('span.gr-chip--branch').count()) > 0)
  check('the detail tab strip rendered', (await page.locator('button.gr-tab').count()) >= 4,
    `tabs=${await page.locator('button.gr-tab').count()}`)

  console.log('\n# host round-trips')
  check('the panel called the host API', rpcCalls.length > 0, JSON.stringify(rpcCalls.slice(0, 4)))
  check('every host call succeeded', rpcCalls.every((call) => call.status === 200),
    JSON.stringify(rpcCalls.filter((call) => call.status !== 200).slice(0, 4)))

  console.log('\n# tabs')
  for (const [label, marker] of [['历史', 'gr-logRow'], ['分支', 'gr-section'], ['远程', 'gr-section']]) {
    const tab = page.locator('button.gr-tab', { hasText: label }).first()
    if (await tab.count()) {
      await tab.click()
      await page.waitForTimeout(1200)
      const found = await page.locator(`div.${marker}`).count()
      check(`the ${label} tab renders content`, found > 0, `nodes=${found}`)
    }
  }

  check('no console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | ').slice(0, 400))

  await page.screenshot({ path: out })
  console.log(`\nscreenshot: ${out}`)
} finally {
  if (options.keepOpen !== true) await browser.close()
}

console.log(failures === 0 ? '\nAll checks passed.\n' : `\n${failures} check(s) failed.\n`)
process.exit(failures === 0 ? 0 : 1)
