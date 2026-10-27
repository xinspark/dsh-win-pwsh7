// client.js — the browser half of dsh-win-pwsh7: the configure card, the diagnostics
// section, and the re-detect action on the plugin pages.
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
      field_installIfMissing: 'Install when missing (installIfMissing)',
      overridePath_hint: 'Priority ① explicit pwsh.exe path. Empty = auto-detect. It must spawn and report PowerShell 7 or newer; the Store family alias is accepted, while a version-numbered Store path is never pinned. This only changes what the plugin probes and recommends — it does not wire the pwsh tool. Use the patch in the status section for that.',
      installIfMissing_hint: 'When nothing usable exists, install the self-updating Microsoft Store package through winget at startup. Default off.',
      save: 'Save',
      reset: 'Reset',
      saved: 'Saved {at}',
      save_rejected: 'The Host rejected the write.',
      form_loading: 'Loading configuration…',
      form_unavailable: 'Configuration is not available right now.',
      unwritable: 'The Host is not accepting writes for this row.',
      error_remote_unavailable: 'the Remote service is not available in this deployment',
      error_endpoint_missing: 'the status endpoint is not mounted',
      network_metered: 'Network: metered — turn off "Metered connection" for this network, then Re-detect.',
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
      field_installIfMissing: '缺失时安装（installIfMissing）',
      overridePath_hint: '优先级①的显式 pwsh.exe 路径。留空 = 自动探测。必须能启动并报告 PowerShell 7 及以上；Store 家族别名可用，版本号目录永不被 pin。这里只影响插件的探测与推荐，不会给 pwsh 工具接线；接线请用状态区里的补丁。',
      installIfMissing_hint: '本机没有可用 PowerShell 7 时，启动期经 winget 安装商店版（随 Windows 自更新）。默认关闭。',
      save: '保存',
      reset: '重置',
      saved: '已保存 {at}',
      save_rejected: 'Host 拒绝了这次写入。',
      form_loading: '配置读取中…',
      form_unavailable: '配置暂不可用。',
      unwritable: 'Host 当前不接受该行的写入。',
      error_remote_unavailable: '本部署没有可用的 Remote 服务',
      error_endpoint_missing: '状态端点未挂载',
      network_metered: '网络：计量连接——关闭该网络的「按流量计费的连接」后重新检测。',
      copy_patch: '复制补丁',
      copied: '已复制',
      copy_failed: '复制失败——请手动选中补丁文本复制。',
      patch_note: '把这段粘贴进 profile 补丁并重启 DSH；config 会整体替换该行的配置。',
    }

    const CSS_CARD = `
.dw7-card{display:flex;flex-direction:column;gap:14px;padding:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;}
.dw7-card-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;margin:0;}
.dw7-field{display:flex;flex-direction:column;gap:4px;min-width:0;}
.dw7-label{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:600;}
.dw7-hint{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}
.dw7-inputrow{display:flex;align-items:center;gap:8px;}
.dw7-input{flex:1;min-width:0;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);padding:6px 10px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;}
.dw7-input:focus{outline:none;border-color:var(--dsw-alias-brand-primary);}
.dw7-input:disabled{opacity:.55;}
.dw7-switch{position:relative;width:36px;height:20px;border-radius:10px;border:none;background:var(--dsw-alias-border-l1);cursor:pointer;padding:0;flex:none;}
.dw7-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary);}
.dw7-switch:disabled{opacity:.55;cursor:default;}
.dw7-knob{position:absolute;top:2px;left:2px;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:left .15s ease;}
.dw7-switch[aria-checked="true"] .dw7-knob{left:18px;}
.dw7-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.dw7-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;}
.dw7-btn:disabled{opacity:.55;cursor:default;}
.dw7-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
.dw7-ok{color:var(--dsw-alias-state-success-primary);font-size:12px;}
.dw7-note{color:var(--dsw-alias-state-error-primary);font-size:12px;}
`

    const CSS_DIAG = `
/* The Re-detect button lives in this section's own slot group ({@link RedetectAction}) but the
   page it renders on may never render the configure card, so the button rules are defined here as
   well as in CSS_CARD: a style element only applies while it is mounted. */
.dw7-diag{display:flex;flex-direction:column;gap:8px;padding:16px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0;}
.dw7-diag-head{display:flex;align-items:baseline;gap:12px;flex-wrap:wrap;}
.dw7-diag-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:600;}
.dw7-diag-at{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dw7-diag-report{margin:0;padding:12px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.55;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;max-height:320px;overflow:auto;}
.dw7-diag-err{color:var(--dsw-alias-state-error-primary);font-size:12px;}
.dw7-diag-idle{color:var(--dsw-alias-label-secondary);font-size:12px;}
.dw7-diag-net{color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;border-left:3px solid var(--dsw-alias-state-error-primary);padding-left:8px;}
.dw7-diag-fix{display:flex;flex-direction:column;gap:6px;padding:10px;background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:6px;min-width:0;}
.dw7-diag-fix-title{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.5;}
.dw7-diag-patch{margin:0;padding:10px;background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l1);border-radius:4px;color:var(--dsw-alias-label-primary);font-size:12px;line-height:1.5;white-space:pre-wrap;word-break:break-all;font-family:ui-monospace,SFMono-Regular,Consolas,monospace;max-height:180px;overflow:auto;}
.dw7-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
/* The Re-detect button belongs to this section's slot group, and the page it renders on may never
   render the configure card — so the button rules are defined here as well as in CSS_CARD, because
   a style element only applies while it is mounted. */
.dw7-btn{background:var(--dsw-alias-brand-primary);color:var(--dsw-alias-bg-base);border:none;border-radius:6px;padding:6px 14px;font-size:13px;cursor:pointer;}
.dw7-btn:disabled{opacity:.55;cursor:default;}
.dw7-btn-ghost{background:transparent;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);}
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

        /** One diagnostics line per snapshot state — an if-chain, so each state maps to one line. */
        function bodyFor(snap, t) {
          if (snap.state === 'loading' && !snap.report) return t('status_loading')
          if (snap.report !== null && snap.report !== '') return snap.report
          if (snap.error !== null) return t('status_error', { error: snap.error })
          return '' // the idle line below carries this message, once
        }

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
          const body = bodyFor(snap, t)
          const report = typeof snap.report === 'string' ? snap.report : ''
          const patch = patchFromReport(report)
          const metered = /Metered connection|marked as metered/u.test(report)
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
          return h('section', { className: 'dw7-diag' },
            h('style', null, CSS_DIAG),
            h('div', { className: 'dw7-diag-head' },
              h('span', { className: 'dw7-diag-title' }, t('diagnostics_title')),
              snap.at ? h('span', { className: 'dw7-diag-at' }, t('refreshed_at', { at: snap.at })) : null),
            h('pre', { className: 'dw7-diag-report' }, body),
            metered ? h('div', { className: 'dw7-diag-net' }, t('network_metered')) : null,
            patch !== null
              ? h('div', { className: 'dw7-diag-fix' },
                h('div', { className: 'dw7-diag-fix-title' }, t('patch_note')),
                h('pre', { className: 'dw7-diag-patch' }, patch),
                h('div', { className: 'dw7-actions' },
                  h('button', { className: 'dw7-btn dw7-btn-ghost', onClick: () => void copyPatch() }, copied ? t('copied') : t('copy_patch')),
                  copyNote ? h('span', { className: 'dw7-note' }, copyNote) : null))
              : null,
            snap.error !== null && snap.report ? h('div', { className: 'dw7-diag-err' }, t('status_error', { error: snap.error })) : null,
            snap.report === null && snap.error === null && snap.state !== 'loading' ? h('div', { className: 'dw7-diag-idle' }, t('status_empty')) : null,
          )
        }

        function RedetectAction(props) {
          const pkg = props?.subject?.pkg
          const active = pkg === PACKAGE || pkg?.name === PACKAGE
          const snap = useSyncExternalStore(diagnostics.subscribe, diagnostics.get)
          if (!active) return null
          const loading = snap.state === 'loading'
          return h('button', {
            className: 'dw7-btn dw7-btn-ghost',
            onClick: () => void refresh(),
            disabled: loading,
          }, loading ? t('redetecting') : t('redetect'))
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
            installIfMissing: snap.value?.installIfMissing === true,
          }
          const values = draft ?? served
          const dirty = draft !== null && (values.overridePath !== served.overridePath || values.installIfMissing !== served.installIfMissing)
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
              if (values.installIfMissing !== served.installIfMissing) {
                ok = await form.set('installIfMissing', values.installIfMissing) && ok
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

          return h('div', { className: 'dw7-card' },
            h('style', null, CSS_CARD),
            h('p', { className: 'dw7-card-title' }, t('card_title')),
            loading || unavailable
              ? h('p', { className: 'dw7-hint' }, loading ? t('form_loading') : t('form_unavailable'))
              : [
                h('div', { className: 'dw7-field', key: 'overridePath' },
                  h('label', { className: 'dw7-label', htmlFor: 'dw7-override-path' }, t('field_overridePath')),
                  h('div', { className: 'dw7-inputrow' },
                    h('input', {
                      id: 'dw7-override-path',
                      className: 'dw7-input',
                      type: 'text',
                      spellCheck: false,
                      value: values.overridePath,
                      disabled: !editable,
                      placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                      onChange: (event) => {
                        setDraft({ overridePath: event.target.value, installIfMissing: values.installIfMissing })
                        setNote(null)
                        setSavedAt(null)
                      },
                    })),
                  h('span', { className: 'dw7-hint' }, t('overridePath_hint'))),
                h('div', { className: 'dw7-field', key: 'installIfMissing' },
                  h('div', { className: 'dw7-inputrow' },
                    h('button', {
                      className: 'dw7-switch',
                      role: 'switch',
                      'aria-checked': values.installIfMissing,
                      disabled: !editable,
                      onClick: () => {
                        setDraft({ overridePath: values.overridePath, installIfMissing: !values.installIfMissing })
                        setNote(null)
                        setSavedAt(null)
                      },
                    }, h('span', { className: 'dw7-knob' })),
                    h('label', { className: 'dw7-label' }, t('field_installIfMissing'))),
                  h('span', { className: 'dw7-hint' }, t('installIfMissing_hint'))),
                h('div', { className: 'dw7-actions', key: 'actions' },
                  h('button', {
                    className: 'dw7-btn',
                    onClick: () => void save(),
                    disabled: !editable || (!dirty && note === null),
                  }, t('save')),
                  h('button', {
                    className: 'dw7-btn dw7-btn-ghost',
                    onClick: () => {
                      setDraft(null)
                      setNote(null)
                      setSavedAt(null)
                    },
                    disabled: !editable || (!dirty && note === null),
                  }, t('reset')),
                  snap.writable === false ? h('span', { className: 'dw7-note' }, t('unwritable')) : null,
                  savedAt ? h('span', { className: 'dw7-ok' }, t('saved', { at: savedAt })) : null,
                  note ? h('span', { className: 'dw7-note' }, note) : null),
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
            ctx.slots.inject('plugins.detail.actions', () => ctx.slots.register({
              name: 'plugins.detail.actions',
              id: PACKAGE + '.redetect',
              order: 50,
              locale: PACKAGE,
            }, RedetectAction)),
          ]
          return () => {
            for (const dispose of disposers) dispose?.()
          }
        }, 'dsh-win-pwsh7: plugin page cards')
      },
    }
  },
})
