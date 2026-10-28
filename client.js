// client.js — the browser half of dsh-win-pwsh7: the configure cards and the status card
// on the plugin pages. Both use the same chrome as the installed dsh-ops branch — a 0.5px
// hairline card on radius-lg, a shaded card body, 13px/600 titles and max-content fact
// labels — while the Host page keeps its own 32px rhythm between detail sections.
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
    const { Switch } = require('@deepseek-ai/dsh-client-ui-primitives')
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
      status_error: 'Detection failed: {error}',
      refreshed_at: 'refreshed {at}',
      status_ready: 'Ready',
      status_denied: 'Blocked',
      status_detecting: 'Detecting',
      status_row_status: 'Status',
      status_row_runtime: 'Runtime',
      status_row_path: 'Executor',
      status_no_runtime: 'PowerShell 7 not found',
      status_no_path: 'Not resolved',
      status_lead_ready: 'The pwsh tool is allowed and will use the runtime below.',
      status_lead_windows: 'The pwsh tool is blocked: the executor still resolves to Windows PowerShell {version}.',
      status_lead_no_ps7: 'The pwsh tool is blocked: no usable PowerShell 7 was found.',
      status_lead_broken: 'The pwsh tool is blocked: the executor pins a path that does not exist.',
      status_lead_unknown: 'The PowerShell runtime the executor will use could not be determined.',
      status_lead_detecting: 'Detecting the PowerShell runtime…',
      status_note_ready: 'The pwsh tool is allowed only when the executor really resolves PowerShell 7 or newer.',
      status_note_store: 'The path is the version-stable Store family alias, so Store updates do not move it. AppInfo activation is undocumented; if it stops working, run pwsh7_install or pin an ordinary pwsh.exe.',
      status_note_denied: 'Press Re-detect to refresh; or have the model call pwsh7_status for the wiring patch and install guidance.',
      status_note_broken: 'Replace or remove that pwshPath, or run pwsh7_install again.',
      status_note_detecting: 'The first detection usually finishes quickly.',
      redetect: 'Re-detect',
      redetecting: 'Detecting…',
      card_title: 'Configuration',
      executor_title: 'PowerShell 7 executor',
      executor_hint: 'The runtime the pwsh tool runs. This page only probes and recommends; the profile patch in the status section does the wiring.',
      field_overridePath: 'PowerShell 7 path',
      overridePath_hint: 'Optional explicit pwsh.exe path (`overridePath`). Empty = auto-detect. It must spawn and report PowerShell 7 or newer; the Store family alias is accepted, while a version-numbered Store path is never pinned. This only changes what the plugin probes and recommends — it does not wire the pwsh tool. Use the patch in the status section for that.',
      field_dshOpsCompat: 'Coexist with dsh-ops',
      dshOpsCompat_hint: 'On by default. Keeps the native pwsh tool beside ops_bash by enabling dsh-ops Compatibility and hiding its duplicate official tools. Requires a DSH restart.',
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
      status_error: '检测失败：{error}',
      refreshed_at: '刷新于 {at}',
      status_ready: '已就绪',
      status_denied: '未就绪',
      status_detecting: '检测中',
      status_row_status: '状态',
      status_row_runtime: '运行时',
      status_row_path: '执行器',
      status_no_runtime: '未检测到 PowerShell 7',
      status_no_path: '未解析到路径',
      status_lead_ready: 'pwsh 工具已放行，将使用下面的运行时执行。',
      status_lead_windows: 'pwsh 工具已被拦截：执行器仍解析到 Windows PowerShell {version}。',
      status_lead_no_ps7: 'pwsh 工具已被拦截：没有可用的 PowerShell 7。',
      status_lead_broken: 'pwsh 工具已被拦截：执行器 pin 的路径不可用。',
      status_lead_unknown: '尚无法确认执行器将运行的 PowerShell 版本。',
      status_lead_detecting: '正在检测 PowerShell 运行时…',
      status_note_ready: '只有实际解析到 PowerShell 7 及以上时，pwsh 工具才会放行。',
      status_note_store: '该路径是版本稳定的 Store 家族别名，Store 更新不会移动它。AppInfo 激活是未公开行为；如果失效，请运行 pwsh7_install 或 pin 普通 pwsh.exe。',
      status_note_denied: '点「重新检测」刷新；或让模型调用 pwsh7_status 获取接线补丁与安装指引。',
      status_note_broken: '请更换或移除该 pwshPath，或重新运行 pwsh7_install。',
      status_note_detecting: '首次检测通常很快。',
      redetect: '重新检测',
      redetecting: '检测中…',
      card_title: '配置',
      executor_title: 'PowerShell 7 执行器',
      executor_hint: 'pwsh 工具实际运行的 PowerShell。本页只做探测与推荐；接线用状态区里的 profile 补丁。',
      field_overridePath: 'PowerShell 7 路径',
      overridePath_hint: '可选的显式 pwsh.exe 路径（`overridePath`）。留空 = 自动探测。必须能启动并报告 PowerShell 7 及以上；Store 家族别名可用，版本号目录永不被 pin。这里只影响插件的探测与推荐，不会给 pwsh 工具接线；接线请用状态区里的补丁。',
      field_dshOpsCompat: '与 dsh-ops 共存',
      dshOpsCompat_hint: '默认开启。通过启用 dsh-ops 的 Compatibility 模式并隐藏重复的官方工具，让原生 pwsh 与 ops_bash 并存。需要重启 DSH。',
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
.dw7-settings{display:flex;flex-direction:column;gap:12px;min-width:0;color:var(--dsw-alias-label-primary);font:inherit;}
.dw7-settings p{margin:0;line-height:1.55;overflow-wrap:anywhere;}
.dw7-group{display:flex;flex-direction:column;min-width:0;}
.dw7-card{border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px;gap:10px;}
.dw7-group-head{display:flex;align-items:flex-start;gap:16px;min-width:0;}
.dw7-card .dw7-group-head{align-items:flex-start;}
.dw7-group-head .dw7-field-text{display:flex;flex-direction:column;flex:1 1 auto;min-width:0;gap:2px;}
.dw7-group-head > button[role=switch]{flex:none;margin-top:1px;}
.dw7-group-title{margin:0 0 4px;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-secondary);}
.dw7-card .dw7-group-title{margin:0;}
.dw7-card-body{display:flex;flex-direction:column;min-width:0;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);}
.dw7-card-body > .dw7-field{padding:10px 0;}
.dw7-card-body > .dw7-field:first-child{padding-top:0;}
.dw7-card-body > .dw7-field:last-child{padding-bottom:0;}
.dw7-card-body .dw7-field + .dw7-field{border-top:.5px solid var(--dsw-alias-border-l2);}
.dw7-field{display:flex;flex-direction:column;gap:6px;padding:12px 0;min-width:0;}
.dw7-field + .dw7-field{border-top:.5px solid var(--dsw-alias-border-l2);}
.dw7-field-text{display:flex;flex-direction:column;flex:1 1 auto;gap:4px;min-width:0;}
.dw7-field-label{font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary);}
.dw7-field-hint{margin:0;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-tertiary);}
.dw7-input{box-sizing:border-box;width:100%;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:1.5;}
.dw7-input:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary);}
.dw7-input:disabled{color:var(--dsw-alias-label-tertiary);cursor:default;}
.dw7-input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary);}
.dw7-field-error{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary);}
.dw7-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px;}
.dw7-save{appearance:none;border:1px solid transparent;border-radius:var(--dsw-radius-md);padding:5px 14px;font:inherit;font-size:13px;line-height:1.5;cursor:pointer;background:var(--dsw-alias-label-primary);color:var(--dsw-alias-bg-layer-3);}
.dw7-save:disabled{opacity:.4;cursor:default;}
.dw7-reset{border:none;background:none;padding:0;font:inherit;font-size:12px;line-height:1.5;color:var(--dsw-alias-label-secondary);cursor:pointer;}
.dw7-reset:disabled{opacity:.4;cursor:default;}
.dw7-small{box-sizing:border-box;height:28px;padding:0 10px;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-sm);background:transparent;font:inherit;font-size:12px;line-height:18px;color:var(--dsw-alias-label-primary);cursor:pointer;}
.dw7-small:disabled{opacity:.4;cursor:not-allowed;}
.dw7-detail{display:flex;flex-direction:column;gap:12px;min-width:0;}
.dw7-detail-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0;}
.dw7-detail-title{margin:0;flex:none;font-size:13px;font-weight:600;line-height:20px;color:var(--dsw-alias-label-primary);}
.dw7-detail-metric{font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);}
.dw7-detail-action{margin-left:auto;flex:none;}
.dw7-status-card{display:flex;flex-direction:column;gap:10px;padding:14px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);min-width:0;}
.dw7-status-body{padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);min-width:0;}
.dw7-status-lead{margin:0 0 12px;color:var(--dsw-alias-label-secondary);font-size:13px;line-height:1.6;}
.dw7-facts{display:grid;gap:6px;margin:0;}
.dw7-facts > div{display:grid;grid-template-columns:max-content minmax(0,1fr);align-items:baseline;column-gap:14px;}
.dw7-facts dt{color:var(--dsw-alias-label-tertiary);font-size:13px;}
.dw7-facts dd{margin:0;overflow-wrap:anywhere;font-size:13px;}
.dw7-status-note{margin:12px 0 0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.6;}
.dw7-note{margin:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary);}
.dw7-report{margin:0;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.dw7-error{margin:0;color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:18px;overflow-wrap:anywhere;}
.dw7-ok{margin:0;color:var(--dsw-alias-state-success-primary);font-size:12px;line-height:1.5;}
.dw7-preview{display:flex;flex-direction:column;gap:10px;padding:12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-interactive-bg-hover);font-size:13px;}
.dw7-preview-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;min-width:0;}
.dw7-preview-note{margin:0;flex:1;min-width:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:1.5;}
.dw7-code{box-sizing:border-box;margin:0;padding:10px 12px;border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-wrap:anywhere;}
.dw7-save:focus-visible,.dw7-reset:focus-visible,.dw7-small:focus-visible,.dw7-input:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px;}
@media(max-width:440px){.dw7-facts > div{grid-template-columns:1fr;gap:2px;}}
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
        let snapshot = { state: 'idle', report: null, error: null, at: null, gate: null }
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
          diagnostics.set({ state: 'loading', report: previous.report, error: null, at: previous.at, gate: previous.gate })
          try {
            const out = await callStatus()
            const gate = out?.gate !== null && typeof out?.gate === 'object' ? out.gate : null
            diagnostics.set({ state: 'ready', report: typeof out?.report === 'string' ? out.report : '', error: null, at: new Date().toLocaleTimeString(), gate })
          } catch (error) {
            diagnostics.set({ state: 'error', report: previous.report, error: describe(error), at: previous.at, gate: previous.gate })
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

        /** Map the Host gate onto the short status card: lead sentence, status facts, footnote. */
        function statusView(gate, t) {
          const reason = gate?.reasonCode
          if (gate === null || gate === undefined || gate.state === 'unknown' || reason === 'detecting') {
            return {
              status: t('status_detecting'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_detecting'),
              note: t('status_note_detecting'),
            }
          }
          if (gate.state === 'allow') {
            return {
              status: t('status_ready'),
              runtime: gate.version === undefined ? t('status_no_runtime') : `PowerShell ${gate.version}`,
              lead: t('status_lead_ready'),
              note: gate.origin === 'store-alias' ? t('status_note_store') : t('status_note_ready'),
            }
          }
          if (reason === 'windows-powershell') {
            return {
              status: t('status_denied'),
              runtime: gate.version === undefined ? t('status_no_runtime') : `Windows PowerShell ${gate.version}`,
              lead: t('status_lead_windows', { version: gate.version ?? '' }),
              note: t('status_note_denied'),
            }
          }
          if (reason === 'broken-pin') {
            return {
              status: t('status_denied'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_broken'),
              note: t('status_note_broken'),
            }
          }
          if (reason === 'no-ps7') {
            return {
              status: t('status_denied'),
              runtime: t('status_no_runtime'),
              lead: t('status_lead_no_ps7'),
              note: t('status_note_denied'),
            }
          }
          return {
            status: t('status_denied'),
            runtime: t('status_no_runtime'),
            lead: t('status_lead_unknown'),
            note: t('status_note_denied'),
          }
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
          const view = statusView(snap.gate, t)
          const path = typeof snap.gate?.path === 'string' && snap.gate.path !== '' ? snap.gate.path : null
          // A client half can briefly run against an older Host half (HMR or a skipped restart):
          // that Host answers only `report`, so fall back to it instead of inventing facts.
          const fallback = (snap.gate === null || snap.gate === undefined) && report !== ''
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
          const patchBlock = patch !== null
            ? h('div', { className: 'dw7-preview' },
              h('div', { className: 'dw7-preview-head' },
                h('p', { className: 'dw7-preview-note' }, t('patch_note')),
                h('button', { type: 'button', className: 'dw7-small', onClick: () => void copyPatch() }, copied ? t('copied') : t('copy_patch')),
                copyNote ? h('span', { className: 'dw7-error' }, copyNote) : null),
              h('pre', { className: 'dw7-code' }, patch))
            : null
          const body = fallback
            ? h('p', { className: 'dw7-report', key: 'report' }, report)
            : h('div', { className: 'dw7-status-body', key: 'body' },
              h('p', { className: 'dw7-status-lead' }, view.lead),
              h('dl', { className: 'dw7-facts' },
                h('div', { key: 'status' },
                  h('dt', null, t('status_row_status')),
                  h('dd', null, view.status)),
                h('div', { key: 'runtime' },
                  h('dt', null, t('status_row_runtime')),
                  h('dd', null, view.runtime)),
                h('div', { key: 'path' },
                  h('dt', null, t('status_row_path')),
                  h('dd', null, path ?? t('status_no_path')))),
              h('p', { className: 'dw7-status-note' }, view.note))
          return h('section', { className: 'dw7-detail' },
            h('style', null, CSS),
            h('div', { className: 'dw7-status-card' },
              h('div', { className: 'dw7-detail-head' },
                h('h3', { className: 'dw7-detail-title' }, t('diagnostics_title')),
                snap.at ? h('span', { className: 'dw7-detail-metric' }, t('refreshed_at', { at: snap.at })) : null,
                h('button', {
                  type: 'button',
                  className: 'dw7-small dw7-detail-action',
                  onClick: () => void refresh(),
                  disabled: snap.state === 'loading',
                }, snap.state === 'loading' ? t('redetecting') : t('redetect'))),
              body,
              patchBlock,
              snap.error !== null ? h('p', { className: 'dw7-error' }, t('status_error', { error: snap.error })) : null),
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
            dshOpsCompat: snap.value?.dshOpsCompat !== false,
          }
          const values = draft ?? served
          const dirty = draft !== null && (values.overridePath !== served.overridePath || values.dshOpsCompat !== served.dshOpsCompat)
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
              if (values.dshOpsCompat !== served.dshOpsCompat) {
                ok = await form.set('dshOpsCompat', values.dshOpsCompat) && ok
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

          return h('form', {
            className: 'dw7-settings',
            onSubmit: (event) => {
              event.preventDefault()
              void save()
            },
          },
            h('style', null, CSS),
            loading || unavailable
              ? h('p', { className: 'dw7-note' }, loading ? t('form_loading') : t('form_unavailable'))
              : [
                h('section', { className: 'dw7-group dw7-card', key: 'executor' },
                  h('div', { className: 'dw7-group-head' },
                    h('div', { className: 'dw7-field-text' },
                      h('h4', { className: 'dw7-group-title' }, t('executor_title')),
                      h('p', { className: 'dw7-field-hint' }, t('executor_hint')))),
                  h('div', { className: 'dw7-card-body' },
                    h('div', { className: 'dw7-field' },
                      h('label', { className: 'dw7-field-label', htmlFor: 'dw7-override-path' }, t('field_overridePath')),
                      h('input', {
                        id: 'dw7-override-path',
                        className: 'dw7-input',
                        type: 'text',
                        spellCheck: false,
                        value: values.overridePath,
                        disabled: !editable,
                        placeholder: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
                        onChange: (event) => {
                          setDraft({ ...values, overridePath: event.target.value })
                          setNote(null)
                          setSavedAt(null)
                        },
                      }),
                      h('p', { className: 'dw7-field-hint' }, t('overridePath_hint'))))),
                h('section', { className: 'dw7-group dw7-card', key: 'compat' },
                  h('div', { className: 'dw7-group-head' },
                    h('div', { className: 'dw7-field-text' },
                      h('h4', { className: 'dw7-group-title' }, t('field_dshOpsCompat')),
                      h('p', { className: 'dw7-field-hint' }, t('dshOpsCompat_hint'))),
                    h(Switch, {
                      checked: values.dshOpsCompat,
                      disabled: !editable,
                      label: t('field_dshOpsCompat'),
                      onChange: (checked) => {
                        setDraft({ ...values, dshOpsCompat: checked })
                        setNote(null)
                        setSavedAt(null)
                      },
                    }))),
                h('div', { className: 'dw7-actions', key: 'actions' },
                  h('button', {
                    type: 'submit',
                    className: 'dw7-save',
                    disabled: !editable || (!dirty && note === null),
                  }, t('save')),
                  h('button', {
                    type: 'button',
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
