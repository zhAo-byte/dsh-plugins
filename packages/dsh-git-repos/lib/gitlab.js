/**
 * GitLab hosting support for `dsh-git-repos`.
 *
 * Two independent layers:
 *
 * 1. **URL knowledge** — {@link describeRemote} classifies a `git remote` URL
 *    and builds the deep links the panel offers (branch, commit, file, new
 *    merge request). This works with no token and no network.
 * 2. **REST calls** — {@link listMergeRequests} and {@link listPipelines} read
 *    the GitLab v4 API when a token is configured. Every failure is reported as
 *    data (`{ ok: false, error }`) so a missing or under-scoped token degrades
 *    the panel instead of breaking it.
 *
 * Tokens never reach the browser: the host resolves them per request and only
 * ever returns GitLab's own response payload.
 *
 * @module dsh-git-repos/gitlab
 */

import { parseRemoteUrl } from './git.js'

/** Hostnames always treated as GitLab even without configuration. */
const GITLAB_HOST_HINT = /(^|\.)gitlab[.-]/i

/**
 * Decide whether a remote points at a GitLab instance.
 *
 * @param url - remote URL.
 * @param hosts - configured self-hosted GitLab hostnames.
 * @returns the parsed description plus whether it counts as GitLab.
 */
export function describeRemote(url, hosts = []) {
  const parsed = parseRemoteUrl(url)
  if (parsed.local) return { ...parsed, gitlab: false }

  const configured = new Set(hosts.map((host) => String(host).toLowerCase().trim()).filter(Boolean))
  const host = String(parsed.host ?? '').toLowerCase()
  const gitlab = configured.has(host) || GITLAB_HOST_HINT.test(host) || host === 'gitlab.com'

  return {
    ...parsed,
    gitlab,
    projectUrl: `${parsed.webBase}/${parsed.project}`,
  }
}

/**
 * Build a GitLab web deep link.
 *
 * @param remote - a {@link describeRemote} result.
 * @param target - `kind` selects the page; `ref`, `path`, `sha` refine it.
 * @returns the absolute URL, or undefined when the remote is not a hosted URL.
 */
export function webUrl(remote, target = {}) {
  if (!remote || remote.local || !remote.webBase) return undefined
  const base = `${remote.webBase}/${remote.project}`
  const ref = target.ref ? encodeURIComponent(target.ref) : undefined

  switch (target.kind) {
    case 'repository':
      return base
    case 'tree':
      return ref ? `${base}/-/tree/${ref}` : `${base}/-/tree`
    case 'blob':
      return ref && target.path
        ? `${base}/-/blob/${ref}/${encodePath(target.path)}`
        : undefined
    case 'commit':
      return target.sha ? `${base}/-/commit/${target.sha}` : undefined
    case 'commits':
      return ref ? `${base}/-/commits/${ref}` : `${base}/-/commits`
    case 'merge-requests':
      return ref ? `${base}/-/merge_requests?scope=all&state=all&source_branch=${ref}` : `${base}/-/merge_requests`
    case 'new-merge-request': {
      if (!ref) return `${base}/-/merge_requests/new`
      const params = new URLSearchParams({ 'merge_request[source_branch]': target.ref })
      if (target.target) params.set('merge_request[target_branch]', target.target)
      return `${base}/-/merge_requests/new?${params.toString()}`
    }
    case 'compare':
      return target.target && ref ? `${base}/-/compare/${ref}...${encodeURIComponent(target.target)}` : undefined
    case 'pipelines':
      return ref ? `${base}/-/pipelines?ref=${ref}` : `${base}/-/pipelines`
    case 'pipeline':
      return target.id ? `${base}/-/pipelines/${target.id}` : undefined
    case 'branches':
      return `${base}/-/branches`
    case 'tags':
      return `${base}/-/tags`
    case 'settings':
      return `${base}/-/settings/repository`
    default:
      return base
  }
}

/**
 * Percent-encode each segment of a repository-relative path.
 *
 * @param value - repo-relative path.
 * @returns the path with `/` preserved.
 */
function encodePath(value) {
  return String(value).split('/').map(encodeURIComponent).join('/')
}

/**
 * Resolve the GitLab token from the plugin config, then the environment.
 *
 * @param config - plugin config (may carry `gitlabToken` / `token`).
 * @param env - environment to read `GITLAB_TOKEN` / `GL_TOKEN` from.
 * @returns the token, or undefined when none is configured.
 */
export function resolveToken(config = {}, env = process.env) {
  const fromConfig = config.gitlabToken ?? config.token
  if (typeof fromConfig === 'string' && fromConfig.trim() !== '') return fromConfig.trim()
  const fromEnv = env.GITLAB_TOKEN ?? env.GL_TOKEN ?? env.GITLAB_PRIVATE_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return undefined
}

/**
 * Call the GitLab v4 API.
 *
 * @param options - `host`, `path`, `token`, `query`, `method`, `body`.
 * @returns `{ ok: true, value }` or `{ ok: false, error, status }`; never throws.
 */
export async function api(options) {
  const host = String(options.host ?? '').replace(/^https?:\/\//, '').replace(/\/+$/, '')
  if (host === '') return { ok: false, error: 'no GitLab host', status: 0 }

  const url = new URL(`https://${host}/api/v4${options.path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value === undefined || value === null || value === '') continue
    url.searchParams.set(key, String(value))
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000)
  try {
    const response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        accept: 'application/json',
        ...(options.token ? { 'private-token': options.token } : {}),
        ...(options.body ? { 'content-type': 'application/json' } : {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal,
    })

    const text = await response.text()
    let payload
    try {
      payload = text === '' ? undefined : JSON.parse(text)
    } catch {
      payload = text
    }

    if (!response.ok) {
      const message = typeof payload === 'object' && payload !== null && payload.message
        ? (Array.isArray(payload.message) ? payload.message.join('; ') : String(payload.message))
        : (typeof payload === 'string' && payload !== '' ? payload.slice(0, 300) : `HTTP ${response.status}`)
      return { ok: false, error: message, status: response.status }
    }
    return { ok: true, value: payload, status: response.status }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    return { ok: false, error: aborted ? 'GitLab request timed out' : String(error?.message ?? error), status: 0 }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Percent-encode a `group/project` path for the API.
 *
 * @param project - project path with namespace.
 * @returns the encoded id.
 */
export function encodeProject(project) {
  return encodeURIComponent(String(project ?? '').replace(/^\/+/, '').replace(/\.git$/, ''))
}

/**
 * Read merge requests, defaulting to the ones opened from a branch.
 *
 * @param options - `host`, `project`, `token`, `sourceBranch`, `state`, `limit`.
 * @returns a normalized list of merge requests, or an error row.
 */
export async function listMergeRequests(options) {
  const response = await api({
    host: options.host,
    token: options.token,
    path: `/projects/${encodeProject(options.project)}/merge_requests`,
    query: {
      state: options.state ?? 'opened',
      source_branch: options.sourceBranch,
      order_by: 'updated_at',
      sort: 'desc',
      per_page: Math.min(Math.max(Number(options.limit) || 20, 1), 50),
    },
    timeoutMs: options.timeoutMs,
  })

  if (!response.ok) return { ok: false, error: response.error, status: response.status, items: [] }

  const items = (Array.isArray(response.value) ? response.value : []).map((mr) => ({
    iid: mr.iid,
    title: mr.title,
    state: mr.state,
    draft: Boolean(mr.draft ?? mr.work_in_progress),
    webUrl: mr.web_url,
    sourceBranch: mr.source_branch,
    targetBranch: mr.target_branch,
    author: mr.author?.name ?? mr.author?.username,
    updatedAt: mr.updated_at,
    createdAt: mr.created_at,
    mergeStatus: mr.detailed_merge_status ?? mr.merge_status,
    hasConflicts: mr.has_conflicts === true,
    upvotes: mr.upvotes,
    downvotes: mr.downvotes,
    userNotesCount: mr.user_notes_count,
    labels: mr.labels ?? [],
  }))

  return { ok: true, items }
}

/**
 * Read pipelines for a ref.
 *
 * @param options - `host`, `project`, `token`, `ref`, `limit`.
 * @returns normalized pipeline rows, or an error row.
 */
export async function listPipelines(options) {
  const response = await api({
    host: options.host,
    token: options.token,
    path: `/projects/${encodeProject(options.project)}/pipelines`,
    query: {
      ref: options.ref,
      order_by: 'id',
      sort: 'desc',
      per_page: Math.min(Math.max(Number(options.limit) || 5, 1), 20),
    },
    timeoutMs: options.timeoutMs,
  })

  if (!response.ok) return { ok: false, error: response.error, status: response.status, items: [] }

  const items = (Array.isArray(response.value) ? response.value : []).map((pipeline) => ({
    id: pipeline.id,
    status: pipeline.status,
    ref: pipeline.ref,
    sha: pipeline.sha,
    webUrl: pipeline.web_url,
    updatedAt: pipeline.updated_at,
    createdAt: pipeline.created_at,
  }))

  return { ok: true, items }
}

/**
 * Read a project's headline facts (default branch, visibility, clone URLs).
 *
 * @param options - `host`, `project`, `token`.
 * @returns the project row, or an error row.
 */
export async function projectInfo(options) {
  const response = await api({
    host: options.host,
    token: options.token,
    path: `/projects/${encodeProject(options.project)}`,
    query: { simple: true },
    timeoutMs: options.timeoutMs,
  })
  if (!response.ok) return { ok: false, error: response.error, status: response.status }

  const project = response.value ?? {}
  return {
    ok: true,
    project: {
      id: project.id,
      name: project.name_with_namespace ?? project.path_with_namespace,
      path: project.path_with_namespace,
      defaultBranch: project.default_branch,
      visibility: project.visibility,
      webUrl: project.web_url,
      sshUrl: project.ssh_url_to_repo,
      httpUrl: project.http_url_to_repo,
      archived: project.archived,
      lastActivityAt: project.last_activity_at,
    },
  }
}
