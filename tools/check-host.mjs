/**
 * Host-half gate for dsh-win-pwsh7 — run it with `node tools/check-host.mjs`.
 *
 * `apply()` runs against a stub context, and every tool it registers is then driven the way
 * the tool registry drives it on a successful call: `execute()` for the value, then
 * `output.render()` for the content. `defineTool` always installs a render wrapper, so a
 * definition that never supplied `output.render` registers fine and fails only at call time
 * with `output.render failed: userRender is not a function` — the defect this gate exists to
 * make reproducible without a second DSH process.
 *
 * Nothing real is executed: the stub `subprocess` answers version probes from a table, and
 * the one `pwsh7_install` call runs against a machine that already has a usable PowerShell 7,
 * where the tool must refuse to install anything (the gate also asserts no winget ran).
 */
import { register } from 'node:module'
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import { resolveAppModulesDir } from './dsh-app-modules.mjs'

// Resolve the installation here, in the main thread, so a missing or packed installation reports
// once with a real path instead of failing inside the loader thread's own resolution. A DSH 2.0
// install ships `resources/app.asar`, which Node cannot read; `./dsh-app-modules.mjs` unpacks it
// into a temporary directory (once per archive) and hands the rest of this run a plain folder.
const appModules = resolveAppModulesDir()
if (appModules === undefined) {
  console.error('note — no DSH installation found: set DSH_APP_DIR to the install root, resources/app, or resources/app.asar')
} else {
  if (appModules.includes('dsh-app-modules-')) {
    console.log(`note — the harness packages come from an asar archive, unpacked for this run into ${appModules}`)
  }
  process.env.DSH_APP_DIR = appModules
}

register('./node-app-modules-hook.mjs', import.meta.url)

// The install re-probes for a bounded while after winget exits, and follows winget's own log for
// progress. Both intervals are read when the host half loads, so they are set before the import
// to let the gate run those ticks instantly.
// Small but non-zero: the re-probe must be slow enough that a cancel can land *during* the loop.
process.env.DSH_WIN_PWSH7_RECHECK_MS = '5'
process.env.DSH_WIN_PWSH7_TICK_MS = '5'
// Every pwsh pre-execute refreshes the gate in this gate, so the mutable-reading case is fast.
process.env.DSH_WIN_PWSH7_GATE_TTL_MS = '0'
// The install preflight resolves winget through this override, so the gate never depends on the
// author's PATH. The no-winget case clears it for one assertion.
process.env.DSH_WIN_PWSH7_WINGET = 'winget.exe'
// The inline install graces, so the "still running" paths are reachable without a real wait.
process.env.DSH_WIN_PWSH7_ACTIVATION_GRACE_MS = '50'
process.env.DSH_WIN_PWSH7_INLINE_GRACE_MS = '200'

// The host machine may have a real Store PowerShell 7 installed, and the requirement is that the
// gate is reproducible on such a machine too. Point the probe's well-known locations at an empty
// fixture before the host half loads: every candidate the tests exercise must come from the stub
// table, never from the author's machine.
const gateHome = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-gate-home-'))
mkdirSync(join(gateHome, 'bin'), { recursive: true })
process.env.LOCALAPPDATA = gateHome
process.env.PATH = join(gateHome, 'bin')

const { apply } = await import('../index.js')

/** An ordinary executable that exists on every Windows machine; its version comes from the stub. */
const ORDINARY = 'C:\\Windows\\System32\\cmd.exe'
const POWERSHELL_51 = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'
/**
 * The two Store path shapes the policy now separates. A genuine family alias is a zero-length
 * reparse point, and the plugin's live row check covers that shape; what is under test here is
 * the classification and the policy that follows from it, so the fixture reproduces the *path
 * shape* over a real spawnable file.
 * @returns the fixture root and the two paths.
 */
function makeStoreFixtures() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-gate-'))
  const alias = join(root, 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe')
  const versioned = join(root, 'WindowsApps', 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe', 'pwsh.exe')
  for (const target of [alias, versioned]) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', target)
  }
  return { root, alias, versioned }
}

/**
 * A stub Host context: records registrations, prompt sections and job specs, answers probes,
 * spawns nothing.
 *
 * `deferred` makes every spawn's `done` promise settle only when the test calls `settleAll()`,
 * which is what lets the gate prove the install tool returns *before* winget exits.
 * `jobs: false` omits the job registry entirely, to exercise the inline fallback.
 */
function makeContext({ rows = [], versions = {}, deferred = false, jobs = false, shellPath, shellObject, network = 'Unrestricted|FixtureNet' } = {}) {
  const registered = new Map()
  const spawned = []
  const terminated = []
  const sections = []
  const orderNames = []
  const jobSpecs = []
  const pending = []
  const guards = []
  const listeners = new Map()
  /** Mutable so a test can make winget exit non-zero, as the Store route does. */
  const state = {
    wingetExit: 0,
    wingetStdout: 'Started MSStore package execution. ProductId: 9MZ1SNWT0N5D\r\n',
    storeUiExit: 0,
    storeUiStdout: 'STORE_UI_CLICKED: 安装\r\n',
  }
  const ctx = {
    // Loud on purpose: `apply` catches its own registration failures and warns, so a silent logger
    // here would turn a broken plugin into an empty tool map three checks later.
    logger: {
      info() {},
      // Format `%s` like the Host does, so the warning text cannot leak the placeholder into the
      // gate's own output (OBS-01 in the 2026-10-27 report).
      warn: (first, ...rest) => console.error('[host warn]', String(first).replace(/%s/gu, () => String(rest.shift() ?? ''))),
    },
    effect(fn) {
      fn()
      return () => {}
    },
    plugin() {},
    get: (key) => {
      if (key === 'configForms') return { get: () => ({}) }
      if (key === 'jobs' && jobs) return jobRegistry
      // The pwsh tool executes through `ctx.shell`; the executor's own `pwshPath` is the
      // authoritative "what will run" fact. A context without it keeps the row-based reading.
      if (key === 'shell' && shellObject !== undefined) return shellObject
      if (key === 'shell' && shellPath !== undefined) {
        return {
          pwshPath: shellPath,
          config: { pwshPath: { get: () => undefined } },
        }
      }
      return undefined
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
      guard(guard) {
        guards.push(guard)
        return () => {
          const index = guards.indexOf(guard)
          if (index >= 0) guards.splice(index, 1)
        }
      },
    },
    on(event, listener) {
      const set = listeners.get(event) ?? new Set()
      set.add(listener)
      listeners.set(event, set)
      return () => set.delete(listener)
    },
    systemPrompt: {
      section(section) {
        sections.push(section)
        return () => sections.splice(sections.indexOf(section), 1)
      },
      getSectionOrder(name) {
        orderNames.push(name)
        return 1010 // the shipped TOOL_PWSH placement
      },
    },
    configEditor: { entries: () => rows },
    subprocess: {
      spawn({ argv }) {
        spawned.push(argv[0])
        const isWinget = /winget/iu.test(argv[0])
        const encodedIndex = argv.indexOf('-EncodedCommand')
        const encoded = encodedIndex >= 0 ? argv[encodedIndex + 1] ?? '' : ''
        const decoded = encoded === '' ? '' : Buffer.from(encoded, 'base64').toString('utf16le')
        const isStoreUi = argv.includes('-File') || decoded.includes('STORE_UI') || decoded.includes('ms-windows-store://')
        const isNetworkProbe = /WindowsPowerShell[\\/]v1\.0[\\/]powershell\.exe$/iu.test(argv[0])
        const version = isWinget ? undefined : versions[argv[0]]
        let exitCode = 0
        let stdout = ''
        if (isStoreUi) {
          exitCode = state.storeUiExit
          stdout = state.storeUiStdout
        } else if (isWinget) {
          exitCode = state.wingetExit
          stdout = state.wingetStdout
        } else if (isNetworkProbe && version === undefined) {
          // The install preflight reads the same WinRT cost the Store does. Default to an
          // unrestricted fixture; a test that needs a metered/unreadable cost sets `network`
          // (or `versions[fiftyOne]`) explicitly.
          if (network === null) {
            exitCode = 1
          } else {
            stdout = `${network}\r\n`
          }
        } else if (version === undefined) {
          exitCode = 1
        } else {
          stdout = `${version}\r\n`
        }
        const handle = {
          collected: {
            stdout: { readFrom: () => ({ text: stdout, nextOffset: 8, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode }),
          terminate() { terminated.push(argv[0]) },
        }
        // Only the install process's completion is under test control; version probes must
        // still settle, or every detection would hang the gate.
        if (deferred && /winget/iu.test(argv[0])) {
          let settle
          handle.done = new Promise((resolve) => { settle = resolve })
          pending.push({ argv, settle: () => settle({ exitCode }) })
        }
        return handle
      },
    },
  }
  const jobRegistry = {
    start(spec) {
      if (jobs === 'refuse') throw new Error('no attached job controller serves this owner')
      jobSpecs.push(spec)
      return `pwsh7-${jobSpecs.length}`
    },
  }
  return { ctx, registered, spawned, terminated, sections, orderNames, jobSpecs, state, guards, listeners, settleAll: () => { for (const entry of pending.splice(0)) entry.settle() } }
}

/** Let every microtask chain the activation sweep started settle, so the shared note is stable. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

/** One executor row pinning a path, as Desktop's generated patch declares it. */
const executorRow = (pwshPath, extra = {}) => ({
  options: {
    id: extra.id ?? 'desktop-windows-pwsh-sandbox',
    name: extra.name ?? 'dsh-plugin-desktop/windows-pwsh-sandbox',
    config: { pwshPath },
  },
  ...(extra.disabled === undefined ? {} : { disabled: extra.disabled }),
})

const failures = []
function check(label, assertion) {
  try {
    assertion()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// --- A machine that already has a usable PowerShell 7 ------------------------------------

const machine = makeContext({
  rows: [{
    options: {
      id: 'desktop-windows-pwsh-sandbox',
      name: 'dsh-plugin-desktop/windows-pwsh-sandbox',
      config: {},
    },
  }],
  versions: { [ORDINARY]: '7.6.6' },
})
apply(machine.ctx, { overridePath: ORDINARY })

check('registers exactly the two tools', () => {
  assert.deepEqual([...machine.registered.keys()].sort(), ['pwsh7_install', 'pwsh7_status'])
})

check('tool copy: both descriptions carry the current policy, not a retired one', () => {
  const status = machine.registered.get('pwsh7_status')
  const install = machine.registered.get('pwsh7_install')
  // A description is model-facing copy that no scan of the *report* would catch: the live schema
  // still said "ordinary-file PowerShell 7" two releases after the family alias was accepted.
  assert.ok(!/ordinary-file/u.test(`${status.description} ${status.parameters.properties.path.description}`),
    'pwsh7_status still claims the retired ordinary-file rule')
  assert.match(status.description, /family alias/u)
  assert.match(install.description, /background job/u)
  assert.match(install.description, /job_output/u)
  assert.ok(!/MSI build/u.test(install.description),
    'pwsh7_install still presents the MSI as the install route')
})

for (const tool of machine.registered.values()) {
  const value = await tool.execute({}, undefined)
  check(`${tool.name}: execute returns a non-empty { report }`, () => {
    assert.equal(typeof value?.report, 'string')
    assert.ok(value.report.length > 0, 'report must not be empty')
  })
  check(`${tool.name}: output.render returns the report as one text block`, () => {
    const content = tool.output.render({}, value)
    assert.ok(Array.isArray(content), 'render must return content blocks')
    assert.deepEqual(content, [{ type: 'text', text: value.report }])
  })
}

check('the install tool refuses to install over a usable PowerShell 7', () => {
  assert.ok(!machine.spawned.some((executable) => /winget/iu.test(executable)),
    `winget was spawned: ${machine.spawned.join(', ')}`)
})

const overrideReport = (await machine.registered.get('pwsh7_status').execute({}, undefined)).report
check('config guidance: overridePath is explicitly not executor wiring', () => {
  assert.match(overrideReport, /overridePath is only what this plugin probes/u)
  assert.match(overrideReport, /pwshPath: 'C:\\Windows\\System32\\cmd\.exe'/u)
})

const replaceMachine = makeContext({
  rows: [{
    options: {
      id: 'pwsh-sandbox',
      name: '@deepseek-ai/dsh-pwsh-sandbox',
      config: { pwshPath: POWERSHELL_51, timeoutMs: 1234 },
    },
  }],
  versions: { [POWERSHELL_51]: '5.1.26100', [ORDINARY]: '7.6.6' },
})
apply(replaceMachine.ctx, { overridePath: ORDINARY })
const replaceReport = (await replaceMachine.registered.get('pwsh7_status').execute({}, undefined)).report
check('config guidance: an existing row is updated, and config replaces wholesale', () => {
  assert.match(replaceReport, /update this in the profile patch/u)
  assert.match(replaceReport, /timeoutMs: 1234/u)
  assert.match(replaceReport, /pwshPath: 'C:\\Windows\\System32\\cmd\.exe'/u)
  assert.match(replaceReport, /replaces that row's config wholesale/u)
})

// --- The executor's own path is authoritative -------------------------------------------

const shellMachine = makeContext({
  shellPath: 'C:\\Tools\\pwsh.exe',
  versions: { 'C:\\Tools\\pwsh.exe': '7.6.9' },
})
apply(shellMachine.ctx, {})
await flush()
const shellValue = await shellMachine.registered.get('pwsh7_status').execute({}, undefined)

check('the report reads the executor path, not the config rows', () => {
  const value = shellValue
  assert.match(value.report, /via the executor \(C:\\Tools\\pwsh\.exe\)/u)
  assert.match(value.report, /PowerShell 7\.6\.9/u)
  assert.match(value.report, /Nothing to configure/u)
})

// An install that lands while the host is running leaves PwshLocalExecutor's cached 5.1 path in
// place. The status must never call that "native" just because the resolver now finds a 7.
const staleMachine = makeContext({
  shellPath: POWERSHELL_51,
  versions: { [POWERSHELL_51]: '5.1.26100', [ORDINARY]: '7.6.6' },
})
apply(staleMachine.ctx, { overridePath: ORDINARY })
await flush()
const staleReport = (await staleMachine.registered.get('pwsh7_status').execute({}, undefined)).report
check('status: a live 5.1 executor is never reported as natively picked up', () => {
  assert.match(staleReport, /running executor still resolves to Windows PowerShell 5\.1/u)
  assert.ok(!/Nothing to configure/u.test(staleReport), `the stale executor was called native:\n${staleReport}`)
  assert.match(staleReport, /pwshPath: 'C:\\Windows\\System32\\cmd\.exe'/u)
})

// The fix: a cache nudge makes the same getter re-run the resolver, so the tool becomes usable
// without a profile pin or a restart.
const paths = { current: POWERSHELL_51 }
const nudgeShell = {
  declaredPwshPath: undefined,
  resolvedPwshPath: POWERSHELL_51,
  config: { pwshPath: { get: () => undefined } },
  get pwshPath() {
    const declared = undefined
    if (declared !== this.declaredPwshPath) {
      this.resolvedPwshPath = paths.current
      this.declaredPwshPath = declared
    }
    return this.resolvedPwshPath
  },
}
const nudgeMachine = makeContext({
  shellObject: nudgeShell,
  versions: { [POWERSHELL_51]: '5.1.26100', [ORDINARY]: '7.6.6' },
})
apply(nudgeMachine.ctx, { overridePath: ORDINARY })
paths.current = ORDINARY
await flush()
const nudgeReport = (await nudgeMachine.registered.get('pwsh7_status').execute({}, undefined)).report
check('status: a cache nudge refreshes the live executor after an install', () => {
  assert.match(nudgeReport, /PowerShell 7\.6\.6/u)
  assert.ok(!/running executor still resolves to Windows PowerShell 5\.1/u.test(nudgeReport),
    `the nudge did not refresh the executor:\n${nudgeReport}`)
})

// --- Rejections, and the two Store forms ------------------------------------------------

const status = machine.registered.get('pwsh7_status')
const rejections = [
  [POWERSHELL_51, 'only Windows PowerShell 5.1 is available'],
  ['C:\\no\\such\\directory\\pwsh.exe', 'does not exist, so it cannot be a spawn target'],
]
for (const [path, expected] of rejections) {
  const value = await status.execute({ path }, undefined)
  check(`pwsh7_status rejects ${path}`, () => {
    assert.ok(value.report.includes(expected), `report was:\n${value.report}`)
  })
}

const fixtures = makeStoreFixtures()
const aliasPin = await hintOn([executorRow(fixtures.alias)], { [fixtures.alias]: '7.6.6' })
const versionedPin = await hintOn([executorRow(fixtures.versioned)], { [fixtures.versioned]: '7.6.6' })

check('Store policy: a pinned family alias counts as stable wiring, with no nag', () => {
  assert.match(aliasPin.report, /PowerShell 7\.6\.6/u)
  assert.match(aliasPin.report, /version-stable Store family alias/u)
  assert.match(aliasPin.report, /Nothing to configure/u)
  assert.ok(!/silently stop working/u.test(aliasPin.report), 'a family alias pin must not be reported as broken')
})
check('Store policy: a version-numbered Store pin is still refused', () => {
  assert.match(versionedPin.report, /version-numbered Store path/u)
  assert.match(versionedPin.report, /silently stop working/u)
  assert.ok(!/Nothing to configure/u.test(versionedPin.report), 'a version-numbered pin must not read as fine')
})
const aliasAccepted = await aliasPin.machine.registered.get('pwsh7_status').execute({ path: fixtures.alias }, undefined)
check('Store policy: the family alias is now accepted where it used to be rejected outright', () => {
  assert.match(aliasAccepted.report, /Requested path: PowerShell 7\.6\.6 \(Store family alias\)/u)
  assert.ok(!/Store execution alias \(a reparse point\), not an ordinary file/u.test(aliasAccepted.report))
})
const versionedAccepted = await versionedPin.machine.registered.get('pwsh7_status').execute({ path: fixtures.versioned }, undefined)
check('Store policy: a version-numbered path is accepted as a runtime but flagged as un-pinnable', () => {
  assert.match(versionedAccepted.report, /do not pin it/u)
})
rmSync(fixtures.root, { recursive: true, force: true })

// --- The prompt section: what `pwsh` actually runs, and whether `&&` works ---------------

/** One machine, applied, with the note settled; returns its section and a status call. */
async function hintOn(rows, versions) {
  const machine = makeContext({ rows, versions })
  apply(machine.ctx, {})
  const section = machine.sections[0]
  const value = await machine.registered.get('pwsh7_status').execute({}, undefined)
  await flush()
  return { machine, section, text: typeof section?.text === 'function' ? section.text() : section?.text, report: value.report }
}

const stable = await hintOn([executorRow(ORDINARY)], { [ORDINARY]: '7.6.6' })
check('prompt section: registered once, under our own name, beside the shipped pwsh note', () => {
  assert.equal(stable.machine.sections.length, 1)
  assert.equal(stable.section.name, 'tool:pwsh-runtime')
  assert.deepEqual(stable.machine.orderNames, ['TOOL_PWSH'])
  assert.equal(stable.section.order, 1010)
})
check('prompt section: a pinned PowerShell 7 says the version and that && works', () => {
  assert.match(stable.text, /PowerShell 7\.6\.6/u)
  assert.match(stable.text, /`&&`/u)
})

const fiveOne = await hintOn([executorRow(POWERSHELL_51)], { [POWERSHELL_51]: '5.1.26100' })
check('prompt section: a row pinning Windows PowerShell 5.1 warns that && is a parse error', () => {
  assert.match(fiveOne.text, /Windows PowerShell 5\.1\.26100/u)
  assert.match(fiveOne.text, /parse errors/u)
  assert.match(fiveOne.text, /`;`/u)
})
check('prompt section: the 5.1 report still calls the path unusable and points at the install tool', () => {
  assert.match(fiveOne.report, /not a usable PowerShell 7/u)
  assert.match(fiveOne.report, /pwsh7_install/u)
})

const brokenPin = await hintOn([executorRow('C:\\no\\such\\directory\\pwsh.exe')], {})
check('prompt section: a pin that no longer exists says the tool cannot start, with the two paths', () => {
  assert.match(brokenPin.text, /cannot start/u)
  assert.match(brokenPin.text, /C:\\no\\such\\directory\\pwsh\.exe/u)
  assert.match(brokenPin.text, /Microsoft Store/u)
  assert.match(brokenPin.text, /disable this plugin/u)
  assert.ok(!/`&&`/u.test(brokenPin.text),
    'a runtime that cannot start must not claim the operators work')
})

// --- The gate: a call-time denial, not a hidden tool ------------------------------------

check('gate: a PowerShell 7 reading allows a pwsh call', () => {
  assert.equal(stable.machine.guards[0]?.({ name: 'pwsh' }), undefined)
})
check('gate: Windows PowerShell 5.1 denies with report/install/config guidance', () => {
  const reason = fiveOne.machine.guards[0]?.({ name: 'pwsh' })
  assert.match(reason, /blocked/u)
  assert.match(reason, /Do not retry/u)
  assert.match(reason, /pwsh7_status/u)
  assert.match(reason, /pwsh7_install/u)
  assert.match(reason, /pwsh-sandbox\.pwshPath/u)
  assert.match(reason, /Win\+R/u)
  assert.match(reason, /ms-windows-store:\/\/pdp/u)
  assert.match(reason, /disable dsh-win-pwsh7/u)
})
check('gate: a broken pin denies as cannot-start, naming the path', () => {
  const reason = brokenPin.machine.guards[0]?.({ name: 'pwsh' })
  assert.match(reason, /cannot start/u)
  assert.match(reason, /C:\\no\\such\\directory\\pwsh\.exe/u)
})
check('gate: the plugin’s own recovery tools are never denied', () => {
  assert.equal(fiveOne.machine.guards[0]?.({ name: 'pwsh7_status' }), undefined)
  assert.equal(fiveOne.machine.guards[0]?.({ name: 'pwsh7_install' }), undefined)
})

// A stale gate must be refreshed by the next pwsh call: that is the seam that makes an install
// performed outside the plugin visible without a restart.
const mutableVersions = { [POWERSHELL_51]: '5.1.26100' }
const refreshMachine = makeContext({ rows: [executorRow(POWERSHELL_51)], versions: mutableVersions })
apply(refreshMachine.ctx, {})
await refreshMachine.registered.get('pwsh7_status').execute({}, undefined)
check('gate refresh: the initial 5.1 reading denies', () => {
  assert.match(refreshMachine.guards[0]?.({ name: 'pwsh' }), /blocked/u)
})
mutableVersions[POWERSHELL_51] = '7.6.6'
const preExecute = [...(refreshMachine.listeners.get('tools/pre-execute') ?? [])][0]
assert.ok(preExecute !== undefined, 'apply registered no tools/pre-execute listener')
await preExecute({ name: 'pwsh' }, async () => ({ kind: 'allow' }))
check('gate refresh: a pre-execute refresh picks up the new runtime', () => {
  assert.equal(refreshMachine.guards[0]?.({ name: 'pwsh' }), undefined)
})
mutableVersions[POWERSHELL_51] = '5.1.26100'
const configReload = [...(refreshMachine.listeners.get('app-boot/config-reload') ?? [])][0]
assert.ok(configReload !== undefined, 'apply registered no app-boot/config-reload listener')
configReload()
await flush()
check('gate refresh: a config reload picks up a reverted runtime', () => {
  assert.match(refreshMachine.guards[0]?.({ name: 'pwsh' }), /blocked/u)
})

// This whole half of the gate runs against fixtures on **any** machine: `PATH`, `LOCALAPPDATA`
// and `ProgramFiles` are pinned so the probe cannot reach this machine's own installs. The
// upstream resolver reads `env.ProgramFiles` for its first candidate (a stable MSI install), which
// is exactly why pinning it lets every check below run even where that MSI exists — an earlier
// version skipped this entire block in that case and still printed `ok`, which is the one failure
// mode a gate must never have.
const MSI = 'C:\\Program Files\\PowerShell\\7\\pwsh.exe'
if (existsSync(MSI)) {
  console.log(`note — this machine has ${MSI}; ProgramFiles is pinned below, so every check still runs`)
}

{
  const savedPath = process.env.PATH
  const savedLocalAppData = process.env.LOCALAPPDATA
  const savedProgramFiles = process.env.ProgramFiles
  process.env.PATH = 'C:\\Windows\\System32'
  process.env.ProgramFiles = join(tmpdir(), 'dsh-win-pwsh7-no-such-program-files')
  const fallback = await hintOn([executorRow(undefined)], {})
  process.env.PATH = savedPath
  check('prompt section: with no PowerShell 7, the executor fallback 5.1 is reported', () => {
    assert.match(fallback.text, /Windows PowerShell 5\.1/u)
    assert.match(fallback.text, /parse errors/u)
    assert.match(fallback.report, /not usable/u)
  })
  check('install path: the report offers install, configure and disable, and no other installer', () => {
    assert.match(fallback.report, /Three ways forward/u)
    assert.match(fallback.report, /Install PowerShell 7 from the Microsoft Store/u)
    assert.ok(!/winget install/u.test(fallback.report), 'only script/manual installs may be offered')
    assert.match(fallback.report, /Win\+R/u)
    assert.match(fallback.report, /pwsh-sandbox\.pwshPath/u)
    assert.match(fallback.report, /Disable this plugin/u)
    assert.ok(!/--source winget/u.test(fallback.report), 'no second installer may appear in the report')
    assert.ok(!/--installer-type wix/u.test(fallback.report), 'the MSI must not be offered at all')
  })

  // MSIX activation puts the version-numbered package directory at the head of PATH, so the
  // upstream resolver reports that path — and the auto-probe has to land on the family alias
  // beside it instead. Point PATH and LOCALAPPDATA at fixtures to pin the behaviour down.
  const storeRoot = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-store-'))
  const versionedDir = join(storeRoot, 'versioned', 'WindowsApps', 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe')
  const aliasRoot = join(storeRoot, 'alias')
  const versionedPath = join(versionedDir, 'pwsh.exe')
  const aliasPath = join(aliasRoot, 'Microsoft', 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe')
  for (const target of [versionedPath, aliasPath]) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', target)
  }
  const storeMachine = makeContext({
    rows: [executorRow(undefined)],
    versions: { [versionedPath]: '7.6.6', [aliasPath]: '7.6.6' },
  })
  process.env.PATH = versionedDir
  process.env.LOCALAPPDATA = aliasRoot
  apply(storeMachine.ctx, {})
  const preferReport = (await storeMachine.registered.get('pwsh7_status').execute({}, undefined)).report
  const installReport = (await storeMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report
  process.env.PATH = savedPath
  process.env.LOCALAPPDATA = savedLocalAppData
  rmSync(storeRoot, { recursive: true, force: true })

  check('auto-probe: a version-numbered Store path resolves to the pinnable family alias', () => {
    assert.match(preferReport, /Store family alias/u)
    assert.ok(!/version-numbered Store path/u.test(preferReport),
      `the version-numbered path must not be the reported candidate:\n${preferReport}`)
  })
  check('install: a machine with a working Store alias is already in place, so winget never runs', () => {
    assert.match(installReport, /already in place/u)
    assert.ok(!storeMachine.spawned.some((executable) => /winget/iu.test(executable)),
      `winget was spawned: ${storeMachine.spawned.join(', ')}`)
  })

  // --- the install as a background job -----------------------------------------------------
  const jobRoot = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-job-'))
  const jobVersionedDir = join(jobRoot, 'WindowsApps', 'Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe')
  const jobAliasRoot = join(jobRoot, 'local')
  const jobAlias = join(jobAliasRoot, 'Microsoft', 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe')
  for (const target of [join(jobVersionedDir, 'pwsh.exe'), jobAlias]) {
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', target)
  }
  // A fixture `winget.exe` too. `spawnWingetProcess` resolves it through the real filesystem, so
  // without this the job and inline-install checks silently needed winget on the *host* — which is
  // not what "the behaviour half is fixture-pinned and runs on any machine" claims. An empty file is
  // enough: the process itself is stubbed, only the resolve is real.
  writeFileSync(join(jobRoot, 'winget.exe'), '')
  const jobVersions = {} // nothing reports a version yet: the machine has no usable PowerShell 7
  const jobMachine = makeContext({ rows: [executorRow(undefined)], versions: jobVersions, deferred: true, jobs: true })
  // The fixture directory leads PATH so the probe resolves into it, and the fixture `winget.exe`
  // lives in `jobRoot` itself, so a scheduled task does not depend on the host having winget.
  process.env.PATH = `${jobRoot};${jobVersionedDir};${savedPath}`
  process.env.LOCALAPPDATA = jobAliasRoot
  apply(jobMachine.ctx, {})
  const startedReport = (await jobMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report
  const spec = jobMachine.jobSpecs[0]
  const jobStub = {
    progress: [],
    appended: [],
    updateProgress(line) { this.progress.push(line) },
    append(text) { this.appended.push(text) },
  }
  // Freeze the clock past the stall threshold so the warning branch is actually reached.
  const realNow = Date.now
  Date.now = () => realNow() + 11 * 60 * 1000
  const stalledHooks = spec.run(jobStub)
  Date.now = realNow
  jobVersions[jobAlias] = '7.6.6' // the install lands while winget is still running
  jobMachine.settleAll() // winget exits 0
  const jobOutcome = await stalledHooks.done
  // A second run on the clock covers the ordinary progress line. Take the version back out so
  // the machine looks uninstalled again and the install path runs once more.
  delete jobVersions[jobAlias]
  apply(jobMachine.ctx, {})
  await jobMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const runningStub = { progress: [], updateProgress(line) { this.progress.push(line) }, append() {} }
  jobMachine.jobSpecs[1].run(runningStub)

  check('install: the Store install runs as a background job and the call returns at once', () => {
    assert.match(startedReport, /background as job pwsh7-1/u)
    assert.match(startedReport, /job_output/u)
    assert.match(startedReport, /30-second/u)
    assert.match(startedReport, /timeout_ms:30000/u)
    assert.match(startedReport, /VPN/u)
    assert.ok(!/finished successfully/u.test(startedReport), 'the call must not wait for the install')
  })

  // The install refuses to start until the model has asked the user about the VPN.
  const confirmMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(confirmMachine.ctx, {})
  const confirmReport = (await confirmMachine.registered.get('pwsh7_install').execute({}, undefined)).report
  check('install: a missing VPN confirmation asks the user and starts nothing', () => {
    assert.equal(confirmMachine.jobSpecs.length, 0)
    assert.match(confirmReport, /VPN/u)
    assert.match(confirmReport, /vpnOffConfirmed: true/u)
    assert.match(confirmReport, /Store window will open/u)
  })

  const uiMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(uiMachine.ctx, {})
  const uiReport = (await uiMachine.registered.get('pwsh7_install').execute({ method: 'store-ui', vpnOffConfirmed: true }, undefined)).report
  const uiStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const uiHooks = uiMachine.jobSpecs[0].run(uiStub)
  uiMachine.settleAll()
  const uiOutcome = await uiHooks.done
  check('install: store-ui opens the Store page and clicks Install in a job', () => {
    assert.match(uiReport, /Opening Microsoft Store and clicking Install/u)
    assert.equal(uiMachine.jobSpecs.length, 1)
    assert.match(uiMachine.jobSpecs[0].label, /Microsoft Store UI/u)
    assert.match(uiStub.progress[0], /opening the Microsoft Store page/u)
    assert.match(uiOutcome.result, /Store page opened and Install was clicked/u)
  })

  const uiFailMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  uiFailMachine.state.storeUiExit = 2
  uiFailMachine.state.storeUiStdout = 'STORE_UI_NOT_FOUND\r\n'
  apply(uiFailMachine.ctx, {})
  await uiFailMachine.registered.get('pwsh7_install').execute({ method: 'store-ui', vpnOffConfirmed: true }, undefined)
  const uiFailHooks = uiFailMachine.jobSpecs[0].run({ progress: [], appended: [], updateProgress() {}, append() {} })
  uiFailMachine.settleAll()
  const uiFailOutcome = await uiFailHooks.done
  check('install: a Store page that does not load asks for VPN off and the manual path', () => {
    assert.equal(uiFailOutcome.status, 'failed')
    assert.match(uiFailOutcome.result, /Store page did not load/u)
    assert.match(uiFailOutcome.result, /First ask the user/u)
    assert.match(uiFailOutcome.result, /Win\+R/u)
  })

  // Three consecutive failures open the breaker; the fourth call starts nothing and asks for an
  // explicit user confirmation. Passing userConfirmedFixed resets the count and allows one retry.
  for (let attempt = 1; attempt < 3; attempt += 1) {
    await uiFailMachine.registered.get('pwsh7_install').execute({ method: 'store-ui', vpnOffConfirmed: true }, undefined)
    const hooks = uiFailMachine.jobSpecs[attempt].run({ progress: [], appended: [], updateProgress() {}, append() {} })
    uiFailMachine.settleAll()
    await hooks.done
  }
  const breakerReport = (await uiFailMachine.registered.get('pwsh7_install').execute({ vpnOffConfirmed: true }, undefined)).report
  check('install: 3 consecutive failures stop the next install and ask for confirmation', () => {
    assert.equal(uiFailMachine.jobSpecs.length, 3, 'a fourth install job was started after 3 failures')
    assert.match(breakerReport, /3 consecutive script installs/u)
    assert.match(breakerReport, /userConfirmedFixed: true/u)
    assert.match(breakerReport, /Win\+R/u)
  })
  const fixedReport = (await uiFailMachine.registered.get('pwsh7_install').execute({ vpnOffConfirmed: true, userConfirmedFixed: true }, undefined)).report
  check('install: an explicit user-confirmed fix resets the breaker for one retry', () => {
    assert.equal(uiFailMachine.jobSpecs.length, 4)
    assert.match(fixedReport, /Opening Microsoft Store and clicking Install/u)
  })
  check('install job: kind, label, both output streams, and a runnable body', () => {
    assert.equal(spec.kind, 'pwsh7')
    assert.match(spec.label, /install \(Microsoft Store\)/u)
    assert.equal(spec.output.length, 2)
    assert.equal(typeof spec.run, 'function')
  })
  check('install job: winget runs the Store install', () => {
    assert.ok(jobMachine.spawned.some((executable) => /winget/iu.test(executable)),
      `no winget was spawned: ${jobMachine.spawned.join(', ')}`)
  })
  check('install job: settling re-validates instead of trusting winget exit code 0', () => {
    assert.equal(jobOutcome.status, 'completed')
    assert.match(jobOutcome.result, /is now in place/u)
    assert.match(jobOutcome.result, /PowerShell 7\.6\.6/u)
    assert.match(jobStub.appended.join('\n'), /is now in place/u, 'the verdict must land in the job output ring')
  })
  check('install job: progress is reported, and a stalled Store run names the queue', () => {
    assert.match(jobStub.progress[0], /Store may be queued/u)
    assert.match(jobStub.progress[0], /pause and resume/u)
    assert.match(jobStub.progress[0], /job_kill/u)
    assert.match(runningStub.progress[0], /^running \d+m$/u)
  })

  // A failed exit is evidence, not a verdict: measured Store runs exit 1 while the runtime turns
  // up afterwards, so the plugin re-probes and must report the runtime, not the exit code.
  // `flipAfter` is derived from the probes actually taken (rather than guessed), so the alias
  // appears exactly on the second re-check — the observed shape — with no sleeping.
  let aliasProbes = 0
  let flipAfter = Number.POSITIVE_INFINITY
  const lyingVersions = new Proxy({}, {
    get: (_target, key) => {
      if (key !== jobAlias) return undefined
      aliasProbes += 1
      return aliasProbes > flipAfter ? '7.6.6' : undefined
    },
  })
  const lyingMachine = makeContext({ rows: [executorRow(undefined)], versions: lyingVersions, deferred: true, jobs: true })
  lyingMachine.state.wingetExit = 1
  apply(lyingMachine.ctx, {})
  await lyingMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  flipAfter = aliasProbes + 1
  const lyingStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const lyingHooks = lyingMachine.jobSpecs[0].run(lyingStub)
  lyingMachine.settleAll()
  const lyingOutcome = await lyingHooks.done

  check('install job: a non-zero winget exit does not become a failed verdict when the runtime lands', () => {
    assert.equal(lyingOutcome.status, 'completed')
    assert.match(lyingOutcome.result, /reported failure/u)
    assert.match(lyingOutcome.result, /but the runtime is in place/u)
    assert.match(lyingOutcome.result, /PowerShell 7\.6\.6/u)
  })
  check('install job: the re-check is reported on the progress line', () => {
    assert.ok(lyingStub.progress.some((line) => /re-checking whether the install lands anyway/u.test(line)),
      `no re-check line: ${lyingStub.progress.join(' | ')}`)
  })

  // And when nothing lands, the verdict must name the real cause. The measured failures happened
  // on a non-metered connection and were Store-handoff failures, so the text must not keep blaming
  // metering; it must offer the Store queue recovery and the manual fallback.
  const storeRouteMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  storeRouteMachine.state.wingetExit = 1
  apply(storeRouteMachine.ctx, {})
  await storeRouteMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const storeSpec = storeRouteMachine.jobSpecs[0]
  const storeStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const realNow2 = Date.now
  Date.now = () => realNow2() + 11 * 60 * 1000
  const storeHooks = storeSpec.run(storeStub)
  Date.now = realNow2
  storeRouteMachine.settleAll()
  const storeOutcome = await storeHooks.done

  check('install job: a non-metered failure points at the Store queue and the manual fallback', () => {
    assert.equal(storeOutcome.status, 'failed')
    assert.ok(!/Turn "Metered connection" off/u.test(storeOutcome.result), `a non-metered failure gave metering advice: ${storeOutcome.result}`)
    assert.ok(!/marked as metered/u.test(storeOutcome.result))
    assert.match(storeOutcome.result, /pause and resume/u)
    assert.match(storeOutcome.result, /ms-windows-store:\/\/pdp/u)
    assert.match(storeOutcome.result, /no pwshPath pin/u)
  })

  // The 0x80d03801 shape from the 2026-10-27 report: the verdict must translate the code and keep
  // the manual Store path, rather than printing only the raw winget tail.
  const codeMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  codeMachine.state.wingetExit = 1
  codeMachine.state.wingetStdout = 'Started MSStore package execution. ProductId: 9MZ1SNWT0N5D\r\n无法安装或更新 Microsoft Store 程序包。错误代码: 0x80d03801\r\n'
  apply(codeMachine.ctx, {})
  await codeMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const codeStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const codeHooks = codeMachine.jobSpecs[0].run(codeStub)
  codeMachine.settleAll()
  const codeOutcome = await codeHooks.done
  check('install job: 0x80d03801 is translated and keeps the manual Store path', () => {
    assert.match(codeOutcome.result, /0x80D03801/u)
    assert.match(codeOutcome.result, /Store download\/deployment/u)
    assert.match(codeOutcome.result, /ms-windows-store:\/\/pdp/u)
    assert.ok(!/Turn "Metered connection" off/u.test(codeOutcome.result), `a Store handoff failure gave metering advice: ${codeOutcome.result}`)
  })

  // The one probe that turns "the Store just sits there" into a named cause. The stub answers the
  const clearMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(clearMachine.ctx, {})
  const clearReport = (await clearMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report

  const savedWinget = process.env.DSH_WIN_PWSH7_WINGET
  process.env.DSH_WIN_PWSH7_WINGET = ''
  const noWingetMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(noWingetMachine.ctx, {})
  const noWingetReport = (await noWingetMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report
  process.env.DSH_WIN_PWSH7_WINGET = savedWinget

  check('install: the store method starts the job without a network preflight', () => {
    assert.equal(clearMachine.jobSpecs.length, 1)
    assert.ok(!/not started/iu.test(clearReport), `the report blocked a usable install: ${clearReport.slice(0, 240)}`)
  })
  check('install: a missing winget points at store-ui instead of blocking', () => {
    assert.equal(noWingetMachine.jobSpecs.length, 0)
    assert.match(noWingetReport, /winget method/u)
    assert.match(noWingetReport, /store-ui/u)
    assert.match(noWingetReport, /Win\+R/u)
  })

  // Progress has to come from winget's own log: with a captured stdout, winget draws no progress
  // bar and one measured run spent 4m15s inside a single silent staging phase.
  const logDir = join(jobAliasRoot, 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'DiagOutputDir')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'WinGet-fixture.log')
  writeFileSync(logFile, '2026-10-13 23:44:30.385 <I> [CLI ] Installer hash verified\n')
  const logMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(logMachine.ctx, {})
  await logMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const logStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  logMachine.jobSpecs[0].run(logStub)
  await new Promise((resolve) => setTimeout(resolve, 60))
  appendFileSync(logFile, '2026-10-13 23:44:32.500 <I> [CORE] Starting StagePackageAsync operation #1: …msixbundle\n')
  await new Promise((resolve) => setTimeout(resolve, 60))

  check('install progress: winget log phases become job progress, and the raw lines reach the output ring', () => {
    assert.ok(logStub.progress.some((line) => /installer downloaded and verified/u.test(line)),
      `no verified phase in: ${logStub.progress.join(' | ')}`)
    assert.ok(logStub.progress.some((line) => /deploying the package/u.test(line)),
      `no staging phase in: ${logStub.progress.join(' | ')}`)
    assert.ok(logStub.appended.join('').includes('Installer hash verified'),
      'the raw winget log lines must reach the job output')
    assert.ok(logStub.appended.join('').includes('StagePackageAsync'),
      'later winget log lines must reach the job output too')
  })

  // The stall warning must be reachable *and* additive. It used to sit in an `else if` beside the
  // phase, and the follower returns the last known phase rather than "nothing new" — so once any
  // phase had been recognised (winget logs one within the first ticks of every run) the warning was
  // dead on every real machine, while this fixture, which is empty when the clock is patched,
  // happily exercised it. Both halves are asserted on one line here.
  const stallNow = Date.now
  Date.now = () => stallNow() + 11 * 60 * 1000
  await new Promise((resolve) => setTimeout(resolve, 40))
  Date.now = stallNow

  check('install progress: a known phase and a stall warning can appear together', () => {
    const line = logStub.progress.slice(-1)[0] ?? ''
    assert.match(line, /deploying the package|installer downloaded/u, `the phase was lost: ${line}`)
    assert.match(line, /nothing has moved for a while/u, `no stall warning: ${line}`)
  })

  // The download is measured from the bytes winget writes under %TEMP%\WinGet: winget reports no
  // numeric progress of its own (a PTY run showed only a spinner and an "indeterminate" signal),
  // and that directory is where the installer lands.
  const tempRoot = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-temp-'))
  const downloadDir = join(tempRoot, 'WinGet', 'Microsoft.PowerShell.7.6.6.0')
  mkdirSync(downloadDir, { recursive: true })
  const bundle = join(downloadDir, 'PowerShell-7.6.6.msixbundle')
  writeFileSync(bundle, Buffer.alloc(2 * 1024 * 1024, 1))
  const savedTemp = process.env.TEMP
  process.env.TEMP = tempRoot
  const downloadMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(downloadMachine.ctx, {})
  await downloadMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const downloadStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  downloadMachine.jobSpecs[0].run(downloadStub)
  await new Promise((resolve) => setTimeout(resolve, 400))
  appendFileSync(bundle, Buffer.alloc(2 * 1024 * 1024, 2))
  await new Promise((resolve) => setTimeout(resolve, 1200))
  process.env.TEMP = savedTemp
  rmSync(tempRoot, { recursive: true, force: true })

  check('install progress: the download is measured in mebibytes and mebibytes per second', () => {
    assert.ok(downloadStub.progress.some((line) => /downloaded \d+\.\d MiB/u.test(line)),
      `no byte progress in: ${downloadStub.progress.slice(-4).join(' | ')}`)
    assert.ok(downloadStub.progress.some((line) => /MiB\/s/u.test(line)),
      `no speed in: ${downloadStub.progress.slice(-4).join(' | ')}`)
  })

  process.env.PATH = savedPath
  // These three cases build their own machines, so they pin the same fixtures the install block
  // above used: the probe counter below only sees probes of the family alias, which is reachable
  // while PATH still resolves the version-numbered Store fixture. Depending on the ambient state
  // here would make the assertion pass or fail by ordering accident.
  const savedCasePath = process.env.PATH
  const savedCaseLocalAppData = process.env.LOCALAPPDATA
  process.env.PATH = `${jobVersionedDir};${savedPath}`
  process.env.LOCALAPPDATA = jobAliasRoot

  // Cancellation is the path a user reaches for when an install stalls (`job_kill` ends in
  // `cancel()`), and it is the one stateful branch nothing else here drives: it must terminate the
  // process *and* stop the progress timer.
  const cancelMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(cancelMachine.ctx, {})
  await cancelMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const cancelStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const cancelHooks = cancelMachine.jobSpecs[0].run(cancelStub)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const ticksBeforeCancel = cancelStub.progress.length
  cancelHooks.cancel()
  await new Promise((resolve) => setTimeout(resolve, 40))
  const ticksAfterCancel = cancelStub.progress.length
  cancelMachine.settleAll()

  check('install job: cancel terminates the process and stops the progress timer', () => {
    assert.ok(cancelMachine.terminated.some((executable) => /winget/iu.test(executable)),
      `cancel did not terminate the install process: ${cancelMachine.terminated.join(', ')}`)
    assert.equal(ticksAfterCancel, ticksBeforeCancel,
      `progress kept ticking after cancel: ${ticksBeforeCancel} -> ${ticksAfterCancel}`)
  })

  // The two inline fallbacks were unexercised, which is how a wrong message in them went
  // unnoticed; the probe count is what makes the *other* half of that fix testable — the bounded
  // re-probe. One probe happens before the install (detect), one inside a single-shot verdict; the
  // bounded re-probe is what pushes the count past two.
  let inlineProbes = 0
  const inlineVersions = new Proxy({}, {
    get: (_target, key) => {
      if (key !== jobAlias) return undefined
      inlineProbes += 1
      return undefined
    },
  })
  const inlineMachine = makeContext({ rows: [executorRow(undefined)], versions: inlineVersions, jobs: false })
  apply(inlineMachine.ctx, {})
  const inlineReport = (await inlineMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report
  const refuseMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: 'refuse' })
  apply(refuseMachine.ctx, {})
  const refuseReport = (await refuseMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)).report

  check('install: no job registry means the install runs inline, says so, and still runs winget', () => {
    assert.match(inlineReport, /ran inline/u)
    assert.ok(inlineMachine.spawned.some((executable) => /winget/iu.test(executable)),
      'winget never ran on the inline path')
  })
  check('install: the inline fallback re-probes the runtime instead of trusting the exit code', () => {
    // Composition: the activation sweep probes once, the install path once before spawn, and the
    // bounded re-probe at least twice more. A single-shot verdict stops at three — which is what
    // this threshold is calibrated against, and what a mutation run confirmed.
    assert.ok(inlineProbes >= 4,
      `the inline path probed the runtime only ${inlineProbes} time(s) — no bounded re-probe ran`)
  })
  check('install: a job registry that refuses the start falls back inline and says why', () => {
    assert.match(refuseReport, /refused to start the install/u)
  })

  // The cancelled job must also stop *working*: without the flag the settle path ran the whole
  // bounded re-probe after `job_kill` and then appended a verdict nobody asked for.
  cancelMachine.settleAll()
  const afterCancelOutcome = await cancelHooks.done
  check('install job: a cancelled job stops instead of re-probing and reporting', () => {
    assert.match(afterCancelOutcome.result, /cancelled/u)
    assert.match(cancelStub.appended.join('\n'), /cancelled/u, 'the cancellation must reach the job output')
  })

  // A disabled row does not run, so it must not be the row the report names — and with several
  // enabled rows reporting a runtime the report says so instead of implying there is only one pin.
  // (The fixtures used here are live: the earlier ones are removed with their temporary root.)
  const mixedRows = await hintOn([
    executorRow(jobAlias, { id: 'disabled-row', disabled: true }),
    executorRow(jobAlias, { id: 'enabled-row' }),
  ], { [jobAlias]: '7.6.6' })
  check('report: a disabled row is never named as the runtime', () => {
    assert.match(mixedRows.report, /via row enabled-row/u,
      `the enabled row was not named: ${mixedRows.report.slice(0, 400)}`)
    assert.ok(!mixedRows.report.includes('via row disabled-row'),
      'a disabled row was reported as the runtime')
  })

  // Activation no longer installs: the Store-UI path needs a VPN confirmation and a visible
  // Store window, so it stays behind pwsh7_install.
  const sweepMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(sweepMachine.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('activation: no automatic install is started at startup', () => {
    assert.ok(!sweepMachine.spawned.some((executable) => /winget/iu.test(executable)),
      'activation started an automatic install')
  })

  // The bounded grace, asserted where it is observable: an inline install whose winget never finishes
  // must report "still running" rather than waiting forever. The watchdog keeps a regression from
  // hanging the gate — a mutation that removes the grace times out and goes red.
  const pendingMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: false })
  apply(pendingMachine.ctx, {})
  const pendingOutcome = await Promise.race([
    pendingMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined).then((value) => ({ report: value.report })),
    new Promise((resolve) => setTimeout(() => resolve({ timeout: true }), 3000)),
  ])
  check('install: an inline install that outlives its grace reports instead of waiting forever', () => {
    assert.equal(pendingOutcome.timeout, undefined, 'the inline install waited for winget forever')
    assert.match(pendingOutcome.report, /still running/u,
      `the report hid the pending install: ${pendingOutcome.report}`)
  })

  // A `job_kill` *during* the re-probe has to stop it as well: the first fix checked the flag once,
  // after `handle.done`, so the loop kept spawning probes for up to RECHECK_ATTEMPTS × RECHECK_DELAY_MS.
  let lateProbes = 0
  const lateVersions = new Proxy({}, {
    get: (_target, key) => {
      if (key === jobAlias) lateProbes += 1
      return undefined
    },
  })
  const lateMachine = makeContext({ rows: [executorRow(undefined)], versions: lateVersions, deferred: true, jobs: true })
  apply(lateMachine.ctx, {})
  await lateMachine.registered.get('pwsh7_install').execute({ method: 'store', vpnOffConfirmed: true }, undefined)
  const lateStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const lateHooks = lateMachine.jobSpecs[0].run(lateStub)
  const lateDone = lateHooks.done
  lateMachine.settleAll()
  await new Promise((resolve) => setTimeout(resolve, 15))
  const probesAtCancel = lateProbes
  lateHooks.cancel()
  await new Promise((resolve) => setTimeout(resolve, 40))
  await lateDone

  check('install job: a cancel during the re-probe stops the probing', () => {
    assert.equal(lateProbes, probesAtCancel,
      `the re-probe kept going after cancel: ${probesAtCancel} -> ${lateProbes}`)
  })

  process.env.PATH = savedCasePath
  process.env.LOCALAPPDATA = savedCaseLocalAppData
  process.env.LOCALAPPDATA = savedLocalAppData
  if (savedProgramFiles === undefined) delete process.env.ProgramFiles
  else process.env.ProgramFiles = savedProgramFiles
  rmSync(jobRoot, { recursive: true, force: true })
}

// --- The client half's policy copy must not drift (static; no browser needed) -------------

const client = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('client copy: the retired Store policy wording is gone', () => {
  const retired = [
    'Store installs are never accepted',
    'install the stable MSI build',
    'Store 安装不被接受',
    '安装稳定版 MSI',
  ]
  for (const phrase of retired) {
    assert.ok(!client.includes(phrase), `retired wording still in client.js: ${phrase}`)
  }
})
check('client copy: the en dictionary is present and carries no Chinese', () => {
  const en = client.slice(client.indexOf('const DICT_EN'), client.indexOf('const DICT_ZH'))
  assert.ok(en.length > 200, 'the DICT_EN slice looks wrong, so this check would pass vacuously')
  const cjk = en.match(/[\u4e00-\u9fff]/gu)
  assert.equal(cjk, null, `Chinese in the en dictionary: ${cjk === null ? '' : cjk.join('')}`)
})
check('client copy: every t() key is defined in both dictionaries', () => {
  const used = [...client.matchAll(/\bt\('([a-z0-9_]+)'/giu)].map((match) => match[1])
  const dictionaries = ['DICT_EN', 'DICT_ZH'].map((name) => {
    const start = client.indexOf(`const ${name} = {`)
    return { name, body: client.slice(start, client.indexOf('\n    }', start)) }
  })
  assert.ok(used.length > 10, `only ${used.length} t() keys found — the extraction is probably wrong`)
  for (const { name, body } of dictionaries) {
    assert.ok(body.length > 200, `the ${name} slice looks wrong, so this check would pass vacuously`)
    for (const key of new Set(used)) {
      assert.ok(body.includes(`${key}:`), `${key} is used by the card but missing from ${name}`)
    }
  }
})

// --- Verdict -----------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  console.log(`ok — ${machine.registered.size} tools, ${stable.machine.sections.length} prompt section: render, policy and runtime-hint checks pass`)
}


