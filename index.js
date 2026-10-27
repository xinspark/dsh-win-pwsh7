/**
 * dsh-win-pwsh7 — put a real, stable PowerShell 7 under the Harness `pwsh` tool on Windows.
 *
 * The Desktop executor adapter probes only `C:\Program Files\PowerShell\7\pwsh.exe`, PATH
 * entries, and the System32 Windows PowerShell 5.1 fallback. A Microsoft Store install is
 * reached through its execution alias, and Microsoft documents the Store package's first
 * benefit as automatic updating by Windows itself — so the Store is what this plugin
 * recommends, and the pin it suggests is the *family alias*
 * (`…\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe`), whose
 * directory carries no version and therefore survives updates. The alias-resolved package
 * executable under the version-numbered directory is never pinned: every Store update moves it.
 *
 * What it does:
 *
 * 1. Detect — auto-probe plus an optional user override (`overridePath` config, priority ①).
 *    Every candidate must be spawnable and report PowerShell ≥ 7; Store sources are labeled by
 *    form, and only the version-stable form counts as acceptable wiring.
 * 2. Validate a user-specified path — `pwsh7_status` takes an optional `path` argument and
 *    checks it on the spot.
 * 3. Install — `pwsh7_install` (agent tool) or `installIfMissing: true` (config, checked at
 *    activation) runs `winget` for the Microsoft Store package of PowerShell, whose documented
 *    first benefit is automatic updating by Windows itself. There is exactly one install path:
 *    the winget MSIX and the per-machine MSI were measured, rejected, and are kept in the README
 *    as history — never offered. The tool registers the install as a **background job** and
 *    returns its id, because the Store handoff waits indefinitely when Windows has marked the
 *    connection as metered (measured 2026-10-14; the Store logs nothing at all in that state):
 *    progress and output come from the platform's `job_output`, cancellation from `job_kill`.
 *    The same code reads the connection cost *before* it starts, so the report names that setting
 *    — and only that setting — instead of leaving a silent queue behind.
 *
 * It never writes the executor row's `pwshPath`: on Desktop both candidate rows refuse a
 * runtime write (the upstream row is disabled, the live row is owned by Desktop's generated
 * patch), so wiring the executor stays a patch edit you make. What it finds is exposed
 * through the two tools (`pwsh7_status`, `pwsh7_install`), through the plugin page's
 * diagnostics section, and through host logs under `dsh-win-pwsh7:`.
 *
 * It also tells the model which PowerShell the `pwsh` tool runs: a one-line prompt section
 * (`tool:pwsh-runtime`) says whether `&&` / `||` work, because they are valid in PowerShell 7
 * and parse errors in 5.1 — that fact is what makes the version worth pinning at all.
 * The tool's own schema description cannot carry it: `tools.register` rejects a duplicate
 * name in the same layer, the registry has no description hook, and `systemPrompt.tools()`
 * providers are concatenated rather than overridden (a second `pwsh` schema would duplicate
 * the tool). A section beside the shipped `tool:pwsh` note is the seam that exists.
 *
 * @module dsh-win-pwsh7
 */

import { lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Service } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolvePwshPath } from '@deepseek-ai/dsh-pwsh-local'
import z from '@deepseek-ai/schemastery'

export const name = 'dsh-win-pwsh7'
export const inject = ['subprocess', 'tools', 'configEditor', 'systemPrompt']

/**
 * Row configuration — volatile, so the configure card on the plugin page can edit both
 * values through configForms without a restart. Set them in the profile patch instead if
 * you prefer:
 *
 * - id: win-pwsh7
 *   config:
 *     overridePath: 'D:\tools\pwsh\pwsh.exe'   # priority ① — validated, must be an ordinary PowerShell 7+
 *     installIfMissing: true                    # install from the Microsoft Store when no ordinary PowerShell 7 exists
 */
export const Config = z.object({
  overridePath: z.string().volatile(),
  installIfMissing: z.boolean().default(false).volatile(),
})

/**
 * Profile rows that provide the PowerShell executor. Desktop disables the upstream row
 * and inserts its own adapter over it, so both are matched — by package name, never by
 * a hard-coded row id, because Desktop may rename its row.
 */
const EXECUTOR_PACKAGES = new Set([
  '@deepseek-ai/dsh-pwsh-sandbox',
  'dsh-plugin-desktop/windows-pwsh-sandbox',
])

/** The last-resort executable: the built-in Windows PowerShell 5.1. */
const WINDOWS_POWERSHELL_51 = /[\\/]WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu

/**
 * The version that path is. The `v1.0` directory name is historical; the binary there reports
 * 5.1, and it is only ever named without probing because the executor falls back to it when no
 * PowerShell 7 exists.
 */
const WINDOWS_POWERSHELL_51_VERSION = '5.1'

/** A Microsoft Store installation, in any of its on-disk forms (family alias or package directory). */
const EXECUTION_ALIAS = /[\\/]WindowsApps[\\/]/iu

/**
 * The *version-numbered* Store form —
 * `…\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe`. Every Store update
 * moves that path, so a patch pinning it silently stops working.
 *
 * The other Store form is the *family alias* —
 * `…\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe` — whose directory
 * is the package family name and therefore carries no version. That one is the stable pin.
 */
const STORE_VERSIONED = /[\\/]WindowsApps[\\/][^\\/]*_\d+\.\d+[^\\/]*__/iu

/** Lowest PowerShell major version this plugin is willing to use or recommend. */
const MINIMUM_MAJOR = 7 // PowerShell 7 "Core"; 5.1 is Windows PowerShell

/** Output cap for a version probe. */
const PROBE_MAX_BYTES = 4096

/** Output cap for a winget run. */
const INSTALL_MAX_BYTES = 65536

/** Grace period for a version probe. */
const PROBE_GRACE_MS = 5000

/** TERM-to-KILL grace for winget (which may ignore TERM); not a runtime timeout. */
const INSTALL_GRACE_MS = 30000

/** Job kind for a background install; `dsh-jobs-local` only requires a non-empty kind. */
const INSTALL_KIND = 'pwsh7'

/**
 * How long an install may run before the progress line calls it stalled. One measured Store run
 * sat about twelve minutes and was finished by hand in the Store, so the warning has to arrive
 * before that, while the user still has somewhere to go.
 */
const INSTALL_STALL_MS = 10 * 60 * 1000

/**
 * Read a millisecond override from the environment, refusing anything that is not a finite,
 * non-negative number. A malformed value used to become `NaN`, which `setInterval`/`setTimeout`
 * coerce to 0 — a busy loop that spawns probes back to back. Zero itself is legitimate (it means
 * "as soon as possible", which the gate relies on).
 * @param name - the environment variable name.
 * @param fallback - the value to use when it is absent or unusable.
 * @returns a finite, non-negative number of milliseconds.
 */
function envMs(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * How often the background job refreshes its progress line, and how often it re-reads winget's
 * diagnostic log. The environment override exists so the gate can run both fast.
 */
const INSTALL_TICK_MS = envMs('DSH_WIN_PWSH7_TICK_MS', 15000)

/**
 * How long to keep re-probing after winget exits, before believing a failed exit.
 *
 * winget's Store route reports failure while the Store finishes the install itself: two measured
 * runs ended with winget exiting 1 — one of them after twelve minutes — and PowerShell 7 was in
 * place a short while later, installed by `Microsoft.WindowsStore`. So a failed exit code is
 * evidence, not a verdict; the runtime is the verdict.
 */
const RECHECK_ATTEMPTS = 8

/** Delay between those re-probes; the environment override exists so the gate can run them fast. */
const RECHECK_DELAY_MS = envMs('DSH_WIN_PWSH7_RECHECK_MS', 15000)

/**
 * How long an **inline** install may block before the caller reports "still running" instead of
 * waiting. Activation gets a short grace — the host is starting and must not be held — while a
 * caller who asked for the install by hand gets longer. Without a bound, the winget→Store handoff
 * on a metered connection never returns at all (measured), which used to hang activation outright.
 */
const ACTIVATION_INSTALL_GRACE_MS = envMs('DSH_WIN_PWSH7_ACTIVATION_GRACE_MS', 15 * 1000)
const INLINE_INSTALL_GRACE_MS = envMs('DSH_WIN_PWSH7_INLINE_GRACE_MS', 120 * 1000)

/**
 * How long a gate reading is trusted before the next `pwsh` call refreshes it. A gate that is
 * merely stale may deny a machine whose runtime was just installed outside the plugin; waiting for a
 * status call is how the 0.12.3 prompt section behaved, and that is exactly the gap this closes.
 * The environment override keeps the gate fast in tests.
 */
const GATE_TTL_MS = envMs('DSH_WIN_PWSH7_GATE_TTL_MS', 60 * 1000)

/** The profile patch id whose config Desktop's generator copies into the live row. */
const SOURCE_ROW_ID = 'pwsh-sandbox'

/**
 * The one install path this plugin offers: the Microsoft Store package, the build Windows keeps up
 * to date by itself. There is no second route — an install the user cannot rely on is not an option
 * worth offering, and the alternatives this project measured are recorded in the README instead
 * (the winget MSIX, whose AppX stage fetches the bundle twice and timed out with `0x80072EE2`; the
 * per-machine MSI, which needs an interactive elevation this host process could not obtain, `1622`).
 *
 * One trap comes with the Store, and it was measured rather than guessed (2026-10-14): the Store
 * **defers app downloads on a metered connection**. With the active Wi-Fi profile reporting
 * `NetworkCostType = Fixed`, `winget install --source msstore` reached
 * `Started MSStore package execution` and then sat there indefinitely — the Store's own log showed
 * no warning or error at all, and its telemetry showed the request carried
 * `AllowDownloadOnAnyNetwork = 0`. The only run that progressed was the one a human started from
 * the Store UI (`IsInteractive = 1`, `…StartProductInstallWithOptionsForUserAsync`). After the
 * connection was un-marked as metered, the same non-interactive route installed in under a minute
 * (`IsInteractive = false`, `…WinGetCli-winget-StartProductInstallWithOptionsAsync`).
 *
 * So a stalled Store install is not a broken Store: it is this setting, and {@link METERED_COST}
 * exists so the plugin can say so instead of leaving the user to guess.
 */
const STORE_PRODUCT_ID = '9MZ1SNWT0N5D'

/** Connection-cost values that make Windows defer automatic downloads. */
const METERED_COST = new Set(['Fixed', 'Variable'])

/**
 * Ask the connection-cost API the Store itself consults, through Windows PowerShell 5.1 (always
 * present, and the only PowerShell that can reach WinRT from a script). The one line printed is
 * `<cost>|<profile>`; anything unreadable yields `undefined` and the caller stays silent rather
 * than guessing.
 */
const NETWORK_COST_SCRIPT = [
  '[Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime] | Out-Null',
  '$p = [Windows.Networking.Connectivity.NetworkInformation]::GetInternetConnectionProfile()',
  'if ($p -eq $null) { "Unknown|" } else { $p.GetConnectionCost().NetworkCostType.ToString() + "|" + $p.ProfileName }',
].join('; ')

/** The winget arguments for that one path. */
const STORE_ARGS = [
  'install',
  '--id', STORE_PRODUCT_ID,
  '--source', 'msstore',
  '--exact',
  '--accept-package-agreements',
  '--accept-source-agreements',
]

/** The same command as a line, for a user who would rather run it themselves. */
const STORE_COMMAND = `winget ${STORE_ARGS.join(' ')}`

/**
 * The second path, offered next to installing: if PowerShell 7 is not wanted on this machine, the
 * user can turn this plugin off. Saying so is part of the plugin's job — an agent that only knows
 * how to install would otherwise push an install nobody asked for.
 */
const DISABLE_PATH = [
  'Disable this plugin (the switch on its plugin page) if PowerShell 7 is not wanted here: its',
  'advice and its two tools then stop, and nothing is installed. The pwsh tool keeps failing while',
  'an executor row pins a path that does not exist, so that is a decision about pwsh itself.',
]

/**
 * The prompt section this plugin owns. Every tool contributes its model-facing guidance
 * under `tool:<name>` (that is how `dsh-tool-pwsh` publishes its exit-code note), and a
 * name of our own is required: a global duplicate in one layer throws, and agent-scoped
 * shadowing of `tool:pwsh` would replace the shipped note instead of adding to it.
 */
const HINT_SECTION = 'tool:pwsh-runtime'

/**
 * One line about the PowerShell `pwsh` actually runs — the fact the model needs *before* it
 * writes a pipeline, since `&&` is valid in PowerShell 7 and a parse error in 5.1.
 *
 * Written by {@link renderStatus} (the activation sweep, every tool call, and the plugin
 * page's Re-detect all pass through it) and read by the section thunk at assembly time, so
 * it follows a configuration change without a restart. Empty until a runtime is known.
 */
/**
 * Module-level by design: this plugin is one executor row in one host process, and the tools read
 * what the last `apply` recorded. Two applications in one process — a second row, or a hot reload —
 * would share this state and the newest one wins; moving it into the apply scope is the fix if that
 * ever becomes a real deployment. Recorded as backlog rather than refactored blind before a release.
 */
/**
 * Per-application runtime state, keyed by the Host context. The gate used to be module-level,
 * which was only true while one row existed in one process; the host gate applies several
 * fixtures in one process, and a second row or a hot reload has the same shape. Keeping the
 * reading beside the context is the smallest fix that makes the guard read its own application.
 */
const runtimeStates = new WeakMap()

/**
 * The runtime state for one row, created on first use.
 * @param ctx - the row's Host context.
 * @returns its gate snapshot and prompt note.
 */
function runtimeState(ctx) {
  let state = runtimeStates.get(ctx)
  if (state === undefined) {
    state = {
      gate: {
        state: 'unknown',
        version: undefined,
        path: undefined,
        source: 'unknown',
        reasonCode: 'detecting',
        at: 0,
      },
      runtimeNote: '',
      refreshing: null,
    }
    runtimeStates.set(ctx, state)
  }
  return state
}

/**
 * The output contract both tools share: the report is the whole payload, so the registry's
 * success path (`execute` → validate → `render`) turns it into one text block.
 *
 * `render` is not optional. `defineTool` installs its own wrapper that calls this function,
 * so a definition without one registers normally and then fails on **every** call with
 * `output.render failed: userRender is not a function`.
 * @returns a fresh output contract for one tool definition.
 */
function reportOutput() {
  return {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: { report: { type: 'string', required: true } },
    },
    render: (_args, value) => [{ type: 'text', text: value.report }],
  }
}

/**
 * Activate: sweep once (detect, install when configured, log the verdict), then publish the
 * two tools.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 */
export function apply(ctx, config) {
  if (process.platform !== 'win32') return

  // The row config is read live on every call, so edits from the configure card (a
  // volatile write through configForms) take effect without a restart.
  const current = () => readRowConfig(ctx, config)
  hostContext = ctx
  const state = runtimeState(ctx)

  ctx.effect(() => {
    void activationSweep(ctx, current()).then((report) => {
      ctx.logger?.info?.('dsh-win-pwsh7: %s', flattenReport(report))
    }, (error) => {
      ctx.logger?.warn?.('dsh-win-pwsh7: %s', describe(error))
    })
  }, 'dsh-win-pwsh7: detect PowerShell 7 (install the Store package when configured)')

  ctx.effect(() => {
    try {
      return ctx.systemPrompt.section({
        name: HINT_SECTION,
        // Beside the shipped `tool:pwsh` note, from the centrally owned placement table.
        order: ctx.systemPrompt.getSectionOrder('TOOL_PWSH'),
        text: () => state.runtimeNote,
      })
    } catch (error) {
      ctx.logger?.warn?.('dsh-win-pwsh7: could not register the prompt section: %s', describe(error))
      return
    }
  }, 'dsh-win-pwsh7: tell the model which PowerShell the pwsh tool runs')

  ctx.effect(() => {
    const cleanups = []
    try {
      cleanups.push(ctx.tools.register(defineTool({
        name: 'pwsh7_status',
        description:
          'Report which PowerShell the Harness pwsh tool runs on or can be pointed at on this Windows machine, ' +
          'and produce the exact profile patch for a pinnable one: an ordinary pwsh.exe or the version-stable ' +
          'Microsoft Store family alias, never a version-numbered Store path. ' +
          'Use it when PowerShell commands fail in unexpected ways, or before relying on `&&`.',
        parameters: {
          path: {
            type: 'string',
            description:
              'Validate this explicit pwsh.exe path. When it is usable and pinnable — an ordinary file, or the ' +
              'version-stable Store family alias — the suggested profile patch points at it.',
          },
        },
        output: reportOutput(),
        execute: async (args) => {
          const config = current()
          const status = await detect(ctx, config)
          const report = await renderStatus(ctx, config, { status, explicitPath: args?.path })
          // Only when there is nothing to run: that is when the one thing standing between the user
          // and a working tool is worth naming — and a metered connection is the trap that makes the
          // store route wait forever with no error anywhere. The cost (one Windows PowerShell 5.1
          // spawn) is paid only in this broken state, never on a healthy machine.
          if (status.chosen !== undefined) return { report }
          const warning = await meteredWarning(ctx)
          return { report: warning === undefined ? report : `${warning}\n\n${report}` }
        }
      })))
      cleanups.push(ctx.tools.register(defineTool({
        name: 'pwsh7_install',
        description:
          'Install PowerShell 7 from the Microsoft Store and return a background job id at once: read progress ' +
          'with job_output, stop it with job_kill. Its progress follows winget\'s own log, so the phases are ' +
          'named (downloading, deploying, registering) even though a captured stdout stays silent for minutes. ' +
          'Only run it when the user explicitly asks to install PowerShell 7. ' +
          'The Store is the plugin\'s only install path: Windows keeps that package up to date by itself, and ' +
          'there is no second installer to fall back to. On a connection marked as metered Windows defers ' +
          'Store downloads and the install waits forever, so the plugin reads the connection cost first and ' +
          'says so instead of hanging; the remedy is for the user to turn "Metered connection" off for that ' +
          'network and run this again — never a different installer. When PowerShell 7 is not wanted at all, ' +
          'the other answer is to disable this plugin. It needs winget and network, and never uninstalls ' +
          'anything.',
        // Present but empty: `defineTool` rejects a definition whose `parameters` is missing, and this
        // tool takes none — there is one install path and no route to choose.
        parameters: {},
        output: reportOutput(),
        execute: async (_args, exec) => ({ report: await runInstall(ctx, current(), exec) })
      })))
    } catch (error) {
      ctx.logger?.warn?.('dsh-win-pwsh7: could not register the tools: %s', describe(error))
      for (const cleanup of cleanups.splice(0)) cleanup?.()
      return
    }
    return () => {
      for (const cleanup of cleanups) cleanup?.()
    }
  }, 'dsh-win-pwsh7: pwsh7_status and pwsh7_install tools')

  // The gate is a global, synchronous guard: it sees every agent's `pwsh` call, including a
  // subagent's, and denies before the executor can spawn anything. `pwsh7_status` and
  // `pwsh7_install` are deliberately untouched — they are the recovery path.
  ctx.effect(() => {
    if (typeof ctx.tools.guard !== 'function') {
      ctx.logger?.warn?.('dsh-win-pwsh7: tools.guard is unavailable; pwsh calls will not be gated')
      return
    }
    return ctx.tools.guard((exec) => {
      if (exec.name !== 'pwsh') return
      if (state.gate.state === 'allow') return
      return denialText(state.gate)
    })
  }, 'dsh-win-pwsh7: gate pwsh until PowerShell 7 is effective')

  // Guards are synchronous; the pre-execute waterfall is the asynchronous half. It runs before the
  // guard, so a stale reading is refreshed *before* the guard reads it. Always `next()`: the guard
  // is the denial owner, not this listener.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    return ctx.on('tools/pre-execute', async (exec, next) => {
      if (exec.name !== 'pwsh') return next()
      try {
        if (state.gate.state === 'unknown' || Date.now() - state.gate.at > GATE_TTL_MS) {
          await refreshGate(ctx, current())
        }
      } catch {
        /* keep the last gate: fail closed */
      }
      return next()
    })
  }, 'dsh-win-pwsh7: refresh the gate before a pwsh call')

  // A config-card save or a profile patch edit re-composes the Loader; re-read the executor after
  // it settles so the gate follows without waiting for the TTL.
  ctx.effect(() => {
    if (typeof ctx.on !== 'function') return
    const disposers = [
      ctx.on('app-boot/config-reload', () => { void refreshGate(ctx, current()) }),
      ctx.on('plugin-manager/changed', () => { void refreshGate(ctx, current()) }),
    ]
    return () => {
      for (const dispose of disposers) dispose?.()
    }
  }, 'dsh-win-pwsh7: refresh the gate after a profile change')

  try {
    ctx.plugin(Pwsh7Dispatch)
  } catch (error) {
    ctx.logger?.warn?.('dsh-win-pwsh7: could not start the dispatch service: %s', describe(error))
  }
}

/** The row's live context for the dispatch service; refreshed on every activation. */
let hostContext = null

/**
 * Merge the row's current configuration over the captured activation defaults. The
 * configure card writes through configForms (a volatile write), so the row entry's config
 * is the live truth; the captured config only supplies the schema defaults.
 * @param ctx - the row's Host context.
 * @param fallback - the config captured at activation.
 * @returns the merged configuration.
 */
function readRowConfig(ctx, fallback) {
  const merged = {
    overridePath: typeof fallback?.overridePath === 'string' ? fallback.overridePath : undefined,
    installIfMissing: fallback?.installIfMissing === true,
  }
  try {
    const entry = ctx.configEditor.entries().find((candidate) => candidate?.options?.name === 'dsh-win-pwsh7')
    const values = entry?.options?.config
    if (isSet(values?.overridePath)) merged.overridePath = String(values.overridePath)
    if (typeof values?.installIfMissing === 'boolean') merged.installIfMissing = values.installIfMissing
  } catch { /* fall back to the captured config */ }
  return merged
}

/**
 * The Remote dispatch service the gateway calls as `ctx.get('dsh-win-pwsh7').status(args)`.
 * One operation, two callers: `status` runs the same {@link renderStatus} the agent tool
 * runs, so the UI and the tool can never disagree.
 */
class Pwsh7Dispatch extends Service {
  constructor(ctx) {
    super(ctx, 'dsh-win-pwsh7')
    // Build the binding only inside the constructor: cordis returns a proxy from `new`,
    // and a binding built afterwards would carry the proxy instead of this instance.
    this.typertRemote = Object.freeze({
      service: this,
      serviceKey: 'dsh-win-pwsh7',
      namespace: 'dsh-win-pwsh7',
    })
  }

  /**
   * One Remote endpoint: the current status report.
   * @returns a promise for `{ report }`, or an explicit message when the row is not active.
   */
  status() {
    const ctx = hostContext
    if (ctx === null) return Promise.resolve({ report: 'The dsh-win-pwsh7 row is not active.' })
    return renderStatus(ctx, readRowConfig(ctx, undefined)).then((report) => ({ report }))
  }
}

/**
 * Activation sweep: detect, and when `installIfMissing` is set and no ordinary PowerShell 7
 * is available, install from the Microsoft Store first. Never runs on a timer; every outcome is logged.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @returns the report text.
 */
async function activationSweep(ctx, config) {
  const status = await detect(ctx, config)
  if (config?.installIfMissing === true && status.chosen === undefined) {
    const pre = await preflightInstall(ctx)
    if (!pre.ok) {
      const detail = installBlockedDetail(pre)
      ctx.logger?.warn?.('dsh-win-pwsh7: installIfMissing is enabled but the preflight refused the install: %s', detail)
      return renderStatus(ctx, config, { installAttempt: { ok: false, detail } })
    }
    ctx.logger?.info?.('dsh-win-pwsh7: installIfMissing is enabled and no ordinary PowerShell 7 exists — starting the Microsoft Store install')
    const result = await installViaWinget(ctx, ACTIVATION_INSTALL_GRACE_MS)
    if (result.pending === true) {
      ctx.logger?.warn?.('dsh-win-pwsh7: %s', result.detail)
      return renderStatus(ctx, config, { installAttempt: { ok: false, detail: result.detail } })
    }
    // The exit code is evidence, not a verdict: the Store can finish after winget has exited,
    // so the sweep re-probes for a bounded while exactly as the background job does.
    const after = await awaitRuntime(ctx, config)
    const installAttempt = after.chosen === undefined
      ? { ok: false, detail: `${result.detail}; no usable PowerShell 7 appeared after re-probing` }
      : { ok: true, detail: result.detail }
    return renderStatus(ctx, config, { installAttempt })
  }
  return renderStatus(ctx, config, { status })
}

/**
 * Read the executable the `pwsh` tool will actually spawn, from the executor itself.
 *
 * `dsh-tool-pwsh` executes through `ctx.shell`; `PwshLocalExecutor.argv()` prefixes every command
 * with `this.pwshPath`, and that getter re-resolves when the declared config changes. It is the
 * authoritative "what will run" fact — more reliable than rebuilding the answer from
 * `configEditor.entries()`, which only exposes `include`-owned rows (a Desktop-generated live row
 * may not be addressable).
 *
 * `pwshPath` is a `PwshLocalExecutor` getter, not part of the `ShellExecutor` abstract seam, so the
 * read is feature-detected and falls back to the concrete config + resolver. When no shell service
 * is composed the caller keeps the legacy row-based reading.
 * @param ctx - the row's Host context.
 * @returns `{ path, version, origin, source }`, or `undefined` when there is no shell service.
 */
async function shellRuntimeReading(ctx) {
  const shell = ctx.get?.('shell')
  if (shell === undefined || shell === null) return undefined

  let path
  let source
  try {
    if (typeof shell.pwshPath === 'string' && shell.pwshPath.length > 0) {
      path = shell.pwshPath
      source = 'shell'
    } else {
      const declared = shell.config?.pwshPath?.get?.()
      if (isSet(declared)) {
        path = resolvePwshPath(declared, process.env, 'win32')
        source = 'shell-config'
      } else {
        path = resolvePwshPath(undefined, process.env, 'win32')
        source = 'resolver'
      }
    }
  } catch (error) {
    ctx.logger?.warn?.('dsh-win-pwsh7: could not read the executor path: %s', describe(error))
    return { path: undefined, version: undefined, origin: 'ordinary', source: 'shell' }
  }

  if (!isSet(path) || path === 'pwsh') return { path, version: undefined, origin: 'ordinary', source }
  const version = await probeVersion(ctx, path)
  return { path, version, origin: originOf(path), source }
}

/** The major version of a probed string, or `undefined` when it is not a version. */
function majorOf(version) {
  if (version === undefined) return undefined
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return Number.isSafeInteger(major) ? major : undefined
}

/**
 * Turn one reading into the gate snapshot. The executor reading wins when present; the row-based
 * reading is the fallback for compositions without a shell service (and for the existing gate
 * fixtures). A path that exists but reports no version is unknown, not a 5.1 verdict; a pinned path
 * that does not exist is named as such so the report can say "replace or remove it".
 * @param reading - `shellRuntimeReading()`'s result, or `undefined` without a shell.
 * @param rows - the probed executor rows, for the fallback.
 * @param status - the detection result, for the fallback.
 * @returns the gate snapshot.
 */
function gateFromReading(reading, rows, status) {
  const version = reading?.version ?? effectiveRuntime(rows, status)
  const path = reading?.path
  const source = reading?.source ?? 'rows'
  const at = Date.now()
  const candidate = [status?.override, status?.auto].find((value) => value?.usable === true && inPlace(value.origin))
  const recommended = candidate === undefined
    ? undefined
    : { path: candidate.path, version: candidate.version, origin: candidate.origin }
  const base = { version, path, source, at, recommended }

  if (version !== undefined && (majorOf(version) ?? 0) >= MINIMUM_MAJOR) {
    return { ...base, state: 'allow', reasonCode: 'ok' }
  }
  if (version !== undefined) {
    return { ...base, state: 'deny', reasonCode: 'windows-powershell' }
  }
  if (path !== undefined && !isSpawnable(path)) {
    return { ...base, state: 'deny', version: undefined, reasonCode: 'broken-pin' }
  }
  if (path !== undefined) {
    return { ...base, state: 'deny', version: undefined, reasonCode: 'unknown' }
  }
  const broken = rows.find((row) => row.pwshPath !== undefined && !isSpawnable(row.pwshPath))
  if (broken !== undefined) {
    return { ...base, state: 'deny', version: undefined, path: broken.pwshPath, source: 'rows', reasonCode: 'broken-pin' }
  }
  return { ...base, state: 'deny', version: undefined, path: undefined, reasonCode: 'no-ps7' }
}

/**
 * Refresh the gate from the executor (or the row fallback), one probe set at a time. This is the
 * only writer besides `renderStatus`, which sets the same snapshot from its own reading.
 * @param ctx - the row's Host context.
 * @param config - the live row configuration.
 * @returns the fresh gate snapshot.
 */
async function refreshGate(ctx, config) {
  const state = runtimeState(ctx)
  if (state.refreshing !== null) return state.refreshing
  state.refreshing = (async () => {
    try {
      const status = await detect(ctx, config)
      const rows = await executorRows(ctx)
      const reading = await shellRuntimeReading(ctx)
      state.gate = gateFromReading(reading, rows, status)
      state.runtimeNote = state.gate.version !== undefined ? hintFor(state.gate.version) : runtimeNoteFor(rows, status)
      return state.gate
    } catch (error) {
      state.gate = { state: 'deny', version: undefined, path: undefined, source: 'error', reasonCode: 'unknown', at: Date.now(), detail: describe(error) }
      ctx.logger?.warn?.('dsh-win-pwsh7: gate refresh failed: %s', describe(error))
      return state.gate
    } finally {
      state.refreshing = null
    }
  })()
  return state.refreshing
}

/**
 * The model-facing reason a `pwsh` call is denied. It is deliberately self-contained: the model
 * must be able to report the state and the three choices without first calling another tool, while
 * `pwsh7_status` remains the place for the exact patch.
 * @param reading - the gate snapshot.
 * @returns the denial reason (the registry wraps it as `Error: <reason>`).
 */
function denialText(reading) {
  const at = reading.path === undefined ? '' : ` (${reading.path})`
  const options = 'Do not retry. Tell the user PowerShell 7 must be installed or configured: call pwsh7_status for the exact profile patch, call pwsh7_install only after the user agrees, or disable dsh-win-pwsh7.'
  switch (reading.reasonCode) {
    case 'windows-powershell': {
      const available = reading.recommended
      const state = available === undefined
        ? `the pwsh tool would run Windows PowerShell ${reading.version}${at}`
        : `PowerShell ${available.version} is available at ${available.path}, but the executor would run Windows PowerShell ${reading.version}${at}`
      return `dsh-win-pwsh7 blocked this call: ${state}. ${options}`
    }
    case 'broken-pin':
      return `dsh-win-pwsh7 blocked this call: the pwsh tool cannot start — the executor pins ${reading.path}, which does not exist. Do not retry. Tell the user to replace or remove that pwshPath (pwsh7_status prints the patch), install PowerShell 7, or disable this plugin.`
    case 'no-ps7':
      return `dsh-win-pwsh7 blocked this call: no PowerShell 7 is installed or detectable, so the pwsh tool would fall back to Windows PowerShell 5.1. ${options}`
    case 'detecting':
      return 'dsh-win-pwsh7 is still detecting the PowerShell runtime; the call was not executed. Do not retry; call pwsh7_status, then try again.'
    default:
      return `dsh-win-pwsh7 blocked this call: the PowerShell runtime could not be determined${at}. Do not retry; call pwsh7_status to re-detect, then install PowerShell 7, fix the pinned path, or disable this plugin.`
  }
}

/**
 * Build the human-readable report: the requested path check (when asked), the configured
 * override, what the executor rows run today, and the recommendation — a patch for an
 * ordinary-file PowerShell 7, or the Microsoft Store install path for a Store-only machine.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @param options - `explicitPath` (tool argument), `status` (precomputed detection), `installAttempt`.
 * @returns the report text.
 */
async function renderStatus(ctx, config, options = {}) {
  const status = options.status ?? await detect(ctx, config)
  const explicit = options.explicitPath === undefined
    ? undefined
    : await validateCandidate(ctx, options.explicitPath)
  const rows = await executorRows(ctx)
  const shellReading = await shellRuntimeReading(ctx)

  // Every caller of this function (activation sweep, both tools, the page's Re-detect)
  // refreshes the prompt section and the gate from the same reading as the report.
  const state = runtimeState(ctx)
  state.gate = gateFromReading(shellReading, rows, status)
  state.runtimeNote = shellReading?.version !== undefined
    ? hintFor(shellReading.version)
    : runtimeNoteFor(rows, status)

  const lines = []

  if (explicit !== undefined) {
    lines.push(explicit.usable
      ? `Requested path: PowerShell ${explicit.version} (${labelOf(explicit)})\n  ${explicit.path}`
      : `Requested path rejected: ${explicit.reason}`)
    const warning = unpinnableWarning(explicit)
    if (warning !== undefined) lines.push(warning)
    lines.push('')
  }

  if (status.override !== undefined) {
    lines.push(status.override.usable
      ? `overridePath accepted: PowerShell ${status.override.version} (${status.override.path})`
      : `overridePath rejected: ${status.override.reason}`)
    const warning = unpinnableWarning(status.override)
    if (warning !== undefined) lines.push(warning)
    lines.push('')
  }

  lines.push('Executor rows:')
  for (const row of rows) lines.push(`  ${row.text}`)
  lines.push('')

  const enabled = rows.filter((row) => row.disabled !== true && row.options?.disabled !== true)
  const shellVersion = shellReading?.version
  const shellMajor = shellVersion === undefined ? undefined : Number.parseInt(shellVersion.split('.')[0] ?? '', 10)
  const shellEffective = shellMajor !== undefined && shellMajor >= MINIMUM_MAJOR
    ? { id: 'ctx.shell', version: shellVersion, origin: shellReading.origin, path: shellReading.path, source: shellReading.source }
    : undefined
  // A shell that exists but could not report a version is an unknown runtime, not a licence to
  // fall back to a row reading that may disagree with what the tool will spawn.
  const shellUnknown = shellReading !== undefined && shellReading.version === undefined
  const effective = shellEffective ?? (shellUnknown ? undefined : enabled.find((row) => row.version !== undefined))
  if (effective !== undefined) {
    if (shellEffective !== undefined) {
      lines.push(`The pwsh tool currently runs on PowerShell ${effective.version} via the executor (${effective.path}).`)
      if (effective.origin === 'store-alias') {
        lines.push('The executor resolves to the version-stable Store family alias: its directory carries no version,')
        lines.push('so Store updates do not move it, and the ACL sandbox still confines what it runs. Nothing to configure.')
        lines.push('Caveat: Windows resolves the alias through AppInfo package activation, which is undocumented —')
        lines.push('if a future Windows or Store change stops it, run pwsh7_install, or pin an ordinary pwsh.exe.')
      } else if (effective.origin === 'store-package') {
        lines.push('The executor resolves to a version-numbered Store path, which moves on every Store update.')
        lines.push('Repin the version-stable family alias, or run pwsh7_install for a Store-managed PowerShell.')
      } else {
        lines.push('That is the path the executor already resolves; Nothing to configure.')
      }
      return lines.join('\n')
    }
    lines.push(`The pwsh tool currently runs on PowerShell ${effective.version} via row ${effective.id}.`)
    const others = enabled.filter((row) => row !== effective && row.version !== undefined)
    if (others.length > 0) {
      lines.push(`Other enabled rows (${others.map((row) => row.id).join(', ')}) also report a runtime; this reading follows the row order above.`)
    }
    if (effective.origin === 'store-alias') {
      lines.push('That pin is the version-stable Store family alias: its directory carries no version, so Store')
      lines.push('updates do not move it, and the ACL sandbox still confines what it runs. Nothing to configure.')
      lines.push('Caveat: Windows resolves the alias through AppInfo package activation, which is undocumented —')
      lines.push('if a future Windows or Store change stops it, run pwsh7_install, or pin an ordinary pwsh.exe.')
    } else if (effective.origin === 'store-package') {
      lines.push('That pin is a version-numbered Store path, which moves on every Store update: the pin will')
      lines.push('silently stop working. Repin the version-stable family alias, or run pwsh7_install for a')
      lines.push('Store-managed PowerShell and drop this patch entry afterwards.')
    }
    return lines.join('\n')
  }

  const target = [explicit, status.override, status.auto]
    .find((candidate) => candidate?.usable === true && inPlace(candidate.origin))

  if (target !== undefined) {
    if (rows.every((row) => row.pwshPath === undefined) && resolvePwshPath(undefined, process.env, 'win32') === target.path) {
      lines.push(`PowerShell ${target.version} is in place at ${target.path}, and no executor row pins a path —`)
      lines.push('the pwsh tool picks it up natively. Nothing to configure.')
      return lines.join('\n')
    }
    const sourceRow = rows.find((row) => row.id === SOURCE_ROW_ID)
    const currentConfig = sourceRow?.config ?? {}
    const patchConfig = { ...currentConfig, pwshPath: target.path }
    const action = sourceRow === undefined ? 'add' : 'update'
    lines.push(`To make the pwsh tool use PowerShell ${target.version} (${target.path}), ${action} this in the profile patch`)
    lines.push('(~/.dsh/profiles/<profile>/cordis.patch.yml) and restart DSH:')
    lines.push('')
    lines.push(`- id: ${SOURCE_ROW_ID}`)
    lines.push('  config:')
    for (const [key, value] of Object.entries(patchConfig)) {
      if (value === undefined) continue
      lines.push(`    ${key}: ${key === 'pwshPath' ? `'${value}'` : JSON.stringify(value)}`)
    }
    if (Object.keys(currentConfig).some((key) => key !== 'pwshPath')) {
      lines.push('')
      lines.push('The `config` block replaces that row\'s config wholesale; the fields above are the ones')
      lines.push('the row currently carries, plus pwshPath.')
    } else if (sourceRow !== undefined) {
      lines.push('')
      lines.push('The `config` block replaces that row\'s config wholesale; keep any other fields it has.')
    }
    if (status.override?.usable === true && target === status.override) {
      lines.push('')
      lines.push('overridePath is only what this plugin probes and recommends; the pwsh tool does not read it.')
      lines.push('The patch above is what wires the executor.')
    }
    if (target.origin === 'store-alias') {
      lines.push('')
      lines.push('That path is the version-stable Store family alias — pinning it is what keeps Store updates')
      lines.push('from moving it. Prefer an ordinary pwsh.exe when the machine has one.')
    }
    return lines.join('\n')
  }

  const store = [status.override, status.auto].find((candidate) => candidate?.usable === true)
  if (store !== undefined) {
    // Only a version-numbered Store path can reach this branch: the family alias is acceptable
    // and would have matched above. This is the shape that breaks on the next Store update.
    lines.push(`PowerShell ${store.version} was found at a version-numbered Store path (${store.path}).`)
    lines.push('This plugin never pins that path — the next Store update moves it — and no version-stable')
    lines.push('Store alias or ordinary pwsh.exe was found.')
  } else {
    lines.push(`PowerShell 7: not usable — ${status.auto?.reason ?? 'no candidate was found'}.`)
    if (options.installAttempt !== undefined && !options.installAttempt.ok) {
      lines.push(`The configured auto-install did not produce a usable PowerShell 7: ${options.installAttempt.detail}`)
    }
  }
  lines.push('Two ways forward:')
  lines.push('  1. Install PowerShell 7 from the Microsoft Store — ask for pwsh7_install (this plugin runs it),')
  lines.push(`     or run it yourself: ${STORE_COMMAND}`)
  lines.push('     It checks the connection first: Windows defers Store downloads on a connection marked as')
  lines.push('     metered, so turn "Metered connection" off for that network if this machine is metered.')
  for (const line of DISABLE_PATH) lines.push(line === DISABLE_PATH[0] ? `  2. ${line}` : `     ${line}`)
  return lines.join('\n')
}

/**
 * Resolve the `winget.exe` the install uses. The environment override exists for the gates: they
 * must not depend on the author's PATH, and a missing override entry is how the no-winget branch is
 * exercised without touching the machine.
 * @returns the resolved command, or `undefined`.
 */
function resolveWinget() {
  const override = process.env.DSH_WIN_PWSH7_WINGET
  if (override !== undefined) return override.length === 0 ? undefined : override
  return resolveOnPath('winget.exe')
}

/**
 * The install preflight: winget must exist, a connection profile must be readable, and the
 * connection must not be metered. `Unknown` and an unreadable cost are refused as well — the
 * measured failure mode is a Store download that waits forever with no error, so "cannot tell" is
 * not permission to start.
 * @param ctx - the row's Host context.
 * @returns `{ ok: true, winget, reading }` or `{ ok: false, code, reading? }`.
 */
async function preflightInstall(ctx) {
  const winget = resolveWinget()
  if (winget === undefined) return { ok: false, code: 'no-winget' }
  const reading = await networkCost(ctx)
  if (reading === undefined) return { ok: false, code: 'network-unknown' }
  if (METERED_COST.has(reading.cost)) return { ok: false, code: 'metered', reading }
  if (reading.cost === 'Unknown' || reading.profile === '') return { ok: false, code: 'network-unknown', reading }
  return { ok: true, winget, reading }
}

/** One line for the activation log and the report's `installAttempt.detail`. */
function installBlockedDetail(pre) {
  if (pre.code === 'no-winget') return 'winget was not found on PATH'
  if (pre.code === 'metered') return `the ${pre.reading?.profile === undefined || pre.reading.profile === '' ? 'active' : `"${pre.reading.profile}"`} connection is marked as metered`
  return 'the connection cost could not be determined'
}

/**
 * The user-facing report when the preflight refuses to start. It names the exact setting and the
 * verification step; it never offers another installer, because the metered connection is a
 * connection setting, not a reason to leave the Store.
 * @param pre - the failed preflight.
 * @returns the report text.
 */
function installBlockedReport(pre) {
  if (pre.code === 'no-winget') {
    return [
      'Install not started: winget was not found on PATH. Install "App Installer" from the Microsoft',
      `Store, or run it yourself after installing it: ${STORE_COMMAND}`,
    ].join(' ')
  }
  if (pre.code === 'metered') {
    const named = pre.reading.profile.length === 0 ? 'This connection' : `The "${pre.reading.profile}" connection`
    return [
      `Install not started: ${named} is marked as metered ("Metered connection"), and Windows defers`,
      'Microsoft Store downloads on metered connections: the install would sit queued with no error.',
      'Fix: Settings → Network & Internet → Wi-Fi → that network → turn off "Metered connection"',
      '(for Ethernet: Settings → Network & Internet → Ethernet → that network → the same switch).',
      'Then run pwsh7_install again; it re-checks and starts only after the connection reports Unrestricted.',
      'To verify the reading, run pwsh7_status; the metered warning disappears when the setting is off.',
      `If the probe keeps failing, run it manually: ${STORE_COMMAND}`,
      'Do not switch to another installer — the Store package is the only path this plugin supports.',
    ].join(' ')
  }
  return [
    'Install not started: the connection cost could not be determined (the Windows PowerShell 5.1',
    'probe failed or returned Unknown). Check that the machine is online and that the active network\'s',
    '"Metered connection" switch is off, then retry. If the probe keeps failing, run it manually:',
    STORE_COMMAND,
  ].join(' ')
}

/**
 * Run `pwsh7_install`: skip when an acceptable PowerShell 7 is already in place (an ordinary
 * file or the Store family alias). Otherwise start the install as a **background job** and return
 * at once, so an install that needs many minutes is visible, cancellable, and readable through the
 * platform's own `job_output` instead of blocking the call with no output. The `store` route also
 * probes the connection cost first, because a metered connection makes it wait forever.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @param exec - the tool execution, for the job's owner.
 * @returns the report text.
 */
async function runInstall(ctx, config, exec) {
  const before = await detect(ctx, config)
  if (before.chosen !== undefined) {
    return `PowerShell ${before.chosen.version} is already in place (${before.chosen.path}, ${labelOf(before.chosen)}); nothing to install.`
  }

  const pre = await preflightInstall(ctx)
  if (!pre.ok) return installBlockedReport(pre)

  const jobs = ctx.get('jobs')
  if (jobs === undefined || typeof jobs.start !== 'function') {
    const result = await installViaWinget(ctx, INLINE_INSTALL_GRACE_MS)
    if (result.pending === true) {
      return [
        'No background-job registry is composed here, so the install ran inline and could not report progress.',
        result.detail,
      ].join('\n')
    }
    const after = await awaitRuntime(ctx, config)
    return [
      'No background-job registry is composed here, so the install ran inline and could not report progress.',
      ...await installVerdict(ctx, config, result, after),
    ].join('\n')
  }

  let id
  try {
    id = jobs.start(installJobSpec(ctx, config, exec))
  } catch (error) {
    const result = await installViaWinget(ctx, INLINE_INSTALL_GRACE_MS)
    const after = await awaitRuntime(ctx, config)
    return [
      `The job registry refused to start the install (${describe(error)}), so it ran inline.`,
      ...await installVerdict(ctx, config, result, after),
    ].join('\n')
  }

  return [
    `Installing PowerShell 7 from the Microsoft Store in the background as job ${id}.`,
    'Read its progress and output with job_output; stop it with job_kill. The Store downloads only',
    'when Windows lets it: the preflight above confirmed the active connection is not metered, and',
    'winget may exit non-zero while the Store still finishes the work.',
    'The plugin re-checks the runtime after winget exits and again when the job settles, so a late',
    'finish is still reported as installed. pwsh7_status shows the current reading at any time.',
  ].join('\n')
}

/**
 * The report lines for a finished install attempt; the inline path and the job settle share them.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @param result - `{ ok, detail }` from winget.
 * @param after - a detection result to judge by, when the caller already re-probed for a while.
 * @returns the report lines.
 */
async function installVerdict(ctx, config, result, after) {
  const found = after ?? await detect(ctx, config)
  const lines = []
  if (found.chosen !== undefined) {
    lines.push(result.ok
      ? 'winget finished successfully.'
      : `winget reported failure (${result.detail}) — but the runtime is in place now. The Store can finish after winget exits; something else may also have installed it.`)
    lines.push(`PowerShell ${found.chosen.version} is now in place (${found.chosen.path}, ${labelOf(found.chosen)}).`)
    lines.push('If pwsh7_status still shows an executor row pinning an older path, remove that patch entry and')
    lines.push('restart DSH — or repin it at the version-stable path printed there.')
  } else {
    lines.push(`The install did not complete: ${result.detail}`)
    lines.push('The machine still has no PowerShell 7 the executor can use. Its usual failure mode is not the')
    lines.push('Store but the connection: on a connection marked as metered Windows defers the download and the')
    lines.push('Store logs no error at all. Turn "Metered connection" off for that network and run this again,')
    lines.push('or disable this plugin if PowerShell 7 is not wanted here.')
  }
  return lines
}

/**
 * The job spec for one Store install. winget's two collected streams become the job's output
 * ring, the progress line carries elapsed time and turns into a stall warning once the install
 * passes {@link INSTALL_STALL_MS}, and settling re-validates so the job result states whether
 * the runtime is actually usable now — winget's exit code alone never decides that.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @param exec - the tool execution, for the job's owner.
 * @returns the job spec.
 */
function installJobSpec(ctx, config, exec) {
  let handle
  const startedAt = Date.now()
  const elapsed = () => `${Math.max(1, Math.round((Date.now() - startedAt) / 60000))}m`
  return {
    kind: INSTALL_KIND,
    label: 'PowerShell 7 install (Microsoft Store)',
    ...(exec?.agent?.id === undefined ? {} : { owner: exec.agent.id }),
    output: [
      { channel: 'stdout', read: (from) => readStream(handle?.collected?.stdout, from) },
      { channel: 'stderr', read: (from) => readStream(handle?.collected?.stderr, from) },
    ],
    run(job) {
      try {
        handle = spawnWingetProcess(ctx)
      } catch (error) {
        const detail = describe(error)
        job.updateProgress('winget could not start')
        job.append(`${detail}\n`)
        return { cancel() {}, done: Promise.resolve({ status: 'failed', detail, result: detail }) }
      }
      const logState = { file: undefined, offset: 0, phase: undefined, startedAt, totalAsked: false }
      let cancelled = false
      // "Stalled" means nothing has moved — no new log line, no byte of the installer — for the whole
      // threshold. Wall clock alone was wrong twice over: a long but *working* staging phase
      // (measured 4m15s) is progress, and the old test could never fire anyway once any phase had
      // been recognised, because the follower returns the last known phase rather than "nothing new".
      const stalled = () => Date.now() - (logState.progressAt ?? startedAt) >= INSTALL_STALL_MS
      const progress = () => {
        const phase = followWingetLog(job, logState, startedAt)
        measureDownload(logState, Date.now())
        const parts = [`running ${elapsed()}`]
        if (phase !== undefined) parts.push(phase)
        if (stalled()) {
          parts.push('nothing has moved for a while — on a metered connection the Store queues the download and logs no error; job_kill, then check that setting')
        }
        const downloading = downloadProgress(logState)
        if (downloading !== undefined) parts.push(downloading)
        job.updateProgress(parts.join(' — '))
      }
      const timer = setInterval(progress, INSTALL_TICK_MS)
      timer.unref?.()
      progress()
      return {
        cancel() {
          cancelled = true
          clearInterval(timer)
          handle?.terminate()
        },
        done: (async () => {
          try {
            const outcome = await handle.done
            clearInterval(timer)
            // A cancelled job must not keep working: without this the settle path ran the whole
            // bounded re-probe after `job_kill` and then wrote a verdict nobody asked for.
            if (cancelled) {
              const detail = 'the install was cancelled'
              job.append(`\n${detail}\n`)
              return { status: 'failed', detail, result: detail }
            }
            const tail = tailOf(handle.collected)
            const result = outcome.exitCode === 0
              ? { ok: true, detail: 'winget reported success' }
              : { ok: false, detail: `winget exited with code ${outcome.exitCode}${tail === undefined ? '' : `: ${tail}`}` }
            // A failed exit is evidence, not a verdict: re-probe for a bounded while, because the
            // runtime can appear after winget has already exited (see RECHECK_ATTEMPTS). The cancel
            // probe stops that loop too — `job_kill` during the re-probe used to be ignored.
            const after = await awaitRuntime(ctx, config, job, () => cancelled)
            const verdict = await installVerdict(ctx, config, result, after)
            // Do not probe here: the next `pwsh` call (or the status page) refreshes through
            // pre-execute. Invalidating the timestamp is enough to make that refresh happen, and
            // it keeps a settling install from adding probes to an unrelated gate.
            runtimeState(ctx).gate.at = 0
            job.append(`\n${verdict.join('\n')}\n`)
            return {
              status: after.chosen === undefined ? 'failed' : 'completed',
              detail: result.detail,
              result: verdict.join('\n'),
            }
          } catch (error) {
            clearInterval(timer)
            const detail = `winget did not finish: ${describe(error)}`
            job.append(`\n${detail}\n`)
            return { status: 'failed', detail, result: detail }
          }
        })(),
      }
    },
  }
}

/**
 * Wait, bounded, for the runtime to appear after winget exits. winget's exit code is unreliable on
 * the routes that finish asynchronously (the Store hands the work to another process and reports
 * failure), so the plugin keeps re-probing before it believes a failure — and says so on the job's
 * progress line while it does.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @param job - the job handle, for progress reporting.
 * @param isCancelled - consulted before every probe, so a `job_kill` during the re-probe stops it.
 * @returns the first detection that found a candidate, or the last one.
 */
async function awaitRuntime(ctx, config, job, isCancelled) {
  let result = await detect(ctx, config)
  for (let attempt = 1; result.chosen === undefined && attempt <= RECHECK_ATTEMPTS; attempt += 1) {
    if (isCancelled?.() === true) break
    job?.updateProgress(`winget exited; re-checking whether the install lands anyway (${attempt}/${RECHECK_ATTEMPTS})`)
    // Not unref'd: this await is the work, and an unref'd timer lets the loop exit under it.
    await new Promise((resolve) => { setTimeout(resolve, RECHECK_DELAY_MS) })
    // Checked again after the wait: a cancel that lands *during* it must not be followed by one more
    // probe, which is what "stop the loop" has to mean.
    if (isCancelled?.() === true) break
    result = await detect(ctx, config)
  }
  return result
}

/**
 * Adapt one collected subprocess stream to a job output source. The subprocess reader is already
 * offset-based and non-consuming, so the job ring and the plugin's own reads never disturb each
 * other; a source whose process has not started yet simply reads nothing.
 * @param reader - the subprocess output reader, when the process exists.
 * @param from - the byte offset to read from.
 * @returns the job source read.
 */
function readStream(reader, from) {
  if (reader === undefined) return { text: '', nextOffset: from, lossy: false }
  const read = reader.readFrom(from)
  return { text: read.text, nextOffset: read.nextOffset, lossy: read.lossy }
}

/**
 * Follow winget's own diagnostic log and turn it into job progress.
 *
 * winget writes nothing useful to a captured stdout — with a pipe it draws no progress bar and
 * prints only a few lines — but its log announces every phase, and one measured run spent 4m15s
 * inside a single silent `StagePackageAsync`. Following the log is what turns "running 3m" into
 * "running 3m — deploying the package".
 *
 * Best-effort by design: the log is another program's private format, so a missing or unreadable
 * log costs the phase and nothing else. New lines are also appended to the job output, so a reader
 * of `job_output` sees exactly what the progress line was derived from.
 * @param job - the job handle.
 * @param state - the follower's cursor: chosen file, byte offset, last phase.
 * @param startedAt - the install's start time, to ignore older logs.
 * @returns the latest phase, or `undefined` when nothing has been seen yet.
 */
function followWingetLog(job, state, startedAt) {
  try {
    if (state.file === undefined) {
      const directory = join(
        process.env.LOCALAPPDATA ?? '',
        'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'DiagOutputDir',
      )
      const newest = readdirSync(directory)
        .filter((name) => /^WinGet-.*\.log$/u.test(name))
        .map((name) => ({ path: join(directory, name), mtime: statSync(join(directory, name)).mtimeMs }))
        .filter((entry) => entry.mtime >= startedAt - 5000)
        .sort((left, right) => right.mtime - left.mtime)[0]
      if (newest === undefined) return state.phase
      state.file = newest.path
      state.offset = 0
    }
    const text = readFileSync(state.file, 'utf8')
    if (text.length <= state.offset) return state.phase
    const fresh = text.slice(state.offset)
    state.offset = text.length
    // New lines mean the install is moving: this is what the stall test measures the absence of.
    state.progressAt = Date.now()
    const lines = fresh.split(/\r?\n/u).filter((line) => line.length > 0)
    for (const line of lines) {
      const phase = wingetPhase(line)
      if (phase !== undefined) state.phase = phase
      const url = /https:\/\/\S+?\.(?:msixbundle|msix|appx|exe|msi)\b/u.exec(line)
      if (url !== null) noteDownloadTotal(state, url[0])
    }
    if (lines.length > 0) job.append(`${lines.join('\n')}\n`)
  } catch {
    /* no log, or not readable: the elapsed-time line stands */
  }
  return state.phase
}

/** The human phase a winget log line announces, or `undefined` for lines that announce none. */
function wingetPhase(line) {
  const phases = [
    [/Downloading to path:/u, 'updating the winget source'],
    [/Packaged source open/u, 'winget source ready'],
    [/Installer hash verified/u, 'installer downloaded and verified'],
    [/Starting StagePackageAsync/u, 'deploying the package (staging covers the download)'],
    [/Starting RegisterPackageByFullNameAsync/u, 'registering the package'],
    [/Leaf command succeeded/u, 'winget finished'],
  ]
  for (const [pattern, phase] of phases) if (pattern.test(line)) return phase
  return undefined
}

/** Where winget stages an installer download: `%TEMP%\WinGet\<Id>.<Version>\`. */
function wingetDownloadRoot() {
  return join(process.env.TEMP ?? process.env.TMP ?? '', 'WinGet')
}

/** Total bytes of every file under one directory, tolerating entries that vanish mid-walk. */
function treeBytes(directory) {
  let total = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) total += treeBytes(path)
    else if (entry.isFile()) {
      try {
        total += statSync(path).size
      } catch { /* finished or moved between the listing and the stat */ }
    }
  }
  return total
}

/**
 * Measure the installer download from the bytes winget is writing to disk.
 *
 * This is the only honest source: winget reports no numeric progress of its own — a real PTY run
 * showed a spinner and the "indeterminate" taskbar signal, no percentage — while the download is
 * a file growing under `%TEMP%\WinGet`. Speed is the growth since the previous sample.
 * @param state - the follower's state, which keeps the watched directory and the last sample.
 * @param now - the current time in milliseconds.
 * @returns `{ bytes, speed, total }`, or `undefined` before anything has been seen.
 */
function measureDownload(state, now) {
  try {
    if (state.downloadDir === undefined) {
      const root = wingetDownloadRoot()
      const newest = readdirSync(root, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name !== 'cache')
        .map((entry) => ({ path: join(root, entry.name), mtime: statSync(join(root, entry.name)).mtimeMs }))
        .filter((entry) => entry.mtime >= state.startedAt - 5000)
        .sort((left, right) => right.mtime - left.mtime)[0]
      if (newest === undefined) return undefined
      state.downloadDir = newest.path
      state.downloadBytes = 0
      state.downloadAt = now
      state.downloadSpeed = 0
    }
    const bytes = treeBytes(state.downloadDir)
    if (bytes > state.downloadBytes) state.progressAt = now
    const seconds = (now - state.downloadAt) / 1000
    if (seconds >= 1 && bytes >= state.downloadBytes) {
      state.downloadSpeed = (bytes - state.downloadBytes) / seconds
      state.downloadBytes = bytes
      state.downloadAt = now
    }
    state.download = { bytes: Math.max(bytes, state.downloadBytes), speed: state.downloadSpeed, total: state.total }
    return state.download
  } catch {
    return state.download
  }
}

/**
 * Ask the installer URL for its length, once, so the progress line can carry a percentage. A URL
 * that refuses or hides its length costs only the percentage.
 * @param state - the follower's state.
 * @param url - the installer URL a winget log line named.
 */
function noteDownloadTotal(state, url) {
  if (state.totalAsked === true || state.total !== undefined) return
  state.totalAsked = true
  void fetch(url, { method: 'HEAD' }).then((response) => {
    const length = Number(response.headers.get('content-length'))
    if (Number.isFinite(length) && length > 0) state.total = length
  }).catch(() => { /* no total: bytes and speed still stand */ })
}

/** One decimal place of mebibytes — the unit GitHub's own release listings use. */
function mebibytes(bytes) {
  return (bytes / 1048576).toFixed(1)
}

/** The `— downloaded 120.4 MiB / 335.9 MiB (36%) @ 4.5 MiB/s` fragment, or `undefined`. */
function downloadProgress(state) {
  const download = state.download
  if (download === undefined || download.bytes === 0) return undefined
  const of = download.total === undefined
    ? ''
    : ` / ${mebibytes(download.total)} MiB (${Math.min(100, Math.round((download.bytes / download.total) * 100))}%)`
  const speed = download.speed > 0 ? ` @ ${mebibytes(download.speed)} MiB/s` : ''
  return `downloaded ${mebibytes(download.bytes)} MiB${of}${speed}`
}

/**
 * Resolve the best PowerShell 7 candidate on this machine: ① the configured `overridePath`,
 * ② the auto-probe. Each candidate is validated independently; a rejected ① falls through
 * to ②.
 * @param ctx - the row's Host context.
 * @param config - the resolved row configuration.
 * @returns the detection result with `chosen` set to the best acceptable candidate.
 */
async function detect(ctx, config) {
  const override = isSet(config?.overridePath)
    ? await validateCandidate(ctx, config.overridePath)
    : undefined
  const resolved = await validateCandidate(ctx, resolvePwshPath(undefined, process.env, 'win32'))
  // The upstream resolver reports the version-numbered Store path (MSIX activation puts that
  // directory at the head of PATH). The pinnable form is the family alias beside it, so prefer
  // it whenever it exists: it is the same runtime through a path Store updates do not move.
  const alias = resolved?.origin === 'store-package' ? familyAliasOf(resolved.path) : undefined
  const auto = alias === undefined ? resolved : await validateCandidate(ctx, alias)
  return {
    override,
    auto,
    // What counts as "already usable": an ordinary file or the Store family alias.
    chosen: [override, auto].find((candidate) => candidate?.usable === true && inPlace(candidate.origin)),
  }
}

/**
 * Validate a path the way the executor itself accepts candidates — file or reparse point,
 * probed for a reported version. Used for executor rows, whose paths already run today; what
 * this plugin is willing to *pin* is a separate judgement ({@link inPlace}).
 * @param ctx - the row's Host context.
 * @param candidate - the executor row's `pwshPath`.
 * @returns the validation outcome.
 */
async function validateRowPath(ctx, candidate) {
  if (!isSpawnable(candidate)) {
    return { usable: false, path: candidate, origin: originOf(candidate), reason: `${candidate} does not exist` }
  }
  return await probeAndVersion(ctx, candidate)
}

/**
 * Validate one candidate executable: it must exist and be spawnable (a file or a Store
 * execution alias), and report PowerShell ≥ 7. Store sources are labeled by form, and the
 * version-numbered one is never recommended — see {@link inPlace}.
 * @param ctx - the row's Host context.
 * @param candidate - the path to validate.
 * @returns the validation outcome.
 */
async function validateCandidate(ctx, candidate) {
  if (candidate === undefined) {
    return { usable: false, reason: 'no PowerShell 7 installation was found' }
  }
  if (WINDOWS_POWERSHELL_51.test(candidate)) {
    return { usable: false, path: candidate, reason: 'only Windows PowerShell 5.1 is available' }
  }
  if (!isSpawnable(candidate)) {
    return {
      usable: false,
      path: candidate,
      origin: originOf(candidate),
      reason: `${candidate} does not exist, so it cannot be a spawn target`,
    }
  }

  return await probeAndVersion(ctx, candidate)
}

/**
 * Probe one path that already exists and check its major version. Shared by both
 * validators; the origin label follows the path, not the acceptance criteria.
 * @param ctx - the row's Host context.
 * @param candidate - the path to probe.
 * @returns the validation outcome.
 */
async function probeAndVersion(ctx, candidate) {
  const version = await probeVersion(ctx, candidate)
  if (version === undefined) {
    return { usable: false, path: candidate, origin: originOf(candidate), reason: `${candidate} did not report a PowerShell version` }
  }
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  if (!Number.isSafeInteger(major) || major < MINIMUM_MAJOR) {
    // The version still travels: a row may pin Windows PowerShell 5.1, and what that row
    // actually runs is a fact the model has to be told even though this plugin would never
    // recommend the path.
    return { usable: false, path: candidate, version, origin: originOf(candidate), reason: `${candidate} reported PowerShell ${version}, below the supported ${MINIMUM_MAJOR}` }
  }
  return { usable: true, path: candidate, version, origin: originOf(candidate) }
}

/**
 * Ask one executable for its PowerShell version string.
 * @param ctx - the row's Host context.
 * @param executable - the executable to probe.
 * @returns the reported version (for example `7.6.6`), or `undefined` when it could not be established.
 */
async function probeVersion(ctx, executable) {
  // `-EncodedCommand` sidesteps Windows argument quoting entirely.
  const encoded = Buffer.from('$PSVersionTable.PSVersion.ToString()', 'utf16le').toString('base64')

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: PROBE_MAX_BYTES },
        stderr: { maxBytes: PROBE_MAX_BYTES },
      },
      graceMs: PROBE_GRACE_MS,
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-win-pwsh7: could not start %s: %s', executable, describe(error))
    return undefined
  }

  try {
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    const text = handle.collected.stdout?.readFrom(0).text ?? ''
    // The probe prints exactly one line, but a preview build answers with a suffix
    // (`7.4.0-preview.1`) and a shell that prints a banner or a warning first would defeat a
    // whole-output match — which then reported a *working* pwsh as "did not report a version".
    // Take the first line that is a version and nothing else.
    return /^\s*(\d+(?:\.\d+){0,3}(?:-[0-9A-Za-z.]+)?)\s*$/mu.exec(text)?.[1]
  } catch (error) {
    handle.terminate()
    ctx.logger?.warn?.('dsh-win-pwsh7: probing %s failed: %s', executable, describe(error))
    return undefined
  }
}

/**
 * Spawn winget for the Store install, or throw with a human message when it cannot start. Shared by
 * the blocking path and the background job so both run exactly the same command.
 * @param ctx - the row's Host context.
 * @returns the live subprocess handle.
 */
function spawnWingetProcess(ctx) {
  const winget = resolveWinget()
  if (winget === undefined) {
    throw new Error(`winget was not found on PATH; install PowerShell 7 manually: ${STORE_COMMAND}`)
  }
  return ctx.subprocess.spawn({
    argv: [winget, ...STORE_ARGS],
    cwd: process.cwd(),
    stdio: {
      stdin: 'ignore',
      stdout: { maxBytes: INSTALL_MAX_BYTES },
      stderr: { maxBytes: INSTALL_MAX_BYTES },
    },
    graceMs: INSTALL_GRACE_MS,
  })
}

/**
 * Wait for a subprocess, but only for `graceMs`. `undefined` means it is still running, and the
 * caller reports exactly that — the alternative (waiting) is what hung activation on a metered
 * connection, because the winget→Store handoff waits indefinitely there and logs nothing.
 * @param handle - the live subprocess handle.
 * @param graceMs - how long to wait; omitted means "wait for it".
 * @returns the outcome, or `undefined` on timeout.
 */
async function settledWithin(handle, graceMs) {
  if (graceMs === undefined) return await handle.done
  let timer
  try {
    return await Promise.race([
      handle.done,
      new Promise((resolve) => {
        timer = setTimeout(() => resolve(undefined), graceMs)
        timer.unref?.()
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * The inline install, used where no job registry is composed (and by the activation sweep's
 * `installIfMissing`). The exit code alone never counts as success — the caller re-validates —
 * and an install that outlives its grace is reported as still running rather than blocking.
 * @param ctx - the row's Host context.
 * @param graceMs - how long this call may block; omitted means "wait for winget".
 * @returns `{ ok, detail, pending? }`; winget output is only supporting detail.
 */
async function installViaWinget(ctx, graceMs) {
  let handle
  try {
    handle = spawnWingetProcess(ctx)
  } catch (error) {
    return { ok: false, detail: describe(error) }
  }

  try {
    const outcome = await settledWithin(handle, graceMs)
    if (outcome === undefined) {
      return {
        ok: false,
        pending: true,
        detail: `winget is still running after ${Math.round(graceMs / 1000)}s; the install continues in the background`,
      }
    }
    if (outcome.exitCode === 0) return { ok: true, detail: 'winget reported success' }
    const tail = tailOf(handle.collected)
    return { ok: false, detail: `winget exited with code ${outcome.exitCode}${tail === undefined ? '' : `: ${tail}`}` }
  } catch (error) {
    handle.terminate()
    return { ok: false, detail: `winget did not finish: ${describe(error)}` }
  }
}

/**
 * The connection cost the Microsoft Store itself consults, plus the profile it belongs to.
 *
 * Read through Windows PowerShell 5.1, which is always present and the only PowerShell that can
 * reach WinRT from a script. Every failure yields `undefined`: the caller adds no warning rather
 * than a guess.
 * @param ctx - the row's Host context.
 * @returns `{ cost, profile }` where cost is one of the four `NetworkCostType` names, or `undefined`.
 */
async function networkCost(ctx) {
  const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

  let handle
  try {
    handle = ctx.subprocess.spawn({
      argv: [executable, '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', NETWORK_COST_SCRIPT],
      cwd: process.cwd(),
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: PROBE_MAX_BYTES },
        stderr: { maxBytes: PROBE_MAX_BYTES },
      },
      graceMs: PROBE_GRACE_MS,
    })
  } catch (error) {
    ctx.logger?.warn?.('dsh-win-pwsh7: could not read the connection cost: %s', describe(error))
    return undefined
  }

  try {
    const outcome = await handle.done
    if (outcome.exitCode !== 0) return undefined
    const reading = /^(Unknown|Unrestricted|Fixed|Variable)\|(.*)$/u.exec((handle.collected.stdout?.readFrom(0).text ?? '').trim())
    return reading === null ? undefined : { cost: reading[1], profile: reading[2] }
  } catch (error) {
    handle.terminate()
    ctx.logger?.warn?.('dsh-win-pwsh7: reading the connection cost failed: %s', describe(error))
    return undefined
  }
}

/**
 * The warning a metered connection earns before the `store` route starts, or `undefined` when that
 * route can proceed. Measured behaviour, not theory: with the connection marked metered the Store
 * accepted the install, logged no error at all, and never downloaded it — the request carried
 * `AllowDownloadOnAnyNetwork = 0`, so Windows was deferring it deliberately. Un-marking the
 * connection made the same non-interactive route finish in under a minute.
 * @param ctx - the row's Host context.
 * @returns the warning text, or `undefined`.
 */
async function meteredWarning(ctx) {
  const reading = await networkCost(ctx)
  if (reading === undefined || !METERED_COST.has(reading.cost)) return undefined
  const named = reading.profile.length === 0 ? 'This connection' : `The "${reading.profile}" connection`
  return [
    `${named} is marked as metered ("Metered connection"), and Windows defers Microsoft Store`,
    'downloads on metered connections: this install will very likely sit queued and never finish by',
    'itself, with no error anywhere. The fix is the connection setting, not another installer: turn',
    '"Metered connection" off for this network (Settings → Network & Internet → Wi-Fi → that network)',
    'and run this again. PowerShell comes from the Microsoft Store, which is the only way this plugin',
    'recommends, because Windows keeps that package up to date by itself.',
  ].join(' ')
}

/**
 * Resolve a command on PATH, following the same file-or-symlink acceptance the upstream
 * resolver uses (Store execution aliases pass).
 * @param name - the file name to look for, for example `winget.exe`.
 * @returns the first existing path, or `undefined`.
 */
function resolveOnPath(name) {
  for (const entry of (process.env.PATH ?? '').split(';')) {
    const directory = entry.trim().replace(/^"|"$/gu, '')
    if (directory.length === 0) continue
    const candidate = join(directory, name)
    try {
      const stats = lstatSync(candidate)
      if (stats.isFile() || stats.isSymbolicLink()) return candidate
    } catch { /* keep scanning */ }
  }
  return undefined
}

/**
 * The PowerShell executor rows and the `pwshPath` each one declares, probed for what they
 * actually run today.
 *
 * `probed` is what the pinned path reports, whatever version it is, because that is what the
 * `pwsh` tool will run; `version` is set only when the path is a PowerShell this plugin would
 * itself use. The report reads `version`; the prompt section reads `probed`.
 * @param ctx - the row's Host context.
 * @returns one entry per executor row, each with a report line and, when usable, its version and origin.
 */
async function executorRows(ctx) {
  const rows = []
  for (const entry of ctx.configEditor.entries()) {
    if (!EXECUTOR_PACKAGES.has(entry?.options?.name)) continue
    const declared = entry.options?.config?.pwshPath
    const id = String(entry.options?.id)
    // Carry the entry's disabled flag through: a disabled row does not run, so it must not be the
    // row the report names as the runtime (and it is why `effectiveRuntime` filters on this).
    const disabled = entry.disabled === true || entry.options?.disabled === true
    if (!isSet(declared)) {
      rows.push({ id, disabled, pwshPath: undefined, config: entry.options?.config ?? {}, text: `${id} : (pwshPath not set — the executor probes well-known locations itself)` })
      continue
    }
    const pwshPath = String(declared)
    const check = await validateRowPath(ctx, pwshPath)
    rows.push(check.usable
      ? { id, disabled, pwshPath, config: entry.options?.config ?? {}, version: check.version, probed: check.version, origin: check.origin, text: `${id} : pwshPath = ${pwshPath} (PowerShell ${check.version}, ${labelOf(check)})` }
      : { id, disabled, pwshPath, config: entry.options?.config ?? {}, probed: check.version, text: `${id} : pwshPath = ${pwshPath} (not a usable PowerShell 7: ${check.reason})` })
  }
  return rows
}

/** Whether a path lives under a Microsoft Store install location. */
function originOf(candidate) {
  if (!EXECUTION_ALIAS.test(candidate)) return 'ordinary'
  return STORE_VERSIONED.test(candidate) ? 'store-package' : 'store-alias'
}

/**
 * Whether a candidate is acceptable wiring — either one this plugin would suggest in a patch,
 * or one it treats as already in place.
 *
 * An ordinary file qualifies, and so does the Store family alias: its path carries no version,
 * so Store updates do not move it, and its confinement was verified on a Windows machine
 * running the alias (an out-of-workspace write under a confined policy is still refused). A
 * version-numbered Store path is deliberately excluded — it moves on every update.
 * @param origin - an {@link originOf} result.
 * @returns whether the candidate may be pinned and counts as in place.
 */
function inPlace(origin) {
  return origin === 'ordinary' || origin === 'store-alias'
}

/**
 * Whether a path can be a spawn target at all, following the executor's own acceptance: a file
 * or a reparse point (a Store execution alias is a zero-length reparse point, which is exactly
 * why the *pin* policy is separate from the *spawn* test).
 * @param candidate - the path to test.
 * @returns whether the executor could spawn it.
 */
function isSpawnable(candidate) {
  try {
    const stats = lstatSync(candidate)
    return stats.isFile() || stats.isSymbolicLink()
  } catch {
    return false
  }
}

/**
 * The package family name inside a version-numbered Store directory name:
 * `Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe` → `Microsoft.PowerShell_8wekyb3d8bbwe`.
 * @param directory - the directory name right under `WindowsApps`.
 * @returns the family name, or `undefined` when the name is not version-numbered.
 */
function packageFamilyOf(directory) {
  const parts = directory.split('_')
  return parts.length >= 3 ? `${parts[0]}_${parts.at(-1)}` : undefined
}

/**
 * The version-stable alias of a version-numbered Store path, when Windows has published one:
 * `%LOCALAPPDATA%\Microsoft\WindowsApps\<package family>\pwsh.exe`.
 *
 * The upstream resolver never returns this form — MSIX activation puts the version-numbered
 * directory at the head of `PATH` — yet it is the only Store path worth pinning, so the
 * auto-probe looks for it explicitly.
 * @param candidate - a version-numbered Store path.
 * @returns the family alias, or `undefined` when there is none.
 */
function familyAliasOf(candidate) {
  const family = packageFamilyOf(basename(dirname(candidate)))
  if (family === undefined) return undefined
  const alias = join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WindowsApps', family, 'pwsh.exe')
  return isSpawnable(alias) ? alias : undefined
}

/**
 * The PowerShell the `pwsh` tool itself runs, following the executor's own precedence: a row
 * that pins `pwshPath` decides, otherwise the executor's probe does. A pinned path that
 * reports no version at all is an unknown runtime, not a guess.
 * @param rows - the probed executor rows.
 * @param status - the detection result, for the unpinned case.
 * @returns the version string, or `undefined` when it cannot be established.
 */
function effectiveRuntime(rows, status) {
  // A disabled row does not run, so it must not be the answer to "which runtime is this?" — and
  // when several rows pin a path the first one is still the best available answer, which the report
  // says out loud rather than implying it is the only pin.
  const pinned = rows.find((row) => row.pwshPath !== undefined
    && row.disabled !== true && row.options?.disabled !== true)
  if (pinned !== undefined) return pinned.probed
  const auto = status.auto
  if (auto === undefined) return undefined
  if (auto.usable === true) return auto.version
  // With no PowerShell 7 anywhere, the executor's own last candidate is Windows PowerShell
  // 5.1 — the case where the warning matters most. `validateCandidate` refuses to recommend
  // that path (and so reports no version), but the `pwsh` tool still runs it.
  return WINDOWS_POWERSHELL_51.test(auto.path ?? '') ? WINDOWS_POWERSHELL_51_VERSION : undefined
}

/**
 * The one line the model needs before it writes a pipeline. `&&` / `||` are valid in
 * PowerShell 7 and parse errors in Windows PowerShell 5.1.
 * @param version - the running PowerShell version, or `undefined` when unknown.
 * @returns the prompt text; `''` renders nothing, which is the honest answer when unknown.
 */
function hintFor(version) {
  if (version === undefined) return ''
  const major = Number.parseInt(version.split('.')[0] ?? '', 10)
  return major >= MINIMUM_MAJOR
    ? `The \`pwsh\` tool on this machine runs PowerShell ${version}, so \`&&\` and \`||\` work in one command.`
    : `The \`pwsh\` tool is blocked by dsh-win-pwsh7: it would run Windows PowerShell ${version}, where \`&&\` and \`||\` are parse errors. Do not call it or chain commands with \`;\`; tell the user PowerShell 7 must be installed or configured, then call pwsh7_status for the exact patch, call pwsh7_install only after they agree, or disable this plugin.`
}

/**
 * The prompt text for the whole runtime state — the version line, or the fact that the tool
 * cannot start at all.
 *
 * That second state is worth a line of its own: when an executor row pins a `pwshPath` that no
 * longer exists, the executor uses the pin and does not fall back, so **every** call fails with
 * a spawn error. Without the line the model rediscovers that by wasting calls; with it, it can
 * say what is wrong on the first try. `''` is the last-resort guard for a state nothing is known
 * about — it renders nothing rather than guessing.
 * @param rows - the probed executor rows.
 * @param status - the detection result, for the unpinned case.
 * @returns the prompt text, or `''`.
 */
function runtimeNoteFor(rows, status) {
  const version = effectiveRuntime(rows, status)
  if (version !== undefined) return hintFor(version)
  const broken = rows.find((row) => row.pwshPath !== undefined && !isSpawnable(row.pwshPath))
  if (broken !== undefined) {
    return `The \`pwsh\` tool cannot start: an executor row pins ${broken.pwshPath}, which does not exist. dsh-win-pwsh7 blocks calls until this is fixed. Install PowerShell 7 from the Microsoft Store (\`pwsh7_install\`), call \`pwsh7_status\` for the exact patch, or disable this plugin if PowerShell 7 is not wanted here.`
  }
  return ''
}

/** Human label for a usable candidate. */
function labelOf(candidate) {
  if (candidate.origin === 'store-alias') return 'Store family alias'
  if (candidate.origin === 'store-package') return 'version-numbered Store path'
  return 'ordinary file'
}

/**
 * The warning for a path that runs but must never be pinned — a version-numbered Store path
 * moves on the next Store update — or `undefined` when there is nothing to warn about.
 * @param candidate - a validation outcome.
 * @returns the warning line, or `undefined`.
 */
function unpinnableWarning(candidate) {
  return candidate?.usable === true && candidate.origin === 'store-package'
    ? 'That path runs, but do not pin it: a version-numbered Store path moves on every update.'
    : undefined
}

/** Whether a config value is a non-empty string. */
function isSet(value) {
  return typeof value === 'string' && value.length > 0
}

/** Collapse a report into one log-friendly line. */
function flattenReport(report) {
  return report.replace(/\n\s*/gu, ' | ')
}

/**
 * Render one thrown value as a message.
 * @param error - the thrown value.
 * @returns a human-readable message.
 */
function describe(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Last screenful of a winget run, for failure detail. Both streams are read: the licence text that
 * ends a Store handoff on stdout once pushed the actual error out of this window.
 */
function tailOf(collected) {
  const text = [collected?.stdout?.readFrom(0)?.text, collected?.stderr?.readFrom(0)?.text]
    .filter((part) => typeof part === 'string' && part.length > 0)
    .join('\n')
  const compacted = text.replace(/\s+/gu, ' ').trim()
  return compacted.length === 0 ? undefined : compacted.slice(-400)
}
