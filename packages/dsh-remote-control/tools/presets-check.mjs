#!/usr/bin/env node
/**
 * `presets-check` — the bundled agent presets, installed into a throwaway home.
 *
 * Installing the plugin has to install the agent its guest mode runs, so the one
 * thing that must not be wrong is the rule about *whose* directory gets written.
 * The dangerous failure is not "did not install" — it is "quietly reverted a
 * preset somebody else installed", which would be invisible until a machine
 * behaved differently after a restart. Every rule therefore gets an assertion
 * here, against a real filesystem in a temp `DSH_HOME`:
 *
 *   fresh install · idempotence · bundle change → update + backup ·
 *   a directory this plugin did not create is never touched ·
 *   removals are mirrored · a broken source degrades to a report, never a throw.
 *
 * Needs nothing but Node, so it runs in `npm test` on every platform.
 *
 * @module dsh-remote-control/tools/presets-check
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { BUNDLED_PRESET_ROOT, PRESET_STAMP, ensureBundledPresets, presetsRoot } from '../lib/presets.js'

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
 * Build a source tree with one preset in it.
 *
 * @param {string} root - where to build it.
 * @param {Record<string, string>} files - relative path → contents.
 * @returns {Promise<string>} the source root.
 */
async function makeSource(root, files) {
  for (const [rel, contents] of Object.entries(files)) {
    const target = join(root, rel)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, contents, 'utf8')
  }
  return root
}

const sandbox = await mkdtemp(join(tmpdir(), 'dsh-presets-check-'))
const DSH_HOME = join(sandbox, 'home')
const targetRoot = presetsRoot({ DSH_HOME })

try {
  process.stdout.write('presets-check\n')

  // ── where a preset root comes from ────────────────────────────────────────
  check('DSH_HOME decides the preset root', targetRoot === join(DSH_HOME, '.agent-presets'), targetRoot)
  check(
    'an unset DSH_HOME falls back to ~/.dsh',
    presetsRoot({}).endsWith(join('.dsh', '.agent-presets')),
    presetsRoot({})
  )

  // ── the shipped snapshot itself ───────────────────────────────────────────
  // The plugin's own guest mode resolves `reader` by id out of this directory, so
  // a missing or half-copied snapshot would be a broken default rather than a
  // missing feature.
  {
    const reader = join(BUNDLED_PRESET_ROOT, 'reader')
    check('the reader preset ships with the package', existsSync(join(reader, 'preset.yml')))
    check('it carries the composition file the loader needs', existsSync(join(reader, 'agent.cordis.yml')))
    check('it carries its own read-only tool gate', existsSync(join(reader, 'readonly-tools.mjs')))
    check('it carries the skill that explains it', existsSync(join(reader, 'skills', 'readonly-code-analysis', 'SKILL.md')))
    const preset = await readFile(join(reader, 'preset.yml'), 'utf8')
    check('the preset declares a display name', /^name:\s*\S/m.test(preset), preset.trim().split('\n')[0])
    // `install.sh` in the upstream repository validates exactly this, and a
    // snapshot that would fail there must not be shipped here either.
    const agent = await readFile(join(reader, 'agent.cordis.yml'), 'utf8')
    check('the composition mounts the bundled gate by relative path', agent.includes('name: ./readonly-tools.mjs'))
    check('the composition has no absolute path baked in', !/name:\s*\/(Users|home)\//.test(agent))
  }

  // ── a fresh install ───────────────────────────────────────────────────────
  const sourceA = await makeSource(join(sandbox, 'source-a'), {
    'reader/preset.yml': 'name: Read only\ndescription: test\n',
    'reader/agent.cordis.yml': '- id: persona\n  name: ./gate.mjs\n',
    'reader/gate.mjs': 'export const name = "gate"\n',
    'reader/skills/demo/SKILL.md': '# demo\n'
  })
  const first = await ensureBundledPresets({ sourceRoot: sourceA, targetRoot })
  check('a fresh install reports what it wrote', first[0]?.action === 'installed', JSON.stringify(first))
  check('the preset lands under its id', existsSync(join(targetRoot, 'reader', 'preset.yml')))
  check('nested files are installed too', existsSync(join(targetRoot, 'reader', 'skills', 'demo', 'SKILL.md')))
  check('an ownership stamp is written', existsSync(join(targetRoot, 'reader', PRESET_STAMP)))
  const stamp = JSON.parse(await readFile(join(targetRoot, 'reader', PRESET_STAMP), 'utf8'))
  check('the stamp names the preset', stamp.id === 'reader', JSON.stringify(stamp.id))
  check('the stamp records a hash per file', Object.keys(stamp.files).length === 4, JSON.stringify(Object.keys(stamp.files)))
  // Readability is the property that matters — a preset the backend cannot read is
  // indistinguishable from a missing one. The exact bits are not: `chmod` on
  // Windows only toggles the read-only flag, so `stat` reports 0o666 there whatever
  // was requested, and this check runs on windows-latest.
  const mode = (await stat(join(targetRoot, 'reader', 'preset.yml'))).mode & 0o777
  const ownerReadable = (mode & 0o400) !== 0
  const widerThanOwner = process.platform === 'win32' || (mode & 0o044) !== 0
  check(
    'installed files are readable rather than owner-only',
    ownerReadable && widerThanOwner,
    `mode ${mode.toString(8)} on ${process.platform}`
  )

  // ── idempotence ───────────────────────────────────────────────────────────
  const second = await ensureBundledPresets({ sourceRoot: sourceA, targetRoot })
  check('a second run is a no-op', second[0]?.action === 'current', JSON.stringify(second))
  const backupsAfterSecond = (await readdir(targetRoot)).filter((name) => name.startsWith('.backup-'))
  check('a no-op run creates no backup', backupsAfterSecond.length === 0, backupsAfterSecond.join(', '))

  // ── a changed bundle updates, and backs up first ──────────────────────────
  const sourceB = await makeSource(join(sandbox, 'source-b'), {
    'reader/preset.yml': 'name: Read only v2\ndescription: test\n',
    'reader/agent.cordis.yml': '- id: persona\n  name: ./gate.mjs\n',
    'reader/gate.mjs': 'export const name = "gate"\n',
    'reader/skills/demo/SKILL.md': '# demo\n',
    'reader/skills/second/SKILL.md': '# second\n'
  })
  const third = await ensureBundledPresets({ sourceRoot: sourceB, targetRoot })
  check('a changed snapshot updates the install', third[0]?.action === 'updated', JSON.stringify(third))
  check('the new file is present', existsSync(join(targetRoot, 'reader', 'skills', 'second', 'SKILL.md')))
  check('the updated content landed', (await readFile(join(targetRoot, 'reader', 'preset.yml'), 'utf8')).includes('v2'))
  const backups = (await readdir(targetRoot)).filter((name) => name.startsWith('.backup-reader-'))
  check('an update keeps a backup of the previous install', backups.length === 1, backups.join(', '))
  const backupPreset = await readFile(join(targetRoot, backups[0], 'preset.yml'), 'utf8')
  check('the backup is the version that was replaced', !backupPreset.includes('v2'), backupPreset.trim())

  // ── removals are mirrored ────────────────────────────────────────────────
  // `install.sh` mirrors with `rsync --delete`, and a stale file left behind is a
  // file the preset still loads: a removed skill would keep appearing.
  const sourceC = await makeSource(join(sandbox, 'source-c'), {
    'reader/preset.yml': 'name: Read only v3\ndescription: test\n',
    'reader/agent.cordis.yml': '- id: persona\n  name: ./gate.mjs\n'
  })
  const fourth = await ensureBundledPresets({ sourceRoot: sourceC, targetRoot })
  check('a shrinking snapshot updates too', fourth[0]?.action === 'updated', JSON.stringify(fourth))
  check('a file the snapshot dropped is removed', !existsSync(join(targetRoot, 'reader', 'skills')))
  check('the stamp no longer lists it', !('skills/demo/SKILL.md' in JSON.parse(await readFile(join(targetRoot, 'reader', PRESET_STAMP), 'utf8')).files))

  // ── a directory this plugin did not install is never touched ──────────────
  // This is the rule that keeps a hand-installed preset from being reverted on
  // every backend restart. `dsh-agent`'s `install.sh` mirrors its source with
  // `--delete`, which removes the stamp — so after somebody installs from the
  // upstream repository, this plugin must go quiet for good.
  {
    const foreignRoot = join(sandbox, 'foreign')
    await makeSource(foreignRoot, {
      'reader/preset.yml': 'name: Hand installed\ndescription: mine\n',
      'reader/agent.cordis.yml': '- id: persona\n'
    })
    // Point the installer at a target root where the directory already exists
    // without a stamp, and whose content differs from the snapshot.
    const report = await ensureBundledPresets({ sourceRoot: sourceC, targetRoot: foreignRoot })
    check('a stamp-free directory is reported as foreign', report[0]?.action === 'foreign', JSON.stringify(report))
    check(
      'its contents are left exactly as they were',
      (await readFile(join(foreignRoot, 'reader', 'preset.yml'), 'utf8')).includes('Hand installed')
    )
    check('and no stamp is added to it', !existsSync(join(foreignRoot, 'reader', PRESET_STAMP)))

    // A stamp naming another preset is not ours either.
    await writeFile(
      join(foreignRoot, 'reader', PRESET_STAMP),
      `${JSON.stringify({ id: 'somebody-else', files: {} })}\n`,
      'utf8'
    )
    const again = await ensureBundledPresets({ sourceRoot: sourceC, targetRoot: foreignRoot })
    check('a stamp naming another owner is not ours', again[0]?.action === 'foreign', JSON.stringify(again))
  }

  // ── local edits to an install we own are repaired, with a backup ──────────
  {
    const ownedRoot = join(sandbox, 'owned')
    await ensureBundledPresets({ sourceRoot: sourceC, targetRoot: ownedRoot })
    await writeFile(join(ownedRoot, 'reader', 'preset.yml'), 'name: edited by hand\ndescription: oops\n', 'utf8')
    const repaired = await ensureBundledPresets({ sourceRoot: sourceC, targetRoot: ownedRoot })
    check('an edit inside our own install is repaired', repaired[0]?.action === 'updated', JSON.stringify(repaired))
    check(
      'the snapshot content is back',
      (await readFile(join(ownedRoot, 'reader', 'preset.yml'), 'utf8')).includes('v3')
    )
  }

  // ── a non-preset directory in the snapshot is skipped, not installed ──────
  {
    const mixedRoot = join(sandbox, 'mixed')
    await makeSource(mixedRoot, {
      'notes/README.md': 'not a preset\n',
      'reader/preset.yml': 'name: ok\ndescription: test\n',
      'reader/agent.cordis.yml': '- id: persona\n'
    })
    const report = await ensureBundledPresets({ sourceRoot: mixedRoot, targetRoot: join(sandbox, 'mixed-target') })
    check('a directory without the loader files is skipped', report.length === 1 && report[0].id === 'reader', JSON.stringify(report))
  }

  // ── failures are reported, never thrown ───────────────────────────────────
  // This runs during plugin load; a throw would take the backend down for a
  // reason that has nothing to do with the backend.
  {
    const missing = await ensureBundledPresets({ sourceRoot: join(sandbox, 'nope'), targetRoot })
    check('an unreadable snapshot reports a failure', missing[0]?.action === 'failed', JSON.stringify(missing))
    // A file where the target directory should be makes every write fail.
    const blockedTarget = join(sandbox, 'blocked')
    await writeFile(blockedTarget, 'not a directory\n', 'utf8')
    const blocked = await ensureBundledPresets({ sourceRoot: sourceC, targetRoot: blockedTarget })
    check('an unwritable target is reported, not thrown', blocked[0]?.action === 'failed', JSON.stringify(blocked))
  }

  process.stdout.write(`\npresets-check: ${String(checks - failures)}/${String(checks)} passed\n`)
} catch (error) {
  failures += 1
  process.stdout.write(`\npresets-check: harness error — ${error?.stack ?? error}\n`)
} finally {
  await rm(sandbox, { recursive: true, force: true })
}

if (failures > 0) process.exitCode = 1
