/**
 * `codex-auth` — a read-only preflight row for the Codex ecosystem.
 *
 * Some Codex-backed capabilities need a live Codex login (the subscription
 * OAuth tokens Codex keeps in `$CODEX_HOME/auth.json`). Rather than
 * re-implementing that OAuth flow — which would mean a browser, a loopback
 * callback and a blocking startup path — this row only *reports* what it finds,
 * once, at profile boot. It never runs `codex login`, never spawns the Codex
 * binary, and never writes to `$CODEX_HOME`: Codex stays the only owner of its
 * own credentials and refresh logic.
 *
 * @module dsh-codex-bridge/auth
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** Cordis plugin name. */
export const name = 'codex-auth'

/**
 * Report the Codex login state at boot.
 * @param {object} ctx - Cordis context (uses `ctx.logger`).
 * @param {object} [config] - `{ enabled?, codexHome? }`.
 */
export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const codexHome = resolve(expandHome(config.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')))
  const verdict = inspectCodexAuth(codexHome)
  const line = verdict.state === 'ok'
    ? `codex-auth: ${verdict.detail}`
    : `codex-auth: ${verdict.detail} — ${verdict.hint}`
  // `ctx.logger` is not wired to stdout in the web profile, and a boot banner
  // nobody can read is worthless: the host captures backend stdout/stderr into
  // its app log, so the verdict goes there as well.
  if (verdict.state === 'ok') ctx.logger?.info?.(line)
  else ctx.logger?.warn?.(line)
  process.stderr.write(`${line}\n`)
}

/**
 * Inspect `$CODEX_HOME/auth.json` without touching it.
 *
 * States: `ok` (usable tokens), `expired` (tokens past their JWT expiry — Codex
 * refreshes them on next use when a refresh token is present), `missing` (no
 * file or no tokens — only `codex login` can fix it), `apikey` (Codex is
 * configured for an API key, so the subscription is not in play).
 *
 * @param {string} codexHome - resolved Codex home.
 * @returns {{ state: 'ok'|'expired'|'missing'|'apikey', authMode?: string, expiresAt?: number, detail: string, hint: string }}
 */
export function inspectCodexAuth(codexHome) {
  let raw
  try {
    raw = readFileSync(join(codexHome, 'auth.json'), 'utf8')
  } catch {
    return {
      state: 'missing',
      detail: `no auth.json under ${codexHome}`,
      hint: 'run `codex login` once if you want Codex-backed capabilities (image generation through `codex exec`)'
    }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      state: 'missing',
      detail: `${join(codexHome, 'auth.json')} is not valid JSON`,
      hint: 'run `codex login` once to rewrite it'
    }
  }
  const authMode = typeof parsed.auth_mode === 'string' ? parsed.auth_mode : undefined
  const tokens = parsed.tokens ?? {}
  const accessToken = typeof tokens.access_token === 'string' ? tokens.access_token : undefined
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : undefined
  const apiKey = typeof parsed.OPENAI_API_KEY === 'string' && parsed.OPENAI_API_KEY.length > 0
  if (authMode === 'apikey' || (apiKey && accessToken === undefined)) {
    return {
      state: 'apikey',
      ...(authMode === undefined ? {} : { authMode }),
      detail: 'Codex is configured with an API key, not a subscription login',
      hint: 'the ChatGPT subscription is not in play; set OPENAI_API_KEY for the imagegen CLI fallback if you want it'
    }
  }
  if (accessToken === undefined) {
    return {
      state: 'missing',
      ...(authMode === undefined ? {} : { authMode }),
      detail: `auth.json has no access token (auth_mode: ${authMode ?? 'unknown'})`,
      hint: 'run `codex login` once if you want Codex-backed capabilities'
    }
  }
  const expiresAt = jwtExpiry(accessToken)
  if (expiresAt === undefined) {
    return {
      state: 'ok',
      ...(authMode === undefined ? {} : { authMode }),
      detail: `Codex login present (auth_mode: ${authMode ?? 'unknown'}), token expiry not readable`,
      hint: ''
    }
  }
  const when = new Date(expiresAt).toISOString().replace('T', ' ').slice(0, 16)
  if (expiresAt <= Date.now()) {
    return refreshToken === undefined
      ? {
          state: 'expired',
          authMode,
          expiresAt,
          detail: `Codex access token expired at ${when} and there is no refresh token`,
          hint: 'run `codex login` once'
        }
      : {
          state: 'expired',
          authMode,
          expiresAt,
          detail: `Codex access token expired at ${when}`,
          hint: 'Codex refreshes it on next use; run `codex login` if that fails'
        }
  }
  return {
    state: 'ok',
    ...(authMode === undefined ? {} : { authMode }),
    expiresAt,
    detail: `Codex login present (auth_mode: ${authMode ?? 'unknown'}), access token valid until ${when}`,
    hint: ''
  }
}

/** Read `exp` (ms) from a JWT without verifying it — this is a local hint only. */
function jwtExpiry(token) {
  const segment = String(token).split('.')[1]
  if (segment === undefined) return undefined
  try {
    const payload = JSON.parse(Buffer.from(segment.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'))
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function expandHome(path) {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
