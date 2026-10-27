// client.js — the browser half of dsh-win-pwsh7: the configure section, the diagnostics
// section, and the re-detect action on the plugin pages. Both render as flat native detail
// sections — no card chrome, and the host page's own 32px section rhythm does the spacing.
//
// One operation, two callers: the diagnostics section and the re-detect button call the
// same Host method (`status`) that the `pwsh7_status` agent tool runs — over the Remote
// channel declared by this package's build-time typert contract (lib/typert.host.js).
// Styles use only --dsw-alias-* theme tokens and render as React elements, so unmounting
// removes them; class names carry the dw7- prefix.

window.__ModuleLoader__.load({
  id: 'dsh-win-pwsh7',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState, useSyncExternalStore } = React

    const PACKAGE = 'dsh-win-pwsh7'
    const ROW_ID = 'win-pwsh7'
    const SLOT_KEY = PACKAGE + '#' + ROW_ID

    function describe(error) {
      return error instanceof Error ? error.message : String(error)
    }

    // ---- Remote plumbing (the client half of the four-block typert contract) ----

    function descriptorsFor(pkg, endpoints) {
      const argsCodec = () => ({
        mode: 'strict',
        typeSymbol: pkg + '/typert#EndpointArgs',
        create: () => ({
          parse(value) {
            if (value === null || typeof value !== 'object' || Array.isArray(value)) {
              throw new TypeError(pkg + ': endpoint args must be a plain object')
            }
            return value
          },
        }),
      })
      return endpoints.map((name) => ({
        id: pkg + '#' + pkg + '/' + name,
        service: pkg,
        namespace: pkg, // must be the package name: the client-side service key is remote.<namespace>
        method: name,
        invocation: { kind: 'direct' },
        parameters: [{ name: 'args', wire: 'args', source: 'json', codec: argsCodec() }],
        result: { mode: 'src-json' }, // the gateway passes results through; the caller unwraps the envelope
        // Deliberate asymmetry, not drift: the *Host* manifest carries the strict result codec
        // (`exports["./typert"]` / lib/typert.host.js), while the client-side descriptor asks for
        // `src-json` and unwraps one RemoteResult envelope — that is the protocol's two-sided shape,
        // and the descriptor above is its documented form. Changing it to a strict codec here would
        // break a channel that is live-verified working.
      }))
    }

    /** The remote method answers a RemoteResult envelope {ok,value}|{ok,error}; callers want the raw value. */
    function unwrapRemoteResult(res) {
      if (!res || typeof res !== 'object' || typeof res.ok !== 'boolean') return res
      if (res.ok === true && 'value' in res) return res.value
      if (res.ok === false && res.error && typeof res.error === 'object') {
        const failure = res.error
        const err = new Error('remote ' + (failure.code || 'unknown') + (failure.message ? ': ' + failure.message : ''))
        err.code = failure.code
        err.remote = failure
        throw err
      }
      return res
    }

    // ---- locale dictionaries (en must stay Chinese-free) ----

    const DICT_EN = {
      diagnostics_title: 'PowerShell 7 status',
      status_loading: 'Detecting…',
      status_empty: 'No report yet — press Re-detect.',
      status_error: 'Detection failed: {error}',
      refreshed_at: 'refreshed {at}',
      redetect: 'Re-detect',
      redetecting: 'Detecting…',
      card_title: 'Configuration',
      field_overridePath: 'Explicit path (overridePath)',
      overridePath_hint: 'Priority ① explicit pwsh.exe path. Empty = auto-detect. It must spawn and report PowerShell 7 or newer; the Store family alias is accepted, while a version-numbered Store path is never pinned. This only changes what the plugin probes and recommends — it does not wire the pwsh tool. Use the patch in the status section for that.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved {at}',
      save_rejected: 'The Host rejected the write.',
      form_loading: 'Loading configuration…',
      form_unavailable: 'Configuration is not available right now.',
      unwritable: 'The Host is not accepting writes for this row.',
      error_remote_unavailable: 'the Remote service is not available in this deployment',
      error_endpoint_missing: 'the status endpoint is not mounted',
      copy_patch: 'Copy patch',
      copied: 'Copied',
      copy_failed: 'Copy failed — select the patch text and copy it manually.',
      patch_note: 'Paste this into the profile patch and restart DSH. The config block replaces the row wholesale.',
    }
    const DICT_ZH = {
      diagnostics_title: 'PowerShell 7 状态',
      status_loading: '检测中…',
      status_empty: '尚无报告——点「重新检测」。',
      status_error: '检测失败：{error}',
      refreshed_at: '刷新于 {at}',
      redetect: '重新检测',
      redetecting: '检测中…',
      card_title: '配置',
      field_overridePath: '指定路径（overridePath）',
      overridePath_hint: '优先级①的显式 pwsh.exe 路径。留空 = 自动探测。必须能启动并报告 PowerShell 7 及以上；Store 家族别名可用，版本号目录永不被 pin。这里只影响插件的探测与推荐，不会给 pwsh 工具接线；接线请用状态区里的补丁。',
      save: '保存',
      reset: '重置',
      saved: '已保存 {at}',
      save_rejected: 'Host 拒绝了这次写入。',
      form_loading: '配置读取中…',
      form_unavailable: '配置暂不可用。',
      unwritable: 'Host 当前不接受该行的写入。',
      error_remote_unavailable: '本部署没有可用的 Remote 服务',
      error_endpoint_missing: '状态端点未挂载',
      copy_patch: '复制补丁',
      copied: '已复制',
      copy_failed: '复制失败——请手动选中补丁文本复制。',
      patch_note: '把这段粘贴进 profile 补丁并重启 DSH；config 会整体替换该行的配置。',
    }

    // One native detail-section stylesheet for both contributions. A style element only applies
    // while its section is mounted, so both sections carry it: a page can render the status
    // section without ever rendering the configure section.
    const CSS = `
.dw7-section{display:flex;flex-direction:column;gap:12px;min-width:0;}
.dw7-head{display:flex;align-items:baseline;gap:10px;min-width:0;}
.dw7-title{margin:0;color:var(--dsw-alias-label-primary);font-size:14px;font-weight:500;line-height:20px;}
.dw7-count{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;}
.dw7-head-action{margin-left:auto;flex:none;align-self:center;}
.dw7-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;min-width:0;}
.dw7-field + .dw7-field{border-top:.5px solid var(--dsw-alias-border-l2);}
.dw7-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:1.5;}
.dw7-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);font-family:inherit;font-size:13px;line-height:1.5;color:var(--dsw-alias-label-primary);}
.dw7-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);}
.dw7-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}
.dw7-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}
.dw7-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}
.dw7-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);}
.dw7-save:disabled{opacity:.4;cursor:default;}
.dw7-save:focus-visible,.dw7-reset:focus-visible,.dw7-small:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
.dw7-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dw7-reset:hover:not(:disabled){color:var(--dsw-alias-label-primary);}
.dw7-reset:disabled{cursor:default;}
.dw7-small{box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dw7-small:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover);}
.dw7-small:disabled{opacity:.4;cursor:not-allowed;}
.dw7-report{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.dw7-empty{margin:0;color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;}
.dw7-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere;}
.dw7-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5;}
.dw7-patch{display:flex;flex-direction:column;gap:8px;min-width:0;}
.dw7-patch-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.dw7-patch-note{margin:0;flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}
.dw7-code{box-sizing:border-box;margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
`

    return {
      inject: ['slots', 'locale', 'configForms', 'remote'],
      apply(ctx) {
        const disposeLocale = ctx.locale.register(PACKAGE, {
          en: DICT_EN,
          zh: DICT_ZH,
          'zh-CN': DICT_ZH,
          'zh-TW': DICT_ZH,
        })
        const t = ctx.locale.bind(PACKAGE)
        const form = ctx.configForms.get(ROW_ID)
        // A missing controller must not break the render, and every callback handed to
        // `useSyncExternalStore` must keep a **stable identity**: it compares snapshots with
        // `Object.is` and re-subscribes when `subscribe` changes, so a fresh object or arrow per
        // render loops forever (React: "The result of getSnapshot should be cached"). Both wrappers
        // are therefore built exactly once, here at apply time.
        const ABSENT_FORM_SUBSCRIBE = () => {}
        const ABSENT_FORM_SNAPSHOT = { status: 'unavailable', value: undefined, writable: false }
        const formSubscribe = form === undefined ? ABSENT_FORM_SUBSCRIBE : (listener) => form.subscribe(listener)
        const formSnapshot = form === undefined ? () => ABSENT_FORM_SNAPSHOT : () => form.getSnapshot()

        // ---- shared diagnostics store: one snapshot for the section and the action ----
        let snapshot = { state: 'idle', report: null, error: null, at: null }
        const listeners = new Set()
        const diagnostics = {
          get: () => snapshot,
          subscribe(listener) {
            listeners.add(listener)
            return () => listeners.delete(listener)
          },
          set(next) {
            snapshot = next
            for (const listener of [...listeners]) listener()
          },
        }

        let mounting = null
        async function callStatus() {
          const remote = ctx.get('remote')
          if (!remote || typeof remote.$mount !== 'function') {
            throw new Error(t('error_remote_unavailable'))
          }
          if (mounting === null) {
            mounting = remote.$mount({ package: PACKAGE, descriptors: descriptorsFor(PACKAGE, ['status']) })
              .catch((error) => {
                mounting = null
                throw error
              })
          }
          await mounting
          const ns = ctx.get('remote.' + PACKAGE) || remote[PACKAGE]
          if (!ns || typeof ns.status !== 'function') {
            throw new Error(t('error_endpoint_missing'))
          }
          return unwrapRemoteResult(await ns.status({}))
        }

        async function refresh() {
          const previous = snapshot
          if (previous.state === 'loading') return
          diagnostics.set({ state: 'loading', report: previous.report, error: null, at: previous.at })
          try {
            const out = await callStatus()
            diagnostics.set({ state: 'ready', report: typeof out?.report === 'string' ? out.report : '', error: null, at: new Date().toLocaleTimeString() })
          } catch (error) {
            diagnostics.set({ state: 'error', report: previous.report, error: describe(error), at: previous.at })
          }
        }

        // ---- components ----

        /** The profile patch a report carries, when it offers one, without the prose around it. */
        function patchFromReport(report) {
          if (typeof report !== 'string') return null
          const start = report.indexOf('- id: pwsh-sandbox')
          if (start < 0) return null
          const end = report.indexOf('\n\n', start)
          return report.slice(start, end < 0 ? undefined : end).trimEnd()
        }

        function DiagnosticsSection(props) {
          const pkg = props?.subject?.pkg
          const active = pkg === PACKAGE || pkg?.name === PACKAGE
          const snap = useSyncExternalStore(diagnostics.subscribe, diagnostics.get)
          const [copied, setCopied] = useState(false)
          const [copyNote, setCopyNote] = useState(null)
          useEffect(() => {
            if (active) void refresh()
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [active])
          if (!active) return null
          const report = typeof snap.report === 'string' ? snap.report : ''
          const patch = patchFromReport(report)
          async function copyPatch() {
            try {
              if (globalThis.navigator?.clipboard?.writeText === undefined) throw new Error('clipboard unavailable')
              await globalThis.navigator.clipboard.writeText(patch)
              setCopied(true)
              setCopyNote(null)
            } catch {
              setCopyNote(t('copy_failed'))
            }
          }
          return h('section', { className: 'dw7-section' },
            h('style', null, CSS),
            h('div', { className: 'dw7-head' },
              h('h4', { className: 'dw7-title' }, t('diagnostics_title')),
              snap.at ? h('span', { className: 'dw7-count' }, t('refreshed_at', { at: snap.at })) : null,
              h('button', {
                className: 'dw7-small dw7-head-action',
                onClick: () => void refresh(),
                disabled: snap.state === 'loading',
              }, snap.state === 'loading' ? t('redetecting') : t('redetect'))),
            report !== ''
              ? h('p', { className: 'dw7-report' }, report)
              : snap.error !== null
                ? h('p', { className: 'dw7-error' }, t('status_error', { error: snap.error }))
                : h('p', { className: 'dw7-empty' }, snap.state === 'loading' ? t('status_loading') : t('status_empty')),
            snap.error !== null && report !== '' ? h('p', { className: 'dw7-error' }, t('status_error', { error: snap.error })) : null,
            patch !== null
              ? h('div', { className: 'dw7-patch' },
                h('div', { className: 'dw7-patch-head' },
                  h('p', { className: 'dw7-patch-note' }, t('patch_note')),
                  h('button', { className: 'dw7-small', onClick: () => void copyPatch() }, copied ? t('copied') : t('copy_patch')),
                  copyNote ? h('span', { className: 'dw7-error' }, copyNote) : null),
                h('pre', { className: 'dw7-code' }, patch))
              : null,
          )
        }

        function ConfigureCard(props) {
          // Bound wrappers, built once at apply time: the controller's methods are class methods —
          // passing them as bare references detaches `this` and the snapshot read crashes
          // (`cannot read 'store'`) — and their identity has to stay stable across renders.
          const snap = useSyncExternalStore(formSubscribe, formSnapshot)
          const [draft, setDraft] = useState(null) // null = follow the Host snapshot
          const [busy, setBusy] = useState(false)
          const [savedAt, setSavedAt] = useState(null)
          const [note, setNote] = useState(null)

          if (props?.view === 'summary') return null

          const loading = snap.status === 'loading'
          const unavailable = snap.status === 'unavailable'
          const served = {
            overridePath: typeof snap.value?.overridePath === 'string' ? snap.value.overridePath : '',
          }
          const values = draft ?? served
          const dirty = draft !== null && values.overridePath !== served.overridePath
          const editable = !loading && !unavailable && snap.writable !== false && !busy

          async function save() {
            setBusy(true)
            setNote(null)
            try {
              let ok = true
              const nextPath = values.overridePath.trim()
              if (nextPath === '') {
                if (served.overridePath !== '') ok = await form.unset('overridePath') && ok
              } else if (nextPath !== served.overridePath) {
                ok = await form.set('overridePath', nextPath) && ok
              }
              if (ok) {
                setDraft(null)
                setSavedAt(new Date().toLocaleTimeString())
              } else {
                setNote(t('save_rejected'))
              }
            } catch (error) {
              setNote(describe(error))
            } finally {
              setBusy(false)
            }
          }

          return h('section', { className: 'dw7-section' },
            h('style', null, CSS),
            h('div', { className: 'dw7-head' },
              h('h4', { className: 'dw7-title' }, t('card_title'))),
            loading || unavailable
              ? h('p', { className: 'dw7-empty' }, loading ? t('form_loading') : t('form_unavailable'))
              : [
                h('div', { className: 'dw7-field', key: 'overridePath' },
                  h('label', { className: 'dw7-label', htmlFor: 'dw7-override-path' }, t('field_overridePath')),
                  h('input', {
                    id: 'dw7-override-path',
                    className: 'dw7-input',
                    type: 'text',
                    spellCheck: false,
                    value: values.overridePath,
                    disabled: !editable,
                    placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                    onChange: (event) => {
                      setDraft({ overridePath: event.target.value })
                      setNote(null)
                      setSavedAt(null)
                    },
                  }),
                  h('p', { className: 'dw7-hint' }, t('overridePath_hint'))),
                h('div', { className: 'dw7-actions', key: 'actions' },
                  h('button', {
                    className: 'dw7-save',
                    onClick: () => void save(),
                    disabled: !editable || (!dirty && note === null),
                  }, t('save')),
                  h('button', {
                    className: 'dw7-reset',
                    onClick: () => {
                      setDraft(null)
                      setNote(null)
                      setSavedAt(null)
                    },
                    disabled: !editable || (!dirty && note === null),
                  }, t('reset')),
                  snap.writable === false ? h('span', { className: 'dw7-error' }, t('unwritable')) : null,
                  savedAt ? h('span', { className: 'dw7-ok' }, t('saved', { at: savedAt })) : null,
                  note ? h('span', { className: 'dw7-error' }, note) : null),
              ],
          )
        }

        // ---- registrations (alive while the row is enabled; disposed with the fiber) ----
        ctx.effect(() => disposeLocale, 'dsh-win-pwsh7: client locale namespace')
        ctx.effect(() => {
          const disposers = [
            ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
              name: 'plugins.row.config',
              key: SLOT_KEY,
              locale: PACKAGE,
            }, ConfigureCard)),
            ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
              name: 'plugins.detail.section',
              id: PACKAGE + '.diagnostics',
              order: 50,
              locale: PACKAGE,
            }, DiagnosticsSection)),
          ]
          return () => {
            for (const dispose of disposers) dispose?.()
          }
        }, 'dsh-win-pwsh7: plugin page sections')
      },
    }
  },
})
