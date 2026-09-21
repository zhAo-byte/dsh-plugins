/**
 * Browser half of `dsh-remote-control`: the editable configuration card.
 *
 * Hand-authored bundle, no bundler — the same shape as the sibling
 * `dsh-codex-bridge-client`, because this deployment ships no build step for
 * client packages. `window.__ModuleLoader__.load` plus a lazy CJS factory, and
 * only `require("react")`, which is in the shell's baseline module table.
 *
 * The card exists because configuration used to be a YAML file the operator had
 * to be told about. It renders one control per field of the `remote-control`
 * settings namespace, stages edits locally, and writes them only on save — the
 * settings write is a durable revision-fenced document mutation, so committing as
 * each field settled would turn one edit into writes the user never asked for and
 * could not preview.
 *
 * Two deliberate simplifications, both visible in the UI rather than hidden:
 *
 * - `nodeToken` is a normal string field rendered as a password input, not a
 *   `role('secret')` credential. The secret role stores through the credentials
 *   domain, which this card does not implement; marking the field secret would
 *   give a write-only control that saves nothing. Its definition is written so
 *   that an empty draft *keeps* the stored value rather than clearing it.
 * - Numeric fields are plain number inputs validated on save. A draft that is not
 *   a finite number marks the save blocked instead of being silently dropped.
 *
 * @module dsh-remote-control-client
 */

window.__ModuleLoader__.load({
  id: 'dsh-remote-control-client',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    const react = require('react')

    //#region dsh-remote-control-client: constants
    /** The settings namespace the host row registers. */
    const NAMESPACE = 'remote-control'
    /** Browser services this card consumes: the slot ledger and the namespace scope. */
    const inject = ['slots', 'settingsScope']
    //#endregion

    //#region dsh-remote-control-client: styles
    const CSS = `
.rc-section { display: flex; flex-direction: column; gap: 10px; }
.rc-section-title { margin: 0; font-size: 15px; font-weight: 600; }
.rc-section-lede { margin: 0 0 4px; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.rc-card { display: flex; flex-direction: column; gap: 10px; padding: 4px 0 2px; }
.rc-note { color: var(--dsw-alias-text-secondary, #9aa3b2); font-size: 12px; line-height: 1.5; }
.rc-warn { color: var(--dsw-alias-text-warning, #d9a441); font-size: 12px; }
.rc-err { color: var(--dsw-alias-text-danger, #e0625d); font-size: 12px; }
.rc-ok { color: var(--dsw-alias-text-success, #46b96a); font-size: 12px; }
.rc-field { display: flex; flex-direction: column; gap: 4px; }
.rc-label { display: flex; align-items: baseline; gap: 6px; font-size: 12px; font-weight: 600; }
.rc-over { font-weight: 400; font-size: 11px; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.rc-input, .rc-textarea, .rc-select {
  width: 100%; box-sizing: border-box; padding: 6px 8px; font: inherit; font-size: 13px;
  color: inherit; background: var(--dsw-alias-bg-input, rgba(127,127,127,.10));
  border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.30)); border-radius: 6px;
}
.rc-input:focus, .rc-textarea:focus, .rc-select:focus {
  outline: none; border-color: var(--dsw-alias-border-focus, #4c8dff);
}
.rc-input.rc-bad { border-color: var(--dsw-alias-text-danger, #e0625d); }
.rc-textarea { min-height: 62px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.rc-hint { font-size: 11px; color: var(--dsw-alias-text-secondary, #9aa3b2); }
.rc-row { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.rc-btn {
  padding: 5px 12px; font: inherit; font-size: 12px; font-weight: 600; cursor: pointer;
  color: #fff; background: var(--dsw-alias-bg-accent, #4c8dff); border: 0; border-radius: 6px;
}
.rc-btn:disabled { opacity: .45; cursor: not-allowed; }
.rc-btn.rc-ghost {
  color: inherit; background: transparent;
  border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.30));
}
.rc-check { display: flex; align-items: center; gap: 6px; font-size: 13px; }
.rc-invite { display: flex; flex-direction: column; gap: 8px; padding-top: 4px; border-top: 1px solid var(--dsw-alias-border, rgba(127,127,127,.30)); }
.rc-invite-title { font-size: 12px; font-weight: 600; }
.rc-code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 20px; font-weight: 700;
  letter-spacing: .14em; padding: 8px 12px; border-radius: 8px; text-align: center;
  background: var(--dsw-alias-bg-input, rgba(127,127,127,.10));
  border: 1px solid var(--dsw-alias-border, rgba(127,127,127,.30));
}
`
    /** Inject the stylesheet once, keyed so a reload does not stack copies. */
    function installStyles() {
      if (typeof document === 'undefined') return
      const tagId = 'dsh-remote-control-client/remote-control.css'
      if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-remote-control-client'
      tag.dataset.pluginCss = tagId
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    //#endregion

    //#region dsh-remote-control-client: field model
    /**
     * A free-text field. An empty draft clears it.
     *
     * @param {string} field - key inside the namespace section.
     * @param {object} [options] - `{ label, hint, placeholder, keepBlank, password }`.
     * @returns {object} the field spec.
     */
    function textField(field, options = {}) {
      return {
        field,
        label: options.label ?? field,
        hint: options.hint ?? '',
        placeholder: options.placeholder ?? '',
        password: options.password === true,
        format: (value) => (typeof value === 'string' ? value : ''),
        /**
         * @param {string} text - the draft.
         * @returns {object} `{ kind: 'keep' | 'clear' | 'set', value? }`.
         */
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return options.keepBlank === true ? { kind: 'keep' } : { kind: 'clear' }
          return { kind: 'set', value: trimmed }
        }
      }
    }

    /**
     * A whole-number field. An empty draft clears it; a non-number blocks the save.
     *
     * @param {string} field - key inside the namespace section.
     * @param {object} [options] - `{ label, hint, placeholder }`.
     * @returns {object} the field spec.
     */
    function numberField(field, options = {}) {
      return {
        field,
        label: options.label ?? field,
        hint: options.hint ?? '',
        placeholder: options.placeholder ?? '',
        password: false,
        format: (value) => (typeof value === 'number' && Number.isFinite(value) ? String(value) : ''),
        parse: (text) => {
          const trimmed = text.trim()
          if (trimmed === '') return { kind: 'clear' }
          const parsed = Number(trimmed)
          return Number.isFinite(parsed) ? { kind: 'set', value: parsed } : { kind: 'invalid' }
        }
      }
    }

    /**
     * A list of absolute paths, edited as one path per line.
     *
     * The settings schema stores `workspaces` as an array of strings, so the whole
     * array is written in one `set` rather than per item. Blank lines are dropped,
     * because a trailing newline is not a workspace.
     *
     * @param {string} field - key inside the namespace section.
     * @param {object} [options] - `{ label, hint, placeholder }`.
     * @returns {object} the field spec.
     */
    function pathListField(field, options = {}) {
      return {
        field,
        label: options.label ?? field,
        hint: options.hint ?? '',
        placeholder: options.placeholder ?? '',
        password: false,
        multiline: true,
        format: (value) => (Array.isArray(value) ? value.filter((entry) => typeof entry === 'string').join('\n') : ''),
        parse: (text) => {
          const entries = text
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '')
          return entries.length === 0 ? { kind: 'clear' } : { kind: 'set', value: entries }
        }
      }
    }

    /** Where the invite route lives: the host half of this same package. */
    const INVITE_ROUTE = '/dsh-remote-control/api/invite'

    /**
     * The invite-code block: ask for a code, show it, count it down.
     *
     * Invite codes are minted by the relay because the relay is the only party a
     * visitor talks to, so it has to be the one that can accept or refuse one. The
     * card's job is to make that a button: without it, inviting somebody would mean
     * `ssh`-ing to a server, which is not a thing the person holding the door
     * should have to do.
     *
     * Three details are deliberate:
     *
     * - **A code is useless while the door is shut**, so the button says that
     *   instead of letting the relay refuse after a round trip.
     * - **The countdown is the point of the code.** "15 minutes" is a promise the
     *   card has to keep showing, or the operator sends a code that quietly died.
     * - **The full guest URL is shown with it**, because the code is useless without
     *   somewhere to type it, and the person being invited should not have to be
     *   told two things.
     *
     * @param {object} props - `{ relayUrl, doorOpen, writable }`.
     * @returns {object} the React element.
     */
    function InviteSection(props) {
      const [invite, setInvite] = react.useState(undefined)
      const [error, setError] = react.useState('')
      const [busy, setBusy] = react.useState(false)
      const [now, setNow] = react.useState(Date.now())

      // One ticker for the countdown, and only while a code is live: a timer that
      // runs for the lifetime of the settings page is a timer nobody asked for.
      react.useEffect(() => {
        if (invite === undefined) return undefined
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
      }, [invite])

      const guestUrl = (() => {
        const relay = typeof props.relayUrl === 'string' ? props.relayUrl.trim().replace(/\/+$/, '') : ''
        return relay === '' ? '/guest（先填上面的中转台地址）' : `${relay}/guest`
      })()

      const remaining = invite === undefined ? 0 : Math.max(0, Math.floor((invite.expiresAt - now) / 1000))
      const expired = invite !== undefined && remaining === 0
      const clock = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`

      const generate = async () => {
        setBusy(true)
        setError('')
        try {
          const response = await fetch(INVITE_ROUTE, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}'
          })
          const payload = await response.json().catch(() => ({}))
          if (!response.ok || payload?.ok !== true) {
            throw new Error(payload?.error?.message ?? `HTTP ${response.status}`)
          }
          setInvite({ code: payload.value.code, expiresAt: payload.value.expiresAt })
          setNow(Date.now())
        } catch (problem) {
          setInvite(undefined)
          setError(problem?.message ?? String(problem))
        } finally {
          setBusy(false)
        }
      }

      const copy = async (text, button) => {
        let ok = true
        try {
          if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(text)
          else ok = false
        } catch { ok = false }
        button.textContent = ok ? '已复制' : '复制失败'
        setTimeout(() => { button.textContent = '复制邀请码' }, 1500)
      }

      const children = [
        react.createElement('div', { key: 'title', className: 'rc-invite-title' }, '游客邀请码'),
        react.createElement(
          'div',
          { key: 'lede', className: 'rc-note' },
          '给要邀请的人一串码：他打开下面的链接，输入这串码，就能用游客身份进来。' +
            '每串码 15 分钟内有效、只能用一次；用过之后那台浏览器会被记住，不用再输。'
        ),
        react.createElement('div', { key: 'url', className: 'rc-hint' }, `游客链接：${guestUrl}`)
      ]

      if (invite !== undefined) {
        children.push(react.createElement('div', { key: 'code', className: 'rc-code' }, invite.code))
        children.push(
          react.createElement(
            'div',
            { key: 'state', className: expired ? 'rc-warn' : 'rc-ok' },
            expired ? '这串码已经过期了，重新生成一个。' : `还有 ${clock} 失效 · 只能用一次`
          )
        )
      }
      if (error !== '') children.push(react.createElement('div', { key: 'err', className: 'rc-err' }, error))

      const actions = [
        react.createElement(
          'button',
          {
            key: 'gen',
            type: 'button',
            className: 'rc-btn',
            disabled: busy || !props.doorOpen || props.writable === false,
            onClick: () => void generate()
          },
          busy ? '生成中…' : invite === undefined ? '生成邀请码' : '再生成一个'
        )
      ]
      if (invite !== undefined) {
        actions.push(
          react.createElement(
            'button',
            {
              key: 'copy',
              type: 'button',
              className: 'rc-btn rc-ghost',
              onClick: (event) => void copy(invite.code, event.currentTarget)
            },
            '复制邀请码'
          )
        )
      }
      children.push(react.createElement('div', { key: 'row', className: 'rc-row' }, actions))
      if (!props.doorOpen) {
        children.push(
          react.createElement(
            'div',
            { key: 'shut', className: 'rc-hint' },
            '上面的「开放游客入口」还没打开，所以现在生成的码没有地方可用。'
          )
        )
      }

      return react.createElement('div', { className: 'rc-invite' }, children)
    }

    /**
     * The card's fields, in the order they render.
     *
     * Kept in step with `lib/settings-schema.js` by hand. That duplication is real
     * and worth naming: the schema decides what the host accepts and what
     * `settings.describe()` returns, while these specs decide how a value is typed
     * and validated in the browser. A key added on one side must be added here.
     *
     * @returns {object[]} the field specs.
     */
    function fieldSpecs() {
      return [
        textField('relayUrl', {
          label: '中转台地址',
          hint: '含子路径、不带结尾斜杠，例如 https://icyu.online/harness',
          placeholder: 'https://icyu.online/harness'
        }),
        textField('nodeToken', {
          label: '节点令牌',
          hint: '中转台 /etc/dsh-remote-relay.env 里的 DSH_REMOTE_AGENT_TOKEN。留空 = 保持原值不变。',
          placeholder: '留空则不修改',
          keepBlank: true,
          password: true
        }),
        textField('displayName', {
          label: '显示名称',
          hint: '中转台页面上显示的名字。留空则用这台机器的主机名。',
          placeholder: '例如 我的 Windows 本'
        }),
        pathListField('workspaces', {
          label: '工作台（每行一个绝对路径）',
          hint: '允许远程操作的目录白名单。不在这个列表里的路径一律被拒，不会执行。',
          placeholder: '/Users/me/projects\n/Users/me/notes'
        }),
        textField('agentPreset', { label: 'Agent 预设', hint: '远程会话用哪个 agent 预设，默认 standard。' }),
        textField('permissionPreset', {
          label: '权限预设',
          hint: '固定给远程会话的权限，默认 workspace-write：越界操作会弹在你这台机器上等确认。'
        }),
        pathListField('guestWorkspaces', {
          label: '游客工作台（每行一个绝对路径）',
          hint:
            '游客能访问的**唯一**目录白名单，必须是上面工作台的子集；留空则游客模式没有可用的工作台。' +
            '写在这里的目录不会因为注册表模式而扩大。',
          placeholder: '/Users/me/demo'
        }),
        textField('guestAgentPreset', {
          label: '游客 Agent 预设',
          hint: '游客会话用哪个 agent 预设，默认 reader（随插件自带安装的只读分析 agent）。'
        }),
        textField('guestPermissionPreset', {
          label: '游客权限预设',
          hint: '固定给游客会话的权限，默认 read-only：只读，改不了任何文件。'
        }),
        numberField('guestMaxPromptChars', {
          label: '游客单条提问上限（字符）',
          hint: '游客一条提问最长多少字符，默认 8000。节点和页面各拦一道。'
        }),
        numberField('reconnectMinMs', { label: '重连最小间隔（毫秒）' }),
        numberField('reconnectMaxMs', { label: '重连最大间隔（毫秒）' })
      ]
    }

    /**
     * The card's switches, in the order they render.
     *
     * Separate from `fieldSpecs` because these write the moment they are toggled
     * rather than staging an edit: a switch is a decision with one visible
     * consequence, and "stage it, then remember to press save" is how a door ends
     * up in a state the operator did not intend. `defaultOn` records which way an
     * absent value reads, because the host and the card must agree — `enabled`
     * defaults to on, `guestEnabled` only to `true` (see `lib/config.js`).
     *
     * @returns {object[]} the switch specs.
     */
    function booleanSpecs() {
      return [
        {
          field: 'enabled',
          label: '启用这台机器的远程控制',
          defaultOn: true,
          on: '已启用。',
          off: '已停用，节点会断开。'
        },
        {
          field: 'guestEnabled',
          label: '开放游客入口（无需密码，只能读、只能访问上面的游客工作台）',
          defaultOn: false,
          on: '游客入口已开放：中转台 /guest 任何人都能进，立即生效。',
          off: '游客入口已关闭，中转台会立刻拒绝新的游客。'
        },
        {
          field: 'installBundledPresets',
          label: '随插件安装自带的 agent 预设（游客模式用的 reader）',
          defaultOn: true,
          on: '已开启：下次加载插件时会把自带预设写进 $DSH_HOME/.agent-presets。',
          off: '已关闭：自带预设不再写入，reader 需要你自己装。'
        }
      ]
    }
    //#endregion

    //#region dsh-remote-control-client: RemoteControlCard
    /** Snapshot shape standing in when no scope is injected, so reads stay total. */
    const EMPTY_SNAPSHOT = { status: 'unavailable', value: undefined, user: undefined, revision: undefined }

    /**
     * One row: a label, an override marker, and the staged control.
     *
     * @param {object} props - `{ spec, draft, overridden, invalid, onChange }`.
     * @returns {object} the React element.
     */
    function Field(props) {
      const { spec, draft, overridden, invalid, onChange } = props
      const common = {
        value: draft,
        className: spec.multiline === true ? 'rc-textarea' : 'rc-input' + (invalid ? ' rc-bad' : ''),
        placeholder: spec.placeholder,
        spellCheck: false,
        onChange: (event) => onChange(event.target.value)
      }
      if (spec.password === true) common.type = 'password'
      else if (spec.multiline !== true) common.type = 'text'
      return react.createElement('div', { className: 'rc-field' }, [
        react.createElement('label', { key: 'label', className: 'rc-label' }, [
          spec.label,
          overridden ? react.createElement('span', { key: 'over', className: 'rc-over' }, '· 已自定义') : null
        ]),
        spec.multiline === true ? react.createElement('textarea', { key: 'input', ...common }) : react.createElement('input', { key: 'input', ...common }),
        spec.hint === '' ? null : react.createElement('div', { key: 'hint', className: 'rc-hint' }, spec.hint)
      ])
    }

    /**
     * The configuration card.
     *
     * @param {object} props - injected `{ getSnapshot, subscribe, set, unset, namespace }`.
     * @returns {object} the React element.
     */
    function RemoteControlCard(props) {
      // The scope arrives as injected props. Every read is defaulted rather than
      // assumed: a shell whose slot contract drops them should degrade to a static
      // card, never take the settings pane down.
      const getSnapshot = typeof props.getSnapshot === 'function' ? props.getSnapshot : () => EMPTY_SNAPSHOT
      const subscribe = typeof props.subscribe === 'function' ? props.subscribe : () => () => {}
      const setField = typeof props.set === 'function' ? props.set : undefined
      const unsetField = typeof props.unset === 'function' ? props.unset : undefined

      const [snapshot, setSnapshot] = react.useState(getSnapshot)
      const [drafts, setDrafts] = react.useState({})
      const [status, setStatus] = react.useState(undefined)
      const [saving, setSaving] = react.useState(false)
      const specs = react.useMemo(fieldSpecs, [])

      react.useEffect(() => subscribe(() => setSnapshot(getSnapshot())), [])

      const value = snapshot.value ?? {}
      const user = snapshot.user ?? {}
      const writable = snapshot.writable !== false && setField !== undefined && unsetField !== undefined
      const ready = snapshot.status === 'ready'

      /** The text a control starts from: the effective value. */
      const baselineOf = (spec) => spec.format(value[spec.field])

      /**
       * Parse every dirty field into planned writes.
       *
       * An invalid draft yields `blocked` so the save refuses instead of dropping
       * the edit the user is looking at.
       *
       * @returns {{ writes: object[], blocked: string[] }} the plan.
       */
      const plan = () => {
        const writes = []
        const blocked = []
        for (const spec of specs) {
          if (!(spec.field in drafts)) continue
          const draft = drafts[spec.field]
          const text = draft.text
          if (spec.password === true && text.trim() === '') continue
          if (text === baselineOf(spec)) continue
          const parsed = spec.parse(text)
          if (parsed.kind === 'invalid') {
            blocked.push(spec.label)
            continue
          }
          if (parsed.kind === 'keep') continue
          writes.push(
            parsed.kind === 'clear'
              ? { field: spec.field, run: () => unsetField(spec.field) }
              : { field: spec.field, run: () => setField(spec.field, parsed.value) }
          )
        }
        return { writes, blocked }
      }

      const currentPlan = plan()
      const dirty = Object.keys(drafts).length > 0
      const blocked = currentPlan.blocked

      /** Write every staged edit, then re-read to confirm what actually landed. */
      const save = async () => {
        const outcome = plan()
        if (outcome.blocked.length > 0) {
          setStatus({ kind: 'err', text: `这些字段填的不对，先改好再保存：${outcome.blocked.join('、')}` })
          return
        }
        if (outcome.writes.length === 0) {
          setDrafts({})
          setStatus({ kind: 'note', text: '没有需要保存的改动。' })
          return
        }
        setSaving(true)
        setStatus(undefined)
        try {
          for (const write of outcome.writes) await write.run()
          setDrafts({})
          setStatus({
            kind: 'ok',
            text: '已保存。节点会用新配置重新连接中转台——不用重启后端。'
          })
        } catch (error) {
          setStatus({ kind: 'err', text: `保存失败：${error?.message ?? error}` })
        } finally {
          setSaving(false)
        }
      }

      const discard = () => {
        setDrafts({})
        setStatus(undefined)
      }

      const stage = (spec, text) => {
        setStatus(undefined)
        setDrafts((previous) => ({ ...previous, [spec.field]: { text } }))
      }

      const children = []
      children.push(
        react.createElement(
          'div',
          { key: 'note', className: 'rc-note' },
          '这台机器会主动连上中转台，服从你从公网页面下的指令。远程会话固定使用上面那个权限预设，' +
            '越界操作会弹在你这台机器的 DSH 里等确认——中转台和页面都没有审批按钮。'
        )
      )
      children.push(
        react.createElement(
          'div',
          { key: 'guest-note', className: 'rc-warn' },
          '游客入口是一个没有密码的公开页面：打开链接的人可以用「游客 Agent 预设」在这台机器上提问，' +
            '范围仅限「游客工作台」列出的目录。只读靠两层硬约束——预设自身没有写工具，' +
            '权限又钉在 read-only；关掉游客开关或在中转台上设 DSH_REMOTE_GUEST=off 都能立刻关门。'
        )
      )

      if (!ready) {
        children.push(
          react.createElement('div', { key: 'loading', className: 'rc-note' }, '正在读取当前配置…')
        )
      }
      if (ready && !writable) {
        children.push(
          react.createElement(
            'div',
            { key: 'ro', className: 'rc-warn' },
            '这个部署的设置是只读的，界面无法保存改动。请改 profile 的 cordis.patch.yml。'
          )
        )
      }

      for (const spec of specs) {
        const draft = spec.field in drafts ? drafts[spec.field].text : baselineOf(spec)
        children.push(
          react.createElement(Field, {
            key: spec.field,
            spec,
            draft,
            overridden: Object.prototype.hasOwnProperty.call(user, spec.field),
            invalid: blocked.includes(spec.label),
            onChange: (text) => stage(spec, text)
          })
        )
      }

      for (const spec of booleanSpecs()) {
        const checked = spec.defaultOn === true ? value[spec.field] !== false : value[spec.field] === true
        children.push(
          react.createElement('label', { key: spec.field, className: 'rc-check' }, [
            react.createElement('input', {
              key: 'cb',
              type: 'checkbox',
              checked,
              disabled: !writable,
              onChange: (event) => {
                if (!writable) return
                setSaving(true)
                setStatus(undefined)
                void setField(spec.field, event.target.checked)
                  .then(() => setStatus({ kind: 'ok', text: event.target.checked ? spec.on : spec.off }))
                  .catch((error) => setStatus({ kind: 'err', text: `保存失败：${error?.message ?? error}` }))
                  .finally(() => setSaving(false))
              }
            }),
            spec.label
          ])
        )
      }

      children.push(react.createElement(InviteSection, {
        key: 'invite',
        relayUrl: value.relayUrl,
        doorOpen: value.guestEnabled === true,
        writable
      }))

      children.push(
        react.createElement('div', { key: 'actions', className: 'rc-row' }, [
          react.createElement(
            'button',
            {
              key: 'save',
              type: 'button',
              className: 'rc-btn',
              disabled: !writable || saving || blocked.length > 0 || !dirty,
              onClick: () => void save()
            },
            saving ? '保存中…' : '保存'
          ),
          react.createElement(
            'button',
            {
              key: 'discard',
              type: 'button',
              className: 'rc-btn rc-ghost',
              disabled: !dirty || saving,
              onClick: discard
            },
            '放弃改动'
          ),
          dirty ? react.createElement('span', { key: 'dirty', className: 'rc-note' }, '有未保存的改动') : null
        ])
      )

      if (status !== undefined) {
        children.push(
          react.createElement('div', { key: 'status', className: status.kind === 'err' ? 'rc-err' : status.kind === 'ok' ? 'rc-ok' : 'rc-note' }, status.text)
        )
      }

      return react.createElement('div', { className: 'rc-card' }, children)
    }
    //#endregion

    //#region dsh-remote-control-client: plugin
    /** The settings section's nav key and order. */
    const SECTION_ID = 'remote-control'
    /** Placed after the shipped sections (general 0, models 10, plugins 15, agent-presets 20). */
    const SECTION_ORDER = 25

    /**
     * The card's injected face over its settings scope.
     *
     * One factory, used by both mount points, so the section and the Plugins-tab
     * card can never drift into reading or writing differently.
     *
     * @param {object} scope - the bound settings scope.
     * @returns {object} the injected props.
     */
    function scopeProps(scope) {
      return {
        getSnapshot: () => scope.getSnapshot(),
        subscribe: (listener) => scope.subscribe(listener),
        set: (field, next) => scope.set(field, next),
        unset: (field) => scope.unset(field),
        namespace: NAMESPACE
      }
    }

    /**
     * Mount the configuration surface.
     *
     * Registered twice, on purpose:
     *
     * - `settings.section` gives it a **top-level settings page of its own**, which
     *   is where a person actually looks for it. The settings shell is data-driven:
     *   the contract states that a feature owns its own settings pages and that
     *   adding a setting never means editing the shell, and this is that mechanism
     *   — the same one the shipped sections and the agent-presets roster use.
     * - `settings.plugin.item` keeps the Plugins → Plugin configuration card, so the
     *   tab remains an index of configurable plugins rather than something this
     *   plugin quietly opts out of.
     *
     * Both mount points read and write the same namespace through the same props.
     *
     * @param {object} ctx - the browser plugin context.
     */
    function apply(ctx) {
      installStyles()
      const scope = ctx.settingsScope.bind({ namespace: NAMESPACE })

      ctx.slots.inject('settings.plugin.item', () =>
        ctx.slots.register(
          {
            name: 'settings.plugin.item',
            key: NAMESPACE,
            inject: () => scopeProps(scope)
          },
          RemoteControlCard
        )
      )

      ctx.slots.inject('settings.section', () =>
        ctx.slots.register(
          {
            name: 'settings.section',
            id: SECTION_ID,
            order: SECTION_ORDER,
            // A function, matching every shipped registrant: the shell resolves the
            // label through `resolveSlotLabel` and re-reads it on locale change, and
            // a locale-bound function is the only shape the shipped sections use.
            // Text lives here rather than in a locale package because this plugin
            // ships no translations yet.
            label: () => '远程控制',
            inject: () => scopeProps(scope)
          },
          RemoteControlSection
        )
      )
    }

    /**
     * The section page: a title, a line of orientation, and the same card.
     *
     * `props.close` is supplied by the settings shell and deliberately unused here —
     * nothing in this page leaves settings. It is named so the reason is visible.
     *
     * @param {object} props - the card's injected props plus the shell's `close`.
     * @returns {object} the React element.
     */
    function RemoteControlSection(props) {
      return react.createElement('div', { className: 'rc-section' }, [
        react.createElement('h2', { key: 'title', className: 'rc-section-title' }, '远程控制'),
        react.createElement(
          'p',
          { key: 'lede', className: 'rc-section-lede' },
          '让公网上的中转台认出这台机器，并向它派活。下面的改动保存后立即生效，不用重启后端。'
        ),
        react.createElement(RemoteControlCard, { key: 'card', ...props })
      ])
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    exports.NAMESPACE = NAMESPACE
    exports.SECTION_ID = SECTION_ID
    exports.RemoteControlCard = RemoteControlCard
    exports.RemoteControlSection = RemoteControlSection
    return module.exports
  }
})
