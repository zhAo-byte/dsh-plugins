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
        numberField('reconnectMinMs', { label: '重连最小间隔（毫秒）' }),
        numberField('reconnectMaxMs', { label: '重连最大间隔（毫秒）' })
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

      children.push(
        react.createElement('label', { key: 'enabled', className: 'rc-check' }, [
          react.createElement('input', {
            key: 'cb',
            type: 'checkbox',
            checked: value.enabled !== false,
            disabled: !writable,
            onChange: (event) => {
              if (!writable) return
              setSaving(true)
              setStatus(undefined)
              void (event.target.checked ? setField('enabled', true) : setField('enabled', false))
                .then(() => setStatus({ kind: 'ok', text: event.target.checked ? '已启用。' : '已停用，节点会断开。' }))
                .catch((error) => setStatus({ kind: 'err', text: `保存失败：${error?.message ?? error}` }))
                .finally(() => setSaving(false))
            }
          }),
          '启用这台机器的远程控制'
        ])
      )

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
    /**
     * Mount the card.
     *
     * The keyed `settings.plugin.item` slot dispatches this card only for the
     * namespace it names, so the tab renders it exactly when the host serves
     * `remote-control` — no feature flag, and nothing to see on a deployment
     * without this plugin installed.
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
            inject: () => ({
              getSnapshot: () => scope.getSnapshot(),
              subscribe: (listener) => scope.subscribe(listener),
              set: (field, next) => scope.set(field, next),
              unset: (field) => scope.unset(field),
              namespace: NAMESPACE
            })
          },
          RemoteControlCard
        )
      )
    }
    //#endregion

    exports.apply = apply
    exports.inject = inject
    exports.NAMESPACE = NAMESPACE
    exports.RemoteControlCard = RemoteControlCard
    return module.exports
  }
})
