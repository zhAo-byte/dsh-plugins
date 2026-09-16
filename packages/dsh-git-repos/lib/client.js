/**
 * `dsh-git-repos` — browser half.
 *
 * One tab type in the official right sidebar: a Rider-style Git tool window
 * that lists every repository under the active workspace, then drills into the
 * selected one (changes, history, branches, remotes, GitLab).
 *
 * Hand-authored bundle, no bundler: the shell seeds a frozen module table with
 * React, so this file only ever `require`s `react`, and every host call goes
 * through the plugin's own JSON RPC (`/dsh-git-repos/api/*`). All chrome is
 * built from the shell's `--dsw-alias-*` design tokens so it follows the
 * active skin automatically.
 *
 * @module dsh-git-repos/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-git-repos',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')

    /** Shorthand for `React.createElement`. */
    const h = React.createElement

    /** Browser services this bundle consumes. */
    const inject = ['slots', 'sidebarRightTabs']

    /** This implementation's identity in the tab system, and its slot key. */
    const TAB_ID = 'dsh-git-repos:repos'
    /** The page kind this package owns. */
    const TAB_KIND = 'git-repos'
    /** RPC root. */
    const API = '/dsh-git-repos/api/'
    /** Refresh cadence bounds, seconds. */
    const MIN_REFRESH = 3
    const MAX_REFRESH = 120

    /* ── Styles ─────────────────────────────────────────────────────────────── */

    const CSS = `
.gr-root{display:flex;flex-direction:column;height:100%;min-height:0;font-size:12.5px;line-height:18px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base,transparent)}
.gr-root *{box-sizing:border-box}
.gr-mono{font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px}
.gr-dim{color:var(--dsw-alias-label-tertiary)}
.gr-sec{color:var(--dsw-alias-label-secondary)}
.gr-row{display:flex;align-items:center;gap:6px;min-width:0}
.gr-grow{flex:1;min-width:0}
.gr-ellipsis{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.gr-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;height:24px;padding:0 8px;border:0;border-radius:7px;background:var(--dsw-alias-interactive-bg,rgba(127,127,127,.1));color:var(--dsw-alias-label-primary);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.gr-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.18))}
.gr-btn:disabled{opacity:.45;cursor:default}
.gr-btn:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary,#4a7dff);outline-offset:1px}
.gr-btn--icon{width:24px;padding:0}
.gr-btn--primary{background:var(--dsw-alias-state-business-primary,#3b6ef5);color:#fff}
.gr-btn--primary:hover:not(:disabled){filter:brightness(1.08)}
.gr-btn--danger{color:var(--dsw-alias-state-error-primary,#d8503f)}
.gr-btn--ghost{background:transparent}
.gr-btn--ghost:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.14))}
.gr-input,.gr-textarea{width:100%;border:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.3));border-radius:7px;background:var(--dsw-alias-bg-layer-2,rgba(127,127,127,.05));color:var(--dsw-alias-label-primary);font-family:inherit;font-size:12px;padding:5px 7px}
.gr-input:focus,.gr-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary,#3b6ef5)}
.gr-textarea{resize:vertical;min-height:52px;line-height:17px}
.gr-toolbar{flex:none;display:flex;align-items:center;gap:6px;padding:7px 9px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}
.gr-body{flex:1;min-height:0;display:flex;flex-direction:column}
.gr-scan{flex:none;max-height:44%;min-height:78px;overflow:auto;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}
.gr-scan--collapsed{max-height:none;overflow:visible}
.gr-scanHead{position:sticky;top:0;z-index:1;display:flex;align-items:center;gap:6px;padding:5px 9px;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.gr-scanHint{display:flex;align-items:center;gap:5px;padding:4px 9px;font-size:11px;color:var(--dsw-alias-state-warning-primary,#b7791f);background:rgba(183,121,31,.1);border-bottom:1px solid rgba(183,121,31,.22)}
.gr-scanNote{display:flex;align-items:center;padding:3px 9px;font-size:10.5px;color:var(--dsw-alias-label-tertiary)}
.gr-repo{display:flex;align-items:center;gap:6px;padding:5px 9px 5px 9px;cursor:pointer;border-left:2px solid transparent}
.gr-repo:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.gr-repo[data-active="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(59,110,245,.12));border-left-color:var(--dsw-alias-state-business-primary,#3b6ef5)}
.gr-repoName{font-weight:600}
.gr-repoActions{display:flex;align-items:center;gap:2px;opacity:0;transition:opacity .1s}
.gr-repo:hover .gr-repoActions,.gr-repo[data-active="true"] .gr-repoActions{opacity:1}
.gr-chip{display:inline-flex;align-items:center;gap:3px;height:17px;padding:0 5px;border-radius:5px;background:var(--dsw-alias-bg-layer-3,rgba(127,127,127,.14));font-size:10.5px;font-weight:600;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-secondary)}
.gr-chip--branch{max-width:150px;color:var(--dsw-alias-label-primary)}
.gr-chip--ahead{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.gr-chip--behind{color:var(--dsw-alias-state-warn-primary,#c98a1b)}
.gr-chip--gl{background:rgba(226,103,32,.16);color:#e26720}
.gr-count{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-tertiary)}
.gr-dot{width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-success-primary,#2f9e63)}
.gr-dot--dirty{background:var(--dsw-alias-state-warn-primary,#c98a1b)}
.gr-dot--bad{background:var(--dsw-alias-state-error-primary,#d8503f)}
.gr-detail{flex:1;min-height:0;display:flex;flex-direction:column}
.gr-detailHead{flex:none;padding:6px 9px;display:flex;flex-direction:column;gap:5px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.gr-tabs{flex:none;display:flex;align-items:center;gap:2px;padding:4px 7px;border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22));overflow-x:auto}
.gr-tab{display:inline-flex;align-items:center;gap:4px;height:22px;padding:0 8px;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary);font-size:11.5px;font-weight:500;cursor:pointer;white-space:nowrap}
.gr-tab:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.12))}
.gr-tab[data-active="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(59,110,245,.14));color:var(--dsw-alias-label-primary)}
.gr-content{flex:1;min-height:0;overflow:auto;padding:2px 0 12px}
.gr-section{padding:4px 9px}
.gr-sectionTitle{display:flex;align-items:center;gap:5px;margin:6px 0 3px;font-size:10.5px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--dsw-alias-label-tertiary)}
.gr-file{display:flex;align-items:center;gap:6px;padding:3px 9px;cursor:pointer;border-radius:0}
.gr-file:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.gr-file[data-active="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(59,110,245,.12))}
.gr-st{flex:none;width:14px;text-align:center;font-weight:700;font-size:10.5px}
.gr-st--M{color:var(--dsw-alias-state-business-primary,#3b6ef5)}
.gr-st--A{color:var(--dsw-alias-state-success-primary,#2f9e63)}
.gr-st--D{color:var(--dsw-alias-state-error-primary,#d8503f)}
.gr-st--R{color:#9a5bd6}
.gr-st--U{color:var(--dsw-alias-state-warn-primary,#c98a1b)}
.gr-st--C{color:var(--dsw-alias-state-error-primary,#d8503f)}
.gr-fileActions{display:flex;gap:2px;opacity:0}
.gr-file:hover .gr-fileActions,.gr-file[data-active="true"] .gr-fileActions{opacity:1}
.gr-commit{padding:6px 9px;display:flex;flex-direction:column;gap:6px;border-top:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))}
.gr-log{display:flex;flex-direction:column}
.gr-logRow{display:flex;gap:7px;padding:5px 9px;cursor:pointer}
.gr-logRow:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.gr-logRow[data-active="true"]{background:var(--dsw-alias-interactive-bg-selected,rgba(59,110,245,.12))}
.gr-rail{flex:none;width:10px;display:flex;justify-content:center;position:relative}
.gr-rail:before{content:"";position:absolute;top:0;bottom:-10px;width:1.5px;background:var(--dsw-alias-border-l2,rgba(127,127,127,.3))}
.gr-node{position:relative;z-index:1;margin-top:4px;width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-state-business-primary,#3b6ef5);box-shadow:0 0 0 2px var(--dsw-alias-bg-base,#fff)}
.gr-ref{display:inline-flex;align-items:center;height:15px;padding:0 4px;margin-right:3px;border-radius:4px;background:rgba(59,110,245,.15);color:var(--dsw-alias-state-business-primary,#3b6ef5);font-size:10px;font-weight:600}
.gr-diff{display:flex;flex-direction:column;min-height:0}
.gr-diffHead{position:sticky;top:0;z-index:2;display:flex;align-items:center;gap:6px;padding:5px 9px;background:var(--dsw-alias-bg-base,#fff);border-bottom:1px solid var(--dsw-alias-border-l2,rgba(127,127,127,.22))}
.gr-diffBody{overflow:auto;font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:16px;white-space:pre}
.gr-line{display:block;padding:0 9px}
.gr-line--add{background:rgba(47,158,99,.14);color:var(--dsw-alias-state-success-primary,#2f9e63)}
.gr-line--del{background:rgba(216,80,63,.13);color:var(--dsw-alias-state-error-primary,#d8503f)}
.gr-line--hunk{background:rgba(59,110,245,.1);color:var(--dsw-alias-state-business-primary,#3b6ef5)}
.gr-line--meta{color:var(--dsw-alias-label-tertiary)}
.gr-line--file{font-weight:700;color:var(--dsw-alias-label-primary)}
.gr-empty{padding:22px 16px;text-align:center;color:var(--dsw-alias-label-tertiary);display:flex;flex-direction:column;align-items:center;gap:8px}
.gr-banner{margin:6px 9px;padding:6px 8px;border-radius:7px;font-size:11.5px;display:flex;gap:6px;align-items:flex-start}
.gr-banner--error{background:rgba(216,80,63,.12);color:var(--dsw-alias-state-error-primary,#d8503f);border:1px solid rgba(216,80,63,.28)}
.gr-banner--notice{background:rgba(47,158,99,.12);color:var(--dsw-alias-state-success-primary,#2f9e63);border:1px solid rgba(47,158,99,.26)}
.gr-mr{display:flex;flex-direction:column;gap:3px;padding:6px 9px;border-bottom:1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))}
.gr-link{color:var(--dsw-alias-state-business-primary,#3b6ef5);text-decoration:none;cursor:pointer}
.gr-link:hover{text-decoration:underline}
.gr-kv{display:flex;gap:6px;align-items:baseline}
.gr-kvKey{flex:none;width:76px;color:var(--dsw-alias-label-tertiary);font-size:11px}
.gr-spin{animation:gr-spin 1s linear infinite;transform-origin:50% 50%}
@keyframes gr-spin{from{transform:rotate(0)}to{transform:rotate(360deg)}}
.gr-split{display:flex;gap:6px;align-items:center}
`

    /** Install the stylesheet once per document, idempotent across HMR reloads. */
    function installStyles() {
      if (typeof document === 'undefined') return
      const id = 'dsh-git-repos/client.css'
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-git-repos'
      tag.dataset.pluginCss = id
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /* ── Icons ──────────────────────────────────────────────────────────────── */

    /**
     * Render one 16×16 glyph.
     *
     * @param props - `path` (svg path data) and `size`.
     * @returns the svg element.
     */
    function Glyph({ path, size = 13, spin = false, className = '' }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'currentColor',
        'aria-hidden': 'true', className: `${className}${spin ? ' gr-spin' : ''}`,
        style: { flex: 'none', display: 'block' },
      }, h('path', { d: path }))
    }

    const P = {
      repo: 'M2 2.75A.75.75 0 012.75 2h3.19a.75.75 0 01.53.22l1.06 1.06h5.72a.75.75 0 01.75.75v9.22a.75.75 0 01-.75.75H2.75a.75.75 0 01-.75-.75V2.75zm1.5.75v9h9V5.5H7.31L6.25 4.44 5.19 3.5H3.5z',
      branch: 'M11.75 3a1.25 1.25 0 10-1.7 1.17v3.1a2.5 2.5 0 01-1.53 2.31l-1.27.53V7.62a1.75 1.75 0 10-1.5 0v5.7a1.75 1.75 0 101.5-.13v-.87l1.83-.76a3.5 3.5 0 002.17-3.22V4.17A1.25 1.25 0 0011.75 3zM5.75 4.5a.75.75 0 110-1.5.75.75 0 010 1.5zm0 9a.75.75 0 110-1.5.75.75 0 010 1.5z',
      refresh: 'M8 2.5a5.5 5.5 0 015.5 5.5.75.75 0 001.5 0A7 7 0 003.2 3.2L2 4.4V1.5a.75.75 0 00-1.5 0V6a.75.75 0 00.75.75h4.5a.75.75 0 000-1.5H3.06A5.48 5.48 0 018 2.5zm4.94 9.1A5.5 5.5 0 012.5 8a.75.75 0 00-1.5 0 7 7 0 0011.8 4.8L14 14v2.9a.75.75 0 001.5 0V12.5a.75.75 0 00-.75-.75H10.25a.75.75 0 000 1.5h2.69z',
      down: 'M8 1.5a.75.75 0 01.75.75v8.19l2.72-2.72a.75.75 0 111.06 1.06l-4 4a.75.75 0 01-1.06 0l-4-4a.75.75 0 111.06-1.06l2.72 2.72V2.25A.75.75 0 018 1.5zM2.75 13a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75z',
      up: 'M8 14.5a.75.75 0 01-.75-.75V5.56L4.53 8.28a.75.75 0 11-1.06-1.06l4-4a.75.75 0 011.06 0l4 4a.75.75 0 11-1.06 1.06L8.75 5.56v8.19A.75.75 0 018 14.5zM2.75 1.5a.75.75 0 000 1.5h10.5a.75.75 0 000-1.5H2.75z',
      sync: 'M8 2a6 6 0 016 6 .75.75 0 001.5 0A7.5 7.5 0 002.6 3.4L1.5 4.5V1.6a.75.75 0 00-1.5 0V6c0 .41.34.75.75.75H5.2a.75.75 0 000-1.5H3.1A6 6 0 018 2zm6 8h-3.45a.75.75 0 000 1.5h2.1A6 6 0 012.4 12.6l1.1-1.1a.75.75 0 00-1.06-1.06L.5 12.4v2.9a.75.75 0 001.5 0v-1.9A7.5 7.5 0 0014.5 8 .75.75 0 0014 10z',
      plus: 'M8.75 2.75a.75.75 0 00-1.5 0v4.5h-4.5a.75.75 0 000 1.5h4.5v4.5a.75.75 0 001.5 0v-4.5h4.5a.75.75 0 000-1.5h-4.5v-4.5z',
      minus: 'M2.75 7.25h10.5a.75.75 0 010 1.5H2.75a.75.75 0 010-1.5z',
      check: 'M13.78 4.22a.75.75 0 010 1.06l-6.5 6.5a.75.75 0 01-1.06 0l-3-3a.75.75 0 111.06-1.06l2.47 2.47 5.97-5.97a.75.75 0 011.06 0z',
      chevron: 'M5.22 3.22a.75.75 0 011.06 0l4.25 4.25a.75.75 0 010 1.06l-4.25 4.25a.75.75 0 11-1.06-1.06L8.94 8 5.22 4.28a.75.75 0 010-1.06z',
      file: 'M3.5 1.75A1.75 1.75 0 015.25 0h4.19c.46 0 .9.18 1.23.51l3.32 3.32c.33.33.51.77.51 1.23v9.19A1.75 1.75 0 0112.75 16h-7.5A1.75 1.75 0 013.5 14.25V1.75z',
      history: 'M8 1.5a6.5 6.5 0 106.5 6.5A.75.75 0 0013 8 5 5 0 118 3c1.4 0 2.67.58 3.57 1.5H9.75a.75.75 0 000 1.5h3.5A.75.75 0 0014 5.25v-3.5a.75.75 0 00-1.5 0v1.2A6.48 6.48 0 008 1.5zm.75 3.25a.75.75 0 00-1.5 0V8c0 .2.08.39.22.53l2 2a.75.75 0 101.06-1.06L8.75 7.69V4.75z',
      remote: 'M8 1a7 7 0 100 14A7 7 0 008 1zM2.6 7.25a5.5 5.5 0 013.1-4.3 12.6 12.6 0 00-.63 4.3H2.6zm1.5 1.5h1.0c.06 1.5.28 2.85.63 3.8a5.5 5.5 0 01-1.63-3.8zm3.15 0h1.5v4.02a11 11 0 01-.75.03 11 11 0 01-.75-.03V8.75zm3 0h1c-.06 1.5-.28 2.85-.63 3.8a5.5 5.5 0 001.63-3.8h-1zm1-1.5h-1a12.6 12.6 0 00-.63-4.3 5.5 5.5 0 011.63 4.3zm-2.65 0h-1.5V3.23c.25-.02.5-.03.75-.03s.5.01.75.03V7.25zm-3.5 0h-1a5.5 5.5 0 011.63-4.3 12.6 12.6 0 00-.63 4.3z',
      stash: 'M2 3.25A.75.75 0 012.75 2.5h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 3.25zm0 4A.75.75 0 012.75 6.5h10.5a.75.75 0 010 1.5H2.75A.75.75 0 012 7.25zm0 4a.75.75 0 01.75-.75h10.5a.75.75 0 010 1.5H2.75a.75.75 0 01-.75-.75z',
      worktree: 'M1.75 2.5a.75.75 0 01.75-.75h4.5a.75.75 0 01.75.75v4.5a.75.75 0 01-.75.75H4.31l2.72 2.72a.75.75 0 11-1.06 1.06L3.25 6.81v2.44a.75.75 0 01-1.5 0v-6.75zm8 6a.75.75 0 01.75-.75h3.75a.75.75 0 01.75.75v3.75a.75.75 0 01-.75.75H10.5a.75.75 0 01-.75-.75V8.5z',
      undo: 'M3.06 4.5h2.69a.75.75 0 000-1.5H1.25A.75.75 0 00.5 3.75v4.5a.75.75 0 001.5 0V5.56l1.2 1.2a7 7 0 109.9 0 .75.75 0 00-1.06 1.06 5.5 5.5 0 11-7.78 0L3.06 4.5z',
      warn: 'M8 1.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM7.25 4.5a.75.75 0 011.5 0v4a.75.75 0 01-1.5 0v-4zM8 11a.9.9 0 100 1.8A.9.9 0 008 11z',
      settings: 'M8 5.5a2.5 2.5 0 100 5 2.5 2.5 0 000-5zm0 1.5a1 1 0 110 2 1 1 0 010-2zM6.9 1.4a1 1 0 011.94 0l.16.68a5.6 5.6 0 011.2.7l.66-.24a1 1 0 011.2.44l.97 1.68a1 1 0 01-.24 1.25l-.54.45a5.6 5.6 0 010 1.39l.54.45a1 1 0 01.24 1.25l-.97 1.68a1 1 0 01-1.2.44l-.66-.24a5.6 5.6 0 01-1.2.7l-.16.68a1 1 0 01-.97.74H6.9a1 1 0 01-.97-.74l-.16-.68a5.6 5.6 0 01-1.2-.7l-.66.24a1 1 0 01-1.2-.44l-.97-1.68a1 1 0 01.24-1.25l.54-.45a5.6 5.6 0 010-1.39l-.54-.45a1 1 0 01-.24-1.25l.97-1.68a1 1 0 011.2-.44l.66.24a5.6 5.6 0 011.2-.7l.16-.68z',
      external: 'M10.5 2.25a.75.75 0 000 1.5h1.19L6.97 8.47a.75.75 0 101.06 1.06l4.72-4.72v1.19a.75.75 0 001.5 0v-3A.75.75 0 0013.5 2.25h-3zM3.5 4.5a1 1 0 00-1 1v7a1 1 0 001 1h7a1 1 0 001-1V9a.75.75 0 10-1.5 0v3h-6v-6h3a.75.75 0 000-1.5h-3.5z',
      commit: 'M8 5.25a2.75 2.75 0 100 5.5 2.75 2.75 0 000-5.5zM8 6.75a1.25 1.25 0 110 2.5 1.25 1.25 0 010-2.5zM7.25 0h1.5v4.4a.75.75 0 01-1.5 0V0zm0 11.6a.75.75 0 011.5 0V16h-1.5v-4.4z',
      back: 'M10.78 3.22a.75.75 0 010 1.06L7.06 8l3.72 3.72a.75.75 0 11-1.06 1.06l-4.25-4.25a.75.75 0 010-1.06l4.25-4.25a.75.75 0 011.06 0z',
      copy: 'M5.5 2A1.5 1.5 0 014 3.5v8.25a.75.75 0 01-1.5 0V3.5A3 3 0 015.5.5h5.25a.75.75 0 010 1.5H5.5zM7 3.5A1.5 1.5 0 018.5 2h4A1.5 1.5 0 0114 3.5v9a1.5 1.5 0 01-1.5 1.5h-4A1.5 1.5 0 017 12.5v-9z',
      tag: 'M2.25 2A.75.75 0 013 1.25h5.09c.2 0 .39.08.53.22l5.66 5.66a.75.75 0 010 1.06l-6.09 6.09a.75.75 0 01-1.06 0L1.47 8.62a.75.75 0 01-.22-.53V2.75A.75.75 0 012.25 2zm2.25 2.5a1 1 0 100 2 1 1 0 000-2z',
    }

    /* ── RPC ────────────────────────────────────────────────────────────────── */

    /**
     * Call the host half.
     *
     * @param method - method name after the prefix.
     * @param payload - JSON body.
     * @param signal - abort signal.
     * @returns the unwrapped `value`.
     * @throws {Error} with the host's message when the envelope says failure.
     */
    async function rpc(method, payload, signal) {
      let response
      try {
        response = await fetch(API + method, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload ?? {}),
          signal,
        })
      } catch (error) {
        if (error?.name === 'AbortError') throw error
        throw new Error(`无法连接 Git 服务：${error?.message ?? error}`)
      }
      const text = await response.text()
      let body
      try {
        body = text === '' ? {} : JSON.parse(text)
      } catch {
        throw new Error(`Git 服务返回了非 JSON 响应（HTTP ${response.status}）`)
      }
      if (!response.ok || body.ok !== true) {
        throw new Error(body?.error?.message ?? `HTTP ${response.status}`)
      }
      return body.value
    }

    /* ── Small helpers ──────────────────────────────────────────────────────── */

    /**
     * The porcelain status letter the file list shows.
     *
     * @param entry - a status entry from the host.
     * @returns one letter plus its colour class key.
     */
    function statusLetter(entry) {
      if (entry.conflicted) return { letter: 'C', cls: 'C' }
      if (entry.untracked) return { letter: 'U', cls: 'U' }
      if (entry.renamed) return { letter: 'R', cls: 'R' }
      const code = entry.staged ? entry.index : entry.worktree
      if (code === 'A') return { letter: 'A', cls: 'A' }
      if (code === 'D') return { letter: 'D', cls: 'D' }
      if (code === 'R') return { letter: 'R', cls: 'R' }
      if (code === '?') return { letter: 'U', cls: 'U' }
      return { letter: 'M', cls: 'M' }
    }

    /**
     * Coerce a host answer into an array.
     *
     * The host envelopes every list (`{ remotes }`, `{ worktrees }`, …), and a
     * field may also be absent after a partial failure. Both must degrade to an
     * empty list rather than a render crash.
     *
     * @param value - candidate.
     * @returns the value when it is already an array, otherwise `[]`.
     */
    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    /**
     * Normalize the six detail answers into the panel's detail shape.
     *
     * Kept as a pure module-scope function so `tools/client-check.mjs` can feed
     * it the exact envelopes the host produces.
     *
     * @param answers - `status`, `branches`, `history`, `remotes`, `worktrees`, `stashes`.
     * @returns `{ detail, commits }`.
     */
    function unpackDetail(answers) {
      const source = answers ?? {}
      return {
        detail: {
          status: source.status ?? {},
          branches: source.branches ?? { local: [], remote: [], current: '' },
          remotes: asArray(source.remotes?.remotes),
          worktrees: asArray(source.worktrees?.worktrees),
          stashes: asArray(source.stashes?.stashes),
        },
        commits: asArray(source.history?.commits),
      }
    }

    /**
     * Trim a repository root for display.
     *
     * @param path - absolute path.
     * @param root - the workspace root it is relative to.
     * @returns a short label.
     */
    function shortPath(path, root) {
      if (!path) return ''
      if (root && path.startsWith(`${root}/`)) return path.slice(root.length + 1)
      return path
    }

    /**
     * Format one changed-file row into React nodes.
     *
     * @param entry - status entry.
     * @returns `{ dir, base }`.
     */
    function splitPath(path) {
      const index = path.lastIndexOf('/')
      return index === -1 ? { dir: '', base: path } : { dir: path.slice(0, index + 1), base: path.slice(index + 1) }
    }

    /**
     * Classify one unified-diff line.
     *
     * @param line - the raw line.
     * @returns the modifier class.
     */
    function diffLineClass(line) {
      if (line.startsWith('@@')) return 'gr-line--hunk'
      if (line.startsWith('+++') || line.startsWith('---')) return 'gr-line--meta'
      if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('new file')
        || line.startsWith('deleted file') || line.startsWith('similarity index') || line.startsWith('rename ')) {
        return 'gr-line--file'
      }
      if (line.startsWith('+')) return 'gr-line--add'
      if (line.startsWith('-')) return 'gr-line--del'
      return ''
    }

    /**
     * Persist a small preference set in localStorage, tolerating failure.
     *
     * @param key - storage key suffix.
     * @param value - value to store, or undefined to read.
     * @returns the stored value when reading.
     */
    function prefs(key, value) {
      const full = `dsh-git-repos:${key}`
      try {
        if (value === undefined) return window.localStorage.getItem(full)
        window.localStorage.setItem(full, String(value))
        return value
      } catch {
        return value === undefined ? null : value
      }
    }

    /* ── Components ─────────────────────────────────────────────────────────── */

    /**
     * A button with an icon and optional label.
     *
     * @param props - `icon`, `label`, `title`, `onClick`, `disabled`, `variant`,
     *   `tone` (`danger` colours the glyph), `rotate` (degrees).
     * @returns the button element.
     */
    function Btn({ icon, label, title, onClick, disabled, variant, tone, rotate }) {
      const classes = ['gr-btn']
      if (!label) classes.push('gr-btn--icon')
      if (variant) classes.push(`gr-btn--${variant}`)
      if (tone) classes.push(`gr-btn--${tone}`)
      return h('button', {
        type: 'button',
        className: classes.join(' '),
        title: title ?? label,
        onClick,
        disabled: disabled === true,
      }, icon
        ? h('span', {
          key: 'i',
          style: rotate ? { display: 'inline-flex', transform: `rotate(${rotate}deg)`, transition: 'transform .12s' } : undefined,
        }, h(Glyph, { path: icon }))
        : null,
        label ? h('span', null, label) : null)
    }

    /**
     * The tab body: the whole tool window.
     *
     * @param props - shell-injected `sessionId`, `useSessions`, `useTabInfo`.
     * @returns the panel element.
     */
    function GitReposBody(props) {
      const { sessionId, useSessions, useTabInfo } = props
      const tabInfo = typeof useTabInfo === 'function' ? useTabInfo() : undefined
      const visible = tabInfo?.tab?.visible !== false

      const sessionCwd = typeof useSessions === 'function'
        ? useSessions((sessions) => sessions?.byId?.[sessionId]?.cwd)
        : undefined

      const [root, setRoot] = React.useState(null)
      const [rootPinned, setRootPinned] = React.useState(null)
      const [roots, setRoots] = React.useState([])
      const [health, setHealth] = React.useState(null)
      const [list, setList] = React.useState(null)
      const [listLoading, setListLoading] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [notice, setNotice] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [activeRoot, setActiveRoot] = React.useState(null)
      const [tab, setTab] = React.useState('changes')
      const [detail, setDetail] = React.useState(null)
      const [commits, setCommits] = React.useState([])
      const [diff, setDiff] = React.useState(null)
      const [commitMessage, setCommitMessage] = React.useState('')
      const [newBranch, setNewBranch] = React.useState('')
      const [mrs, setMrs] = React.useState(null)
      const [pipelines, setPipelines] = React.useState(null)
      const [scanCollapsed, setScanCollapsed] = React.useState(prefs('scanCollapsed') === '1')
      const [interval, setIntervalSeconds] = React.useState(Number(prefs('interval') ?? 10))
      const [showSettings, setShowSettings] = React.useState(false)

      const stateRef = React.useRef({})
      stateRef.current = { root, activeRoot, busy, tab, visible }

      // The session directory is the default root; a manual pick wins until the
      // session itself changes.
      React.useEffect(() => {
        if (rootPinned) return
        if (typeof sessionCwd === 'string' && sessionCwd !== '') setRoot(sessionCwd)
      }, [sessionCwd, rootPinned])

      React.useEffect(() => {
        setRootPinned(null)
        setActiveRoot(null)
        setList(null)
        setDiff(null)
      }, [sessionId])

      // Boot facts: allowed roots and the token state.
      React.useEffect(() => {
        let alive = true
        rpc('health', {}).then((value) => { if (alive) setHealth(value) }).catch(() => {})
        rpc('workspaces', {}).then((value) => { if (alive) setRoots(asArray(value.workspaces)) }).catch(() => {})
        return () => { alive = false }
      }, [])

      /** Reload the repository list; returns the fresh rows. */
      const loadList = React.useCallback(async (target, { quiet = false } = {}) => {
        if (!target) return null
        if (!quiet) setListLoading(true)
        try {
          const value = await rpc('repos.list', { root: target })
          setList(value)
          setError(null)
          return value
        } catch (failure) {
          setError(failure.message)
          return null
        } finally {
          if (!quiet) setListLoading(false)
        }
      }, [])

      /** Reload the selected repository's detail. */
      const loadDetail = React.useCallback(async (target, { quiet = false } = {}) => {
        if (!target) return
        try {
          const [state, branchRows, history, remoteRows, worktreeRows, stashRows] = await Promise.all([
            rpc('repo.status', { root: target }),
            rpc('repo.branches', { root: target }),
            rpc('repo.log', { root: target, limit: 60 }),
            rpc('repo.remotes', { root: target }),
            rpc('repo.worktrees', { root: target }),
            rpc('repo.stashes', { root: target }),
          ])
          const unpacked = unpackDetail({
            status: state,
            branches: branchRows,
            history,
            remotes: remoteRows,
            worktrees: worktreeRows,
            stashes: stashRows,
          })
          setDetail(unpacked.detail)
          setCommits(unpacked.commits)
          if (!quiet) setError(null)
        } catch (failure) {
          setError(failure.message)
        }
      }, [])

      React.useEffect(() => {
        if (!root) return undefined
        void loadList(root)
        return undefined
      }, [root, loadList])

      React.useEffect(() => {
        if (!list || activeRoot) return
        const rows = asArray(list.repos)
        if (rows.length > 0) setActiveRoot(rows[0].root)
      }, [list, activeRoot])

      React.useEffect(() => {
        setDiff(null)
        setMrs(null)
        setPipelines(null)
        setCommitMessage('')
        if (activeRoot) void loadDetail(activeRoot)
      }, [activeRoot, loadDetail])

      // Quiet polling: the list always, the open repository only while visible.
      React.useEffect(() => {
        if (!root || !visible) return undefined
        const seconds = Math.max(MIN_REFRESH, Math.min(MAX_REFRESH, Number(interval) || 10))
        const timer = window.setInterval(() => {
          const snapshot = stateRef.current
          if (snapshot.busy) return
          void loadList(snapshot.root, { quiet: true })
          if (snapshot.activeRoot && snapshot.tab !== 'diff') void loadDetail(snapshot.activeRoot, { quiet: true })
        }, seconds * 1000)
        return () => window.clearInterval(timer)
      }, [root, interval, visible, loadList, loadDetail])

      React.useEffect(() => { prefs('interval', interval) }, [interval])
      React.useEffect(() => { prefs('scanCollapsed', scanCollapsed ? '1' : '0') }, [scanCollapsed])

      /** Run one guarded action, surfacing failures and refreshing after. */
      const act = React.useCallback(async (label, fn) => {
        const snapshot = stateRef.current
        setBusy(label)
        setError(null)
        setNotice(null)
        try {
          const result = await fn()
          setNotice(`${label} 完成`)
          if (snapshot.activeRoot) await loadDetail(snapshot.activeRoot, { quiet: true })
          if (snapshot.root) await loadList(snapshot.root, { quiet: true })
          setDiff(null)
          return result
        } catch (failure) {
          setError(`${label} 失败：${failure.message}`)
          return null
        } finally {
          setBusy(null)
        }
      }, [loadDetail, loadList])

      const repos = asArray(list?.repos)
      const activeRepo = repos.find((row) => row.root === activeRoot) ?? null
      const gitlabRemote = asArray(detail?.remotes).find((row) => row.described?.gitlab) ?? null

      /** Load GitLab facts for the open repository. */
      const loadGitlab = React.useCallback(async () => {
        if (!gitlabRemote || !health?.gitlab?.tokenConfigured) return
        const described = gitlabRemote.described
        const branch = detail?.status?.branch
        setBusy('读取 GitLab')
        try {
          const [mrResult, pipelineResult] = await Promise.all([
            rpc('gitlab.mrs', { host: described.host, project: described.project, sourceBranch: branch || undefined, state: 'opened' }),
            rpc('gitlab.pipelines', { host: described.host, project: described.project, ref: branch || described.project.split('/').pop(), limit: 5 }),
          ])
          setMrs(mrResult)
          setPipelines(pipelineResult)
          setError(null)
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(null)
        }
      }, [gitlabRemote, health, detail])

      /* ── render ───────────────────────────────────────────────────────────── */

      const header = h('div', { className: 'gr-toolbar' }, [
        h(Glyph, { key: 'i', path: P.repo, size: 14 }),
        h('select', {
          key: 'root',
          className: 'gr-input gr-grow',
          style: { height: 24, padding: '0 4px' },
          value: root ?? '',
          onChange: (event) => { setRootPinned(event.target.value || null); setRoot(event.target.value); setActiveRoot(null) },
          title: '工作目录',
        }, [
          ...(root && !roots.some((row) => row.path === root)
            ? [h('option', { key: 'session', value: root }, `会话目录 · ${root}`)]
            : []),
          ...roots.map((row) => h('option', { key: row.id ?? row.path, value: row.path }, `${row.title ?? row.path}`)),
        ]),
        h(Btn, {
          key: 'refresh', icon: P.refresh, title: '刷新', disabled: Boolean(busy),
          onClick: () => { void loadList(root, { quiet: false }); if (activeRoot) void loadDetail(activeRoot) },
        }),
        h(Btn, {
          key: 'fetchall', icon: P.down, title: '全部抓取 (fetch all)', disabled: Boolean(busy) || repos.length === 0,
          onClick: () => act('全部抓取', () => rpc('repo.fetchAll', { roots: repos.map((row) => row.root) }), { refreshList: true }),
        }),
        h(Btn, {
          key: 'settings', icon: P.settings, title: '设置', variant: showSettings ? 'primary' : undefined,
          onClick: () => setShowSettings((value) => !value),
        }),
      ])

      const settingsBar = showSettings ? h('div', { className: 'gr-section', style: { borderBottom: '1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.14))' } }, [
        h('div', { className: 'gr-row', key: 'interval' }, [
          h('span', { className: 'gr-kvKey' }, '自动刷新'),
          h('input', {
            type: 'range', min: MIN_REFRESH, max: MAX_REFRESH, step: 1, value: interval,
            style: { flex: 1 },
            onChange: (event) => setIntervalSeconds(Number(event.target.value)),
          }),
          h('span', { className: 'gr-mono gr-dim' }, `${interval}s`),
        ]),
        h('div', { className: 'gr-kv', key: 'token' }, [
          h('span', { className: 'gr-kvKey' }, 'GitLab'),
          h('span', { className: 'gr-dim' }, health?.gitlab?.tokenConfigured
            ? '已配置访问令牌，可读取 MR 与流水线'
            : '未配置令牌：仍可显示仓库、分支与链接，MR/流水线需令牌'),
        ]),
        h('div', { className: 'gr-kv', key: 'roots' }, [
          h('span', { className: 'gr-kvKey' }, '允许的根'),
          h('span', { className: 'gr-mono gr-dim gr-ellipsis', title: asArray(health?.roots).join('\n') },
            asArray(health?.roots).join('  ·  ') || '（无）'),
        ]),
        h('div', { className: 'gr-kv', key: 'hosts' }, [
          h('span', { className: 'gr-kvKey' }, 'GitLab 主机'),
          h('span', { className: 'gr-mono gr-dim' }, asArray(health?.gitlab?.hosts).join(', ') || '（自动识别含 gitlab 的主机）'),
        ]),
      ]) : null

      const banners = [
        error ? h('div', { className: 'gr-banner gr-banner--error', key: 'e' }, [
          h(Glyph, { path: P.warn, key: 'i' }),
          h('span', { className: 'gr-grow', style: { overflowWrap: 'anywhere' } }, error),
          h(Btn, { icon: P.minus, title: '关闭', variant: 'ghost', onClick: () => setError(null) }),
        ]) : null,
        notice ? h('div', { className: 'gr-banner gr-banner--notice', key: 'n' }, [
          h(Glyph, { path: P.check, key: 'i' }),
          h('span', { className: 'gr-grow' }, notice),
          h(Btn, { icon: P.minus, title: '关闭', variant: 'ghost', onClick: () => setNotice(null) }),
        ]) : null,
      ]

      const scanHead = h('div', { className: 'gr-scanHead' }, [
        h(Btn, {
          icon: P.chevron,
          title: scanCollapsed ? '展开仓库列表' : '折叠仓库列表',
          variant: 'ghost',
          rotate: scanCollapsed ? 0 : 90,
          onClick: () => setScanCollapsed((value) => !value),
          key: 'toggle',
        }),
        h('span', { key: 'title', style: { fontWeight: 600 } }, '仓库'),
        h('span', { key: 'count', className: 'gr-count' }, `${repos.length}${list?.truncated ? '+' : ''}`),
        h('span', { key: 'spacer', className: 'gr-grow' }),
        busy ? h(Glyph, { key: 'busy', path: P.refresh, spin: true }) : null,
        listLoading ? h('span', { key: 'load', className: 'gr-dim' }, '扫描中…') : null,
        h('span', {
          key: 'when', className: 'gr-dim gr-mono',
          title: list?.generatedAt ?? '',
        }, list?.generatedAt ? new Date(list.generatedAt).toLocaleTimeString() : ''),
      ])

      const scanList = repos.length === 0
        ? [h('div', { className: 'gr-empty', key: 'empty' }, [
          h(Glyph, { path: P.repo, size: 20, key: 'i' }),
          h('span', { key: 't' }, root ? '这个目录下没有 Git 仓库' : '等待会话工作目录…'),
          root ? h('div', { key: 'p', className: 'gr-mono gr-dim', style: { overflowWrap: 'anywhere' } }, root) : null,
          root ? h(Btn, {
            key: 'init', icon: P.plus, label: '在此初始化仓库',
            onClick: () => act('初始化仓库', async () => {
              await rpc('repo.init', { root })
              const fresh = await loadList(root)
              const first = asArray(fresh?.repos)[0]
              if (first) setActiveRoot(first.root)
            }),
          }) : null,
        ])]
        : repos.map((row) => {
          const letter = row.error ? 'bad' : row.clean ? '' : 'dirty'
          return h('div', {
            key: row.root,
            className: 'gr-repo',
            'data-active': String(row.root === activeRoot),
            onClick: () => setActiveRoot(row.root),
            title: row.root,
          }, [
            h('span', { key: 'dot', className: `gr-dot${letter ? ` gr-dot--${letter}` : ''}` }),
            h('span', { key: 'name', className: 'gr-repoName gr-ellipsis' }, row.relPath === '.' ? row.name : row.relPath),
            h('span', { key: 'spacer', className: 'gr-grow' }),
            row.error ? h('span', { key: 'err', className: 'gr-chip', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '错误') : null,
            row.branch ? h('span', { key: 'b', className: 'gr-chip gr-chip--branch' }, [
              h(Glyph, { path: P.branch, size: 10, key: 'i' }),
              h('span', { className: 'gr-ellipsis' }, row.branch || '(detached)'),
            ]) : null,
            row.ahead ? h('span', { key: 'a', className: 'gr-chip gr-chip--ahead' }, `↑${row.ahead}`) : null,
            row.behind ? h('span', { key: 'be', className: 'gr-chip gr-chip--behind' }, `↓${row.behind}`) : null,
            !row.clean && row.counts ? h('span', { key: 'c', className: 'gr-count' }, `${row.counts.changed}`) : null,
            asArray(row.remotes).some((remote) => remote.hosting === 'gitlab')
              ? h('span', { key: 'gl', className: 'gr-chip gr-chip--gl' }, 'GL') : null,
            h('span', { key: 'actions', className: 'gr-repoActions' }, [
              h(Btn, {
                key: 'fetch', icon: P.down, title: '抓取', variant: 'ghost',
                onClick: (event) => { event.stopPropagation(); void act('抓取', () => rpc('repo.fetch', { root: row.root })) },
              }),
              h(Btn, {
                key: 'pull', icon: P.sync, title: '拉取 (fast-forward only)', variant: 'ghost',
                onClick: (event) => { event.stopPropagation(); void act('拉取', () => rpc('repo.pull', { root: row.root })) },
              }),
              h(Btn, {
                key: 'push', icon: P.up, title: '推送', variant: 'ghost',
                onClick: (event) => { event.stopPropagation(); void act('推送', () => rpc('repo.push', { root: row.root })) },
              }),
            ]),
          ])
        })

      // Two different kinds of "short", told apart on purpose:
      // - the depth boundary is policy, and normal on a deep tree → a caption;
      // - an exhausted directory budget is the safety valve tripping, which
      //   can stop the scan mid-tree → a warning.
      // Either way the list never just looks empty for no stated reason.
      const discovery = list?.discovery
      const scanHint = discovery?.entryLimited
        ? h('div', {
          className: 'gr-scanHint',
          key: 'budget',
          title: `本次扫描访问了 ${discovery.visited} 个目录`,
        }, [
          h(Glyph, { path: P.warn, size: 12, key: 'i' }),
          h('span', { key: 't' }, `扫描提前结束：目录数达到 ${discovery.maxEntries} 上限，可能有仓库未列出（可调大插件配置 discover.maxEntries）`),
        ])
        : discovery?.depthLimited
          ? h('div', {
            className: 'gr-scanNote',
            key: 'depth',
            title: `本次扫描访问了 ${discovery.visited} 个目录；调大插件配置 discover.maxDepth 可继续下钻`,
          }, `已扫描 ${discovery.maxDepth} 层，更深的目录未展开`)
          : null

      const scan = h('div', { className: `gr-scan${scanCollapsed ? ' gr-scan--collapsed' : ''}` }, [scanHead, scanHint, ...scanList])

      /* detail */
      const detailHeader = activeRepo ? h('div', { className: 'gr-detailHead' }, [
        h('div', { className: 'gr-row', key: 'top' }, [
          h(Glyph, { path: P.repo, size: 13, key: 'i' }),
          h('span', { key: 'name', className: 'gr-ellipsis', style: { fontWeight: 600 }, title: activeRepo.root },
            activeRepo.relPath === '.' ? activeRepo.name : activeRepo.relPath),
          h('span', { key: 'spacer', className: 'gr-grow' }),
          h(Btn, {
            key: 'reveal', icon: P.external, title: '在文件树中打开',
            variant: 'ghost',
            onClick: () => {
              const actions = tabInfo?.tab?.actions
              if (actions?.openTab) actions.openTab('files')
              else if (actions?.openResource && sessionId) {
                actions.openResource(`dsh-resource://file/session/${encodeURIComponent(sessionId)}/${encodeURIComponent(activeRepo.relPath === '.' ? '.' : activeRepo.relPath)}`)
              }
            },
          }),
        ]),
        h('div', { className: 'gr-row', key: 'meta' }, [
          h('span', { className: 'gr-chip gr-chip--branch' }, [
            h(Glyph, { path: P.branch, size: 10, key: 'i' }),
            h('span', { className: 'gr-ellipsis' }, detail?.status?.detached ? 'detached HEAD' : (detail?.status?.branch || '(无提交)')),
          ]),
          detail?.status?.upstream ? h('span', { key: 'u', className: 'gr-mono gr-dim gr-ellipsis', title: detail.status.upstream }, detail.status.upstream) : h('span', { key: 'u', className: 'gr-dim' }, '未设置上游'),
          detail?.status?.ahead ? h('span', { key: 'a', className: 'gr-chip gr-chip--ahead' }, `↑${detail.status.ahead}`) : null,
          detail?.status?.behind ? h('span', { key: 'b', className: 'gr-chip gr-chip--behind' }, `↓${detail.status.behind}`) : null,
          detail?.status?.counts?.conflicted ? h('span', { key: 'c', className: 'gr-chip', style: { color: 'var(--dsw-alias-state-error-primary)' } }, `冲突 ${detail.status.counts.conflicted}`) : null,
        ]),
        h('div', { className: 'gr-row', key: 'act' }, [
          h(Btn, { icon: P.down, label: '抓取', disabled: Boolean(busy), onClick: () => act('抓取', () => rpc('repo.fetch', { root: activeRoot })) }),
          h(Btn, {
            icon: P.sync, label: '拉取', disabled: Boolean(busy),
            onClick: () => act('拉取', () => rpc('repo.pull', { root: activeRoot })),
          }),
          h(Btn, {
            icon: P.up, label: detail?.status?.upstream ? '推送' : '发布分支', disabled: Boolean(busy),
            variant: 'primary',
            onClick: () => act('推送', () => rpc('repo.push', {
              root: activeRoot,
              setUpstream: !detail?.status?.upstream,
            })),
          }),
          h('span', { key: 'spacer', className: 'gr-grow' }),
          h(Btn, {
            icon: P.stash, title: '暂存全部改动 (stash)', disabled: Boolean(busy) || detail?.status?.clean,
            onClick: () => act('暂存改动', () => rpc('repo.stashPush', { root: activeRoot, includeUntracked: true })),
          }),
        ]),
      ]) : null

      const tabs = [
        { id: 'changes', label: '变更', count: detail?.status?.counts?.changed },
        { id: 'history', label: '历史' },
        { id: 'branches', label: '分支', count: detail?.branches?.local?.length },
        { id: 'remotes', label: '远程', count: detail?.remotes?.length },
        { id: 'gitlab', label: 'GitLab' },
      ]

      const tabStrip = activeRepo ? h('div', { className: 'gr-tabs' }, tabs.map((row) => h('button', {
        key: row.id,
        type: 'button',
        className: 'gr-tab',
        'data-active': String(tab === row.id || (row.id === 'changes' && tab === 'diff')),
        onClick: () => { setTab(row.id); setDiff(null) },
      }, [
        h('span', { key: 'l' }, row.label),
        row.count ? h('span', { key: 'c', className: 'gr-count' }, String(row.count)) : null,
      ]))) : null

      const changesTab = h('div', { className: 'gr-content' }, [
        (detail?.status?.counts?.conflicted ?? 0) > 0
          ? h('div', { className: 'gr-banner gr-banner--error', key: 'conflict' }, [
            h(Glyph, { path: P.warn, key: 'i' }),
            h('span', { key: 't' }, `有 ${detail.status.counts.conflicted} 个文件存在冲突，先解决后再提交`),
          ])
          : null,
        ...renderChanges({
          status: detail?.status,
          activePath: diff?.path,
          busy,
          onOpen: async (entry, staged) => {
            const untracked = entry.untracked === true
            setTab('diff')
            setDiff({ path: entry.path, staged, untracked, loading: true, text: '' })
            try {
              const result = await rpc('repo.diff', { root: activeRoot, path: entry.path, staged, untracked })
              setDiff({ path: entry.path, staged, untracked, text: result.text, empty: result.empty })
            } catch (failure) {
              setError(`读取差异失败：${failure.message}`)
              setDiff(null)
            }
          },
          onStage: (paths) => act('暂存', () => rpc('repo.stage', { root: activeRoot, paths })),
          onUnstage: (paths) => act('取消暂存', () => rpc('repo.unstage', { root: activeRoot, paths })),
          onDiscard: (entry) => {
            const isUntracked = entry.untracked === true
            const ok = window.confirm(isUntracked
              ? `删除未跟踪文件 ${entry.path}？此操作不可撤销。`
              : `放弃 ${entry.path} 的未提交改动？此操作不可撤销。`)
            if (!ok) return
            void act('放弃改动', () => rpc('repo.discard', {
              root: activeRoot,
              paths: [entry.path],
              staged: entry.staged === true && !isUntracked,
              includeUntracked: isUntracked,
              untracked: isUntracked ? [entry.path] : [],
            }))
          },
        }),
        h('div', { className: 'gr-commit', key: 'commit' }, [
          h('div', { className: 'gr-row', key: 'tools' }, [
            h(Btn, {
              key: 'all', icon: P.plus, label: '全部暂存', disabled: Boolean(busy) || (detail?.status?.counts?.changed ?? 0) === 0,
              onClick: () => act('暂存全部', () => rpc('repo.stage', { root: activeRoot, paths: [] })),
            }),
            h(Btn, {
              key: 'none', icon: P.minus, label: '全部取消', disabled: Boolean(busy) || (detail?.status?.counts?.staged ?? 0) === 0,
              onClick: () => act('取消全部暂存', () => rpc('repo.unstage', { root: activeRoot, paths: [] })),
            }),
            h('span', { key: 'spacer', className: 'gr-grow' }),
            h('span', { key: 'hint', className: 'gr-dim' }, '⌘/Ctrl+Enter 提交'),
          ]),
          h('textarea', {
            key: 'message',
            className: 'gr-textarea',
            placeholder: '提交信息',
            value: commitMessage,
            onChange: (event) => setCommitMessage(event.target.value),
            onKeyDown: (event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault()
                void doCommit()
              }
            },
          }),
          h('div', { className: 'gr-row', key: 'go' }, [
            h(Btn, {
              icon: P.commit, label: '提交暂存的更改', variant: 'primary',
              disabled: Boolean(busy) || commitMessage.trim() === '' || (detail?.status?.counts?.staged ?? 0) === 0,
              onClick: () => void doCommit(),
            }),
            h('span', { key: 'spacer', className: 'gr-grow' }),
            h('span', { key: 'stagedCount', className: 'gr-dim' }, `已暂存 ${detail?.status?.counts?.staged ?? 0}`),
          ]),
        ]),
        ...asArray(detail?.stashes).length > 0 ? [h('div', { className: 'gr-section', key: 'stash' }, [
          h('div', { className: 'gr-sectionTitle' }, [h(Glyph, { path: P.stash, key: 'i', size: 11 }), h('span', { key: 't' }, `Stash (${detail.stashes.length})`)]),
          ...detail.stashes.map((row) => h('div', { className: 'gr-row', key: row.ref, style: { padding: '2px 0' } }, [
            h('span', { key: 'r', className: 'gr-mono gr-dim' }, row.ref),
            h('span', { key: 's', className: 'gr-grow gr-ellipsis', title: row.subject }, row.subject),
            h(Btn, { key: 'pop', icon: P.up, title: '恢复 (pop)', variant: 'ghost', disabled: Boolean(busy), onClick: () => act('恢复 stash', () => rpc('repo.stashPop', { root: activeRoot, index: Number(/stash@\{(\d+)\}/.exec(row.ref)?.[1] ?? 0) })) }),
            h(Btn, { key: 'drop', icon: P.undo, title: '丢弃', variant: 'ghost', disabled: Boolean(busy), onClick: () => {
              if (window.confirm(`丢弃 ${row.ref}？`)) void act('丢弃 stash', () => rpc('repo.stashDrop', { root: activeRoot, index: Number(/stash@\{(\d+)\}/.exec(row.ref)?.[1] ?? 0) }))
            } }),
          ])),
        ])] : [],
      ])

      /** Commit the index with the current message. */
      async function doCommit() {
        const message = commitMessage.trim()
        if (message === '') return
        await act('提交', () => rpc('repo.commit', { root: activeRoot, message }), { refreshList: true })
        setCommitMessage('')
      }

      const diffView = diff ? h('div', { className: 'gr-diff' }, [
        h('div', { className: 'gr-diffHead', key: 'head' }, [
          h(Btn, { icon: P.back, title: '返回变更列表', variant: 'ghost', onClick: () => { setDiff(null); setTab('changes') } }),
          h('span', { key: 'p', className: 'gr-mono gr-ellipsis gr-grow', title: diff.path }, diff.path),
          h('span', { key: 'k', className: 'gr-chip' }, diff.untracked ? '未跟踪' : (diff.staged ? '已暂存' : '工作区')),
        ]),
        diff.loading
          ? h('div', { className: 'gr-empty', key: 'load' }, '读取差异…')
          : diff.empty
            ? h('div', { className: 'gr-empty', key: 'empty' }, '无差异')
            : h('div', { className: 'gr-diffBody', key: 'body' }, renderDiff(diff.text)),
      ]) : null

      const historyTab = h('div', { className: 'gr-content' }, [
        ...commits.map((commit) => h('div', {
          key: commit.hash,
          className: 'gr-logRow',
          onClick: async () => {
            setTab('diff')
            setDiff({ path: commit.short, commit: commit.hash, loading: true, text: '' })
            try {
              const result = await rpc('repo.diff', { root: activeRoot, commit: commit.hash })
              setDiff({ path: `${commit.short} ${commit.subject}`, commit: commit.hash, text: result.text, empty: result.empty })
            } catch (failure) {
              setError(`读取提交差异失败：${failure.message}`)
              setDiff(null)
            }
          },
        }, [
          h('div', { className: 'gr-rail', key: 'r' }, h('span', { className: 'gr-node' })),
          h('div', { className: 'gr-grow', key: 'c', style: { minWidth: 0 } }, [
            h('div', { className: 'gr-row', key: 'l1' }, [
              ...commit.refs.slice(0, 3).map((ref) => h('span', { key: ref, className: 'gr-ref' }, ref)),
              h('span', { key: 's', className: 'gr-ellipsis' }, commit.subject),
            ]),
            h('div', { className: 'gr-row gr-dim', key: 'l2', style: { gap: 8 } }, [
              h('span', { key: 'sha', className: 'gr-mono' }, commit.short),
              h('span', { key: 'a', className: 'gr-ellipsis' }, commit.author),
              h('span', { key: 'd', className: 'gr-mono' }, formatDate(commit.date)),
            ]),
          ]),
        ])),
        commits.length === 0 ? h('div', { className: 'gr-empty', key: 'e' }, '还没有提交') : null,
        commits.length > 0 ? h('div', { className: 'gr-section', key: 'more' }, h(Btn, {
          icon: P.history, label: '加载更多',
          onClick: async () => {
            try {
              const more = await rpc('repo.log', { root: activeRoot, limit: 60, skip: commits.length })
              setCommits((rows) => [...asArray(rows), ...asArray(more?.commits)])
            } catch (failure) {
              setError(failure.message)
            }
          },
        })) : null,
      ])

      const branchesTab = h('div', { className: 'gr-content' }, [
        h('div', { className: 'gr-section', key: 'new' }, [
          h('div', { className: 'gr-sectionTitle' }, '新建分支'),
          h('div', { className: 'gr-split' }, [
            h('input', {
              className: 'gr-input', placeholder: 'feature/…', value: newBranch,
              onChange: (event) => setNewBranch(event.target.value),
              onKeyDown: (event) => { if (event.key === 'Enter') void createBranch() },
            }),
            h(Btn, {
              icon: P.plus, label: '创建并切换', disabled: Boolean(busy) || newBranch.trim() === '',
              onClick: () => void createBranch(),
            }),
          ]),
        ]),
        h('div', { className: 'gr-section', key: 'local' }, [
          h('div', { className: 'gr-sectionTitle' }, `本地分支 (${detail?.branches?.local?.length ?? 0})`),
          ...asArray(detail?.branches?.local).map((row) => h('div', { className: 'gr-row', key: row.name, style: { padding: '3px 0' } }, [
            h(Glyph, { key: 'i', path: P.branch, size: 12 }),
            h('span', { key: 'n', className: 'gr-grow gr-ellipsis', style: { fontWeight: row.current ? 600 : 400 } }, row.name),
            row.ahead ? h('span', { key: 'a', className: 'gr-chip gr-chip--ahead' }, `↑${row.ahead}`) : null,
            row.behind ? h('span', { key: 'b', className: 'gr-chip gr-chip--behind' }, `↓${row.behind}`) : null,
            row.gone ? h('span', { key: 'g', className: 'gr-chip', style: { color: 'var(--dsw-alias-state-warn-primary)' } }, '上游已删除') : null,
            row.current
              ? h('span', { key: 'c', className: 'gr-chip' }, '当前')
              : h(Btn, {
                key: 'sw', icon: P.check, title: '切换到此分支', variant: 'ghost', disabled: Boolean(busy),
                onClick: () => act('切换分支', () => rpc('repo.checkout', { root: activeRoot, branch: row.name }), { refreshList: true }),
              }),
            !row.current ? h(Btn, {
              key: 'del', icon: P.undo, title: '删除分支', variant: 'ghost', disabled: Boolean(busy),
              onClick: () => { if (window.confirm(`删除分支 ${row.name}？`)) void act('删除分支', () => rpc('repo.branchDelete', { root: activeRoot, branch: row.name })) },
            }) : null,
          ])),
        ]),
        h('div', { className: 'gr-section', key: 'remote' }, [
          h('div', { className: 'gr-sectionTitle' }, `远程分支 (${detail?.branches?.remote?.length ?? 0})`),
          ...asArray(detail?.branches?.remote).slice(0, 80).map((row) => h('div', { className: 'gr-row', key: row.name, style: { padding: '2px 0' } }, [
            h('span', { key: 'n', className: 'gr-grow gr-ellipsis gr-mono gr-dim' }, row.name),
            h(Btn, {
              key: 'co', icon: P.check, title: '检出此远程分支', variant: 'ghost', disabled: Boolean(busy),
              onClick: () => act('检出远程分支', () => rpc('repo.checkout', {
                root: activeRoot,
                branch: row.name.replace(/^[^/]+\//, ''),
                create: true,
                startPoint: row.name,
              }), { refreshList: true }),
            }),
          ])),
        ]),
        h('div', { className: 'gr-section', key: 'wt' }, [
          h('div', { className: 'gr-sectionTitle' }, [h(Glyph, { path: P.worktree, key: 'i', size: 11 }), h('span', { key: 't' }, `Worktrees (${detail?.worktrees?.length ?? 0})`)]),
          ...asArray(detail?.worktrees).map((row) => h('div', { className: 'gr-row', key: row.path, style: { padding: '2px 0' } }, [
            h('span', { key: 'b', className: 'gr-chip gr-chip--branch' }, row.branch ?? 'detached'),
            h('span', { key: 'p', className: 'gr-mono gr-dim gr-grow gr-ellipsis', title: row.path }, row.path),
            row.path === activeRoot ? h('span', { key: 'c', className: 'gr-dim' }, '当前') : null,
          ])),
        ]),
      ])

      /** Create the branch named in the input and switch to it. */
      async function createBranch() {
        const name = newBranch.trim()
        if (name === '') return
        const result = await act('新建分支', () => rpc('repo.checkout', { root: activeRoot, branch: name, create: true }), { refreshList: true })
        if (result !== null) setNewBranch('')
      }

      const remotesTab = h('div', { className: 'gr-content' }, asArray(detail?.remotes).length === 0
        ? [h('div', { className: 'gr-empty', key: 'e' }, '这个仓库还没有远程地址')]
        : asArray(detail?.remotes).map((row) => {
          const described = row.described ?? {}
          const branch = detail?.status?.branch
          return h('div', { className: 'gr-section', key: row.name, style: { borderBottom: '1px solid var(--dsw-alias-border-l1,rgba(127,127,127,.12))' } }, [
            h('div', { className: 'gr-row', key: 'h' }, [
              h(Glyph, { path: P.remote, size: 12, key: 'i' }),
              h('span', { key: 'n', style: { fontWeight: 600 } }, row.name),
              described.gitlab ? h('span', { key: 'gl', className: 'gr-chip gr-chip--gl' }, 'GitLab') : h('span', { key: 'o', className: 'gr-chip' }, described.local ? '本地' : '其他'),
            ]),
            h('div', { key: 'u', className: 'gr-mono gr-dim', style: { overflowWrap: 'anywhere', marginTop: 2 } }, row.fetch ?? row.push ?? ''),
            described.project ? h('div', { key: 'p', className: 'gr-mono gr-dim' }, `${described.host}/${described.project}`) : null,
            described.gitlab ? h('div', { className: 'gr-row', key: 'links', style: { flexWrap: 'wrap', marginTop: 4 } }, [
              externalLink('仓库', gitlabUrl(described, 'repository')),
              externalLink('分支', gitlabUrl(described, 'tree', branch)),
              externalLink('提交', gitlabUrl(described, 'commits', branch)),
              externalLink('合并请求', gitlabUrl(described, 'merge-requests', branch)),
              externalLink('新建 MR', gitlabUrl(described, 'new-merge-request', branch)),
              externalLink('流水线', gitlabUrl(described, 'pipelines', branch)),
            ]) : null,
            h('div', { className: 'gr-row', key: 'act', style: { marginTop: 5 } }, [
              h(Btn, { key: 'f', icon: P.down, label: '抓取', disabled: Boolean(busy), onClick: () => act('抓取', () => rpc('repo.fetch', { root: activeRoot, remote: row.name })) }),
              h(Btn, {
                key: 'pu', icon: P.up, label: '推送到此远程', disabled: Boolean(busy) || !branch,
                onClick: () => act('推送', () => rpc('repo.push', { root: activeRoot, remote: row.name, branch, setUpstream: true })),
              }),
              h(Btn, {
                key: 'up', icon: P.sync, label: '设为上游', disabled: Boolean(busy) || !branch,
                onClick: () => act('设置上游', () => rpc('repo.push', { root: activeRoot, remote: row.name, branch, setUpstream: true })),
              }),
            ]),
          ])
        }))

      const gitlabTab = h('div', { className: 'gr-content' }, [
        !health?.gitlab?.tokenConfigured
          ? h('div', { className: 'gr-section', key: 'notoken' }, [
            h('div', { className: 'gr-sectionTitle' }, '尚未配置 GitLab 令牌'),
            h('div', { className: 'gr-dim', style: { lineHeight: 1.6 } }, [
              h('div', { key: 'a' }, '仓库列表、分支、差异与跳转链接不需要令牌。'),
              h('div', { key: 'b' }, '要在这里直接查看合并请求与流水线，请任选一种方式提供只读令牌：'),
              h('div', { key: 'c', className: 'gr-mono', style: { marginTop: 4 } }, 'export GITLAB_TOKEN=glpat-…'),
              h('div', { key: 'd', className: 'gr-mono' }, '或写进 ~/.dsh/settings.yaml 的 git-repos.gitlabToken'),
            ]),
          ])
          : null,
        gitlabRemote ? h('div', { className: 'gr-section', key: 'proj' }, [
          h('div', { className: 'gr-sectionTitle' }, `GitLab · ${gitlabRemote.described.host}/${gitlabRemote.described.project}`),
          h('div', { className: 'gr-row' }, h(Btn, {
            icon: P.refresh, label: '读取 MR / 流水线', disabled: Boolean(busy) || !health?.gitlab?.tokenConfigured,
            onClick: () => void loadGitlab(),
          })),
        ]) : h('div', { className: 'gr-empty', key: 'nogl' }, [
          h(Glyph, { path: P.remote, size: 18, key: 'i' }),
          h('span', { key: 't' }, '这个仓库没有识别到 GitLab 远程'),
          h('span', { key: 'd', className: 'gr-dim' }, '自建实例可在插件配置的 gitlabHosts 里列出主机名'),
        ]),
        asArray(pipelines?.items).length ? h('div', { className: 'gr-section', key: 'pl' }, [
          h('div', { className: 'gr-sectionTitle' }, `流水线 · ${detail?.status?.branch ?? ''}`),
          ...asArray(pipelines?.items).map((row) => h('div', { className: 'gr-row', key: row.id, style: { padding: '2px 0' } }, [
            h('span', { key: 's', className: 'gr-chip', style: pipelineStyle(row.status) }, row.status),
            h('span', { key: 'i', className: 'gr-mono gr-dim' }, `#${row.id}`),
            h('span', { key: 'g', className: 'gr-grow' }),
            row.webUrl ? h('a', { key: 'l', className: 'gr-link', href: row.webUrl, target: '_blank', rel: 'noreferrer' }, '打开') : null,
          ])),
        ]) : null,
        pipelines && !pipelines.ok ? h('div', { className: 'gr-banner gr-banner--error', key: 'ple' }, [
          h(Glyph, { path: P.warn, key: 'i' }),
          h('span', { key: 't' }, `流水线读取失败：${pipelines.error}`),
        ]) : null,
        asArray(mrs?.items).length ? h('div', { className: 'gr-section', key: 'mrs' }, [
          h('div', { className: 'gr-sectionTitle' }, `打开的合并请求 (${asArray(mrs?.items).length})`),
          ...asArray(mrs?.items).map((row) => h('div', { className: 'gr-mr', key: row.iid }, [
            h('div', { className: 'gr-row' }, [
              h('span', { key: 'i', className: 'gr-mono gr-dim' }, `!${row.iid}`),
              h('a', { key: 't', className: 'gr-link gr-grow gr-ellipsis', href: row.webUrl, target: '_blank', rel: 'noreferrer', title: row.title }, row.title),
              row.draft ? h('span', { key: 'd', className: 'gr-chip' }, 'Draft') : null,
            ]),
            h('div', { className: 'gr-row gr-dim', key: 'm', style: { gap: 8 } }, [
              h('span', { key: 'b', className: 'gr-mono gr-ellipsis' }, `${row.sourceBranch} → ${row.targetBranch}`),
              h('span', { key: 'a' }, row.author ?? ''),
              row.hasConflicts ? h('span', { key: 'c', style: { color: 'var(--dsw-alias-state-error-primary)' } }, '有冲突') : null,
            ]),
          ])),
        ]) : null,
        mrs && !mrs.ok ? h('div', { className: 'gr-banner gr-banner--error', key: 'mre' }, [
          h(Glyph, { path: P.warn, key: 'i' }),
          h('span', { key: 't' }, `合并请求读取失败：${mrs.error}`),
        ]) : null,
        mrs?.ok && asArray(mrs?.items).length === 0 ? h('div', { className: 'gr-section gr-dim', key: 'nomerge' }, '当前分支没有打开的合并请求') : null,
      ])

      const content = !activeRepo
        ? h('div', { className: 'gr-empty' }, [
          h(Glyph, { path: P.branch, size: 20, key: 'i' }),
          h('span', { key: 't' }, repos.length === 0 ? '没有可管理的仓库' : '选择上面的仓库查看详情'),
        ])
        : tab === 'diff' ? (diffView ?? changesTab)
          : tab === 'history' ? historyTab
            : tab === 'branches' ? branchesTab
              : tab === 'remotes' ? remotesTab
                : tab === 'gitlab' ? gitlabTab
                  : changesTab

      return h('div', { className: 'gr-root' }, [
        header,
        settingsBar,
        ...banners,
        h('div', { className: 'gr-body', key: 'body' }, [
          scan,
          h('div', { className: 'gr-detail', key: 'detail' }, [detailHeader, tabStrip, content]),
        ]),
      ])
    }

    /* ── Change list rendering ──────────────────────────────────────────────── */

    /**
     * Build the grouped change list.
     *
     * @param options - `status`, `busy`, `activePath`, and the action callbacks.
     * @returns React children.
     */
    function renderChanges(options) {
      const { status, busy, activePath, onOpen, onStage, onUnstage, onDiscard } = options
      const entries = asArray(status?.entries)
      const conflicts = entries.filter((entry) => entry.conflicted)
      const staged = entries.filter((entry) => entry.staged && !entry.conflicted)
      const unstaged = entries.filter((entry) => (entry.unstaged || entry.untracked) && !entry.staged && !entry.conflicted)

      /** One file row. */
      const row = (entry, kind) => {
        const badge = statusLetter(entry)
        const parts = splitPath(entry.path)
        return h('div', {
          key: `${kind}:${entry.path}`,
          className: 'gr-file',
          'data-active': String(activePath === entry.path),
          onClick: () => onOpen(entry, kind === 'staged'),
          title: entry.path,
        }, [
          h('span', { key: 'st', className: `gr-st gr-st--${badge.cls}` }, badge.letter),
          h('span', { key: 'p', className: 'gr-mono gr-grow gr-ellipsis' }, [
            h('span', { key: 'd', className: 'gr-dim' }, parts.dir),
            h('span', { key: 'b' }, parts.base),
          ]),
          entry.origPath ? h('span', { key: 'o', className: 'gr-mono gr-dim gr-ellipsis' }, `← ${entry.origPath}`) : null,
          h('span', { key: 'a', className: 'gr-fileActions' }, kind === 'staged'
            ? [
              h(Btn, { key: 'u', icon: P.minus, title: '取消暂存', variant: 'ghost', disabled: Boolean(busy), onClick: (event) => { event.stopPropagation(); onUnstage([entry.path]) } }),
            ]
            : [
              h(Btn, { key: 's', icon: P.plus, title: '暂存', variant: 'ghost', disabled: Boolean(busy), onClick: (event) => { event.stopPropagation(); onStage([entry.path]) } }),
              h(Btn, { key: 'd', icon: P.undo, title: entry.untracked ? '删除未跟踪文件' : '放弃改动', variant: 'ghost', tone: 'danger', disabled: Boolean(busy), onClick: (event) => { event.stopPropagation(); onDiscard(entry) } }),
            ]),
        ])
      }

      const children = []
      if (conflicts.length > 0) {
        children.push(h('div', { className: 'gr-sectionTitle', key: 'tc' }, `冲突 (${conflicts.length})`))
        children.push(...conflicts.map((entry) => row(entry, 'unstaged')))
      }
      if (staged.length > 0) {
        children.push(h('div', { className: 'gr-sectionTitle', key: 'ts' }, `已暂存 (${staged.length})`))
        children.push(...staged.map((entry) => row(entry, 'staged')))
      }
      children.push(h('div', { className: 'gr-sectionTitle', key: 'tu' }, `未暂存 (${unstaged.length})`))
      if (unstaged.length > 0) children.push(...unstaged.map((entry) => row(entry, 'unstaged')))
      else if (entries.length === 0) children.push(h('div', { className: 'gr-empty', key: 'clean' }, '工作区是干净的'))
      return children
    }

    /**
     * Split a unified diff into coloured lines, capped.
     *
     * @param text - the diff body.
     * @returns React children.
     */
    function renderDiff(text) {
      const lines = String(text ?? '').split('\n')
      const cap = 4000
      const shown = lines.length > cap ? lines.slice(0, cap) : lines
      const children = shown.map((line, index) => h('span', {
        key: index,
        className: `gr-line ${diffLineClass(line)}`,
      }, line === '' ? ' ' : line))
      if (lines.length > cap) {
        children.push(h('span', { key: 'cap', className: 'gr-line gr-line--meta' }, `… 仅显示前 ${cap} 行（共 ${lines.length} 行）`))
      }
      return children
    }

    /**
     * A labelled external link, or nothing when the URL is unknown.
     *
     * @param label - anchor text.
     * @param url - target URL.
     * @returns the anchor element.
     */
    function externalLink(label, url) {
      if (!url) return null
      return h('a', {
        key: label, className: 'gr-link', href: url, target: '_blank', rel: 'noreferrer',
        style: { marginRight: 8, fontSize: 11.5, whiteSpace: 'nowrap' },
      }, label)
    }

    /**
     * Browser-side GitLab URL builder, mirroring the host's link shapes.
     *
     * @param described - hosting description from the host.
     * @param kind - page kind.
     * @param ref - branch or ref.
     * @returns the URL, or undefined.
     */
    function gitlabUrl(described, kind, ref) {
      if (!described?.webBase || !described?.project) return undefined
      const base = `${described.webBase}/${described.project}`
      const encoded = ref ? encodeURIComponent(ref) : undefined
      switch (kind) {
        case 'repository': return base
        case 'tree': return encoded ? `${base}/-/tree/${encoded}` : `${base}/-/tree`
        case 'commits': return encoded ? `${base}/-/commits/${encoded}` : `${base}/-/commits`
        case 'merge-requests': return encoded ? `${base}/-/merge_requests?scope=all&state=all&source_branch=${encoded}` : `${base}/-/merge_requests`
        case 'pipelines': return encoded ? `${base}/-/pipelines?ref=${encoded}` : `${base}/-/pipelines`
        case 'new-merge-request': {
          if (!encoded) return `${base}/-/merge_requests/new`
          return `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encoded}`
        }
        default: return base
      }
    }

    /**
     * Colour a pipeline status chip.
     *
     * @param status - GitLab status string.
     * @returns an inline style.
     */
    function pipelineStyle(status) {
      const value = String(status ?? '')
      if (['success', 'passed'].includes(value)) return { color: 'var(--dsw-alias-state-success-primary,#2f9e63)' }
      if (['failed', 'canceled'].includes(value)) return { color: 'var(--dsw-alias-state-error-primary,#d8503f)' }
      if (['running', 'pending', 'created'].includes(value)) return { color: 'var(--dsw-alias-state-business-primary,#3b6ef5)' }
      return undefined
    }

    /**
     * Render an ISO instant as a compact local date.
     *
     * @param iso - ISO-8601 string.
     * @returns `YYYY-MM-DD HH:MM`.
     */
    function formatDate(iso) {
      if (!iso) return ''
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return iso
      const pad = (value) => String(value).padStart(2, '0')
      return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    /**
     * The guide capsule glyph.
     *
     * @returns the svg element.
     */
    function GuideIcon() {
      return h(Glyph, { path: P.branch, size: 18 })
    }

    /* ── Registration ───────────────────────────────────────────────────────── */

    /**
     * Client plugin body: claim the tab type and its seat in the right sidebar.
     *
     * @param ctx - client root context carrying `sidebarRightTabs` and `slots`.
     */
    function apply(ctx) {
      const { sidebarRightTabs, slots } = ctx
      if (!sidebarRightTabs || !slots) return

      installStyles()

      ctx.effect(() => sidebarRightTabs.register({
        id: TAB_ID,
        kind: TAB_KIND,
        priority: 'extension',
        title: () => 'Git 仓库',
        guide: [{
          order: 22,
          title: () => 'Git 仓库',
          description: () => '多仓库状态、变更、分支、远程与 GitLab',
          icon: GuideIcon,
        }],
      }), 'dsh-git-repos: tab definition')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab', () => slots.register({
        name: 'sidebar.right.pane.tab',
        key: TAB_ID,
      }, GitReposBody)), 'dsh-git-repos: tab body')

      ctx.effect(() => slots.inject('sidebar.right.pane.tab.title', () => slots.register({
        name: 'sidebar.right.pane.tab.title',
        key: TAB_ID,
      }, () => h('span', { className: 'gr-row' }, [
        h(Glyph, { path: P.branch, size: 12, key: 'i' }),
        h('span', { key: 't' }, 'Git 仓库'),
      ]))), 'dsh-git-repos: tab title')
    }

    /** React, resolved from the shell's frozen module table. */
    exports.apply = apply
    exports.inject = inject
    exports.GitReposBody = GitReposBody
    exports.TAB_ID = TAB_ID
    exports.TAB_KIND = TAB_KIND
    /** Pure helpers, exported so `tools/client-check.mjs` can exercise them. */
    exports.internals = {
      asArray,
      unpackDetail,
      statusLetter,
      splitPath,
      diffLineClass,
      renderChanges,
      renderDiff,
      gitlabUrl,
      pipelineStyle,
      formatDate,
      shortPath,
    }
    return module.exports
  },
})
