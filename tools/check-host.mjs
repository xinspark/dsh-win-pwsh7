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
 * Nothing real is executed: the stub `subprocess` answers version probes and Store-UI clicks
 * from a table; the install checks run the job body against that stub, never Microsoft Store.
 */
import { register } from 'node:module'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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

// The install re-probes for a bounded while after the Store click. The interval is read when the
// host half loads, so it is set before the import to let the gate run those ticks instantly.
// Small but non-zero: the re-probe must be slow enough to keep the bounded loop honest.
process.env.DSH_WIN_PWSH7_RECHECK_MS = '5'
process.env.DSH_WIN_PWSH7_TICK_MS = '5'
// Every pwsh pre-execute refreshes the gate in this gate, so the mutable-reading case is fast.
process.env.DSH_WIN_PWSH7_GATE_TTL_MS = '0'

// The host machine may have a real Store PowerShell 7 installed, and the requirement is that the
// gate is reproducible on such a machine too. Point the probe's well-known locations at an empty
// fixture before the host half loads: every candidate the tests exercise must come from the stub
// table, never from the author's machine.
const gateHome = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-gate-home-'))
mkdirSync(join(gateHome, 'bin'), { recursive: true })
process.env.LOCALAPPDATA = gateHome
process.env.PATH = join(gateHome, 'bin')

const { apply } = await import('../index.js')
const { bridgeDenyNames, toolNameFacts } = await import('../lib/dsh-ops-bridge.js')

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
 * spawns nothing. `jobs: false` omits the job registry.
 */
function makeContext({ rows = [], versions = {}, jobs = false, shellPath, shellObject, pluginManager, agents, visible } = {}) {
  const registered = new Map()
  const sections = []
  const orderNames = []
  const jobSpecs = []
  const guards = []
  const listeners = new Map()
  const state = {
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
      if (key === 'pluginManager') return pluginManager
      if (key === 'agents') return agents
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
      restrict() { return () => {} },
      view() {
        return { visible: new Map((visible ?? []).map((name) => [name, {}])) }
      },
      schemas() {
        return (visible ?? []).map((name) => ({ name }))
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
        const encodedIndex = argv.indexOf('-EncodedCommand')
        const encoded = encodedIndex >= 0 ? argv[encodedIndex + 1] ?? '' : ''
        const decoded = encoded === '' ? '' : Buffer.from(encoded, 'base64').toString('utf16le')
        const isStoreUi = argv.includes('-File') || decoded.includes('STORE_UI') || decoded.includes('ms-windows-store://')
        const version = versions[argv[0]]
        let exitCode = 0
        let stdout = ''
        if (isStoreUi) {
          exitCode = state.storeUiExit
          stdout = state.storeUiStdout
        } else if (version === undefined) {
          exitCode = 1
        } else {
          stdout = `${version}\r\n`
        }
        return {
          collected: {
            stdout: { readFrom: () => ({ text: stdout, nextOffset: 8, lossy: false }) },
            stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) },
          },
          done: Promise.resolve({ exitCode }),
          terminate() {},
        }

      },
    },
  }
  const jobRegistry = {
    start(spec) {
      jobSpecs.push(spec)
      return `pwsh7-${jobSpecs.length}`
    },
  }
  return { ctx, registered, sections, orderNames, jobSpecs, state, guards, listeners }
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

const overrideReport = (await machine.registered.get('pwsh7_status').execute({}, undefined)).report
check('config guidance: overridePath is explicitly not executor wiring', () => {
  assert.match(overrideReport, /overridePath is only what this plugin probes/u)
  assert.match(overrideReport, /pwshPath: 'C:\\Windows\\System32\\cmd\.exe'/u)
})
check('status: a healthy runtime does not advertise the companion', () => {
  assert.ok(!/dsh-ops/u.test(overrideReport), 'the status report must not recommend a plugin outside install completion')
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
  process.env.PATH = savedPath
  process.env.LOCALAPPDATA = savedLocalAppData
  rmSync(storeRoot, { recursive: true, force: true })

  check('auto-probe: a version-numbered Store path resolves to the pinnable family alias', () => {
    assert.match(preferReport, /Store family alias/u)
    assert.ok(!/version-numbered Store path/u.test(preferReport),
      `the version-numbered path must not be the reported candidate:\n${preferReport}`)
  })

  // --- the Store UI install ----------------------------------------------------------------
  const confirmMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: true })
  apply(confirmMachine.ctx, {})
  const confirmReport = (await confirmMachine.registered.get('pwsh7_install').execute({}, undefined)).report
  check('install: a missing VPN confirmation asks the user and starts nothing', () => {
    assert.equal(confirmMachine.jobSpecs.length, 0)
    assert.match(confirmReport, /VPN/u)
    assert.match(confirmReport, /vpnOffConfirmed: true/u)
    assert.match(confirmReport, /Store window will open/u)
  })

  const uiMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: true })
  apply(uiMachine.ctx, {})
  const uiReport = (await uiMachine.registered.get('pwsh7_install').execute({ vpnOffConfirmed: true }, undefined)).report
  const uiSpec = uiMachine.jobSpecs[0]
  const uiStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const uiHooks = uiSpec.run(uiStub)
  const uiOutcome = await uiHooks.done
  check('install: the Store page opens and clicks Install in a job', () => {
    assert.match(uiReport, /Opening Microsoft Store and clicking Install/u)
    assert.equal(uiMachine.jobSpecs.length, 1)
    assert.match(uiStub.progress[0], /opening the Microsoft Store page/u)
    assert.match(uiOutcome.result, /Store page opened and Install was clicked/u)
  })
  check('install job: kind, label, both output streams, and a runnable body', () => {
    assert.equal(uiSpec.kind, 'pwsh7')
    assert.match(uiSpec.label, /Microsoft Store UI/u)
    assert.equal(uiSpec.output.length, 2)
    assert.equal(typeof uiSpec.run, 'function')
  })

  const uiFailMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: true })
  uiFailMachine.state.storeUiExit = 2
  uiFailMachine.state.storeUiStdout = 'STORE_UI_NOT_FOUND\\r\\n'
  apply(uiFailMachine.ctx, {})
  await uiFailMachine.registered.get('pwsh7_install').execute({ vpnOffConfirmed: true }, undefined)
  const uiFailHooks = uiFailMachine.jobSpecs[0].run({ progress: [], appended: [], updateProgress() {}, append() {} })
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
    await uiFailMachine.registered.get('pwsh7_install').execute({ vpnOffConfirmed: true }, undefined)
    const hooks = uiFailMachine.jobSpecs[attempt].run({ progress: [], appended: [], updateProgress() {}, append() {} })
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

  // A disabled row does not run, so it must not be the row the report names — and with several
  // enabled rows reporting a runtime the report says so instead of implying there is only one pin.
  const rowRoot = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-row-'))
  const rowAlias = join(rowRoot, 'WindowsApps', 'Microsoft.PowerShell_8wekyb3d8bbwe', 'pwsh.exe')
  mkdirSync(dirname(rowAlias), { recursive: true })
  copyFileSync(process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe', rowAlias)
  const mixedRows = await hintOn([
    executorRow(rowAlias, { id: 'disabled-row', disabled: true }),
    executorRow(rowAlias, { id: 'enabled-row' }),
  ], { [rowAlias]: '7.6.6' })
  check('report: a disabled row is never named as the runtime', () => {
    assert.match(mixedRows.report, /via row enabled-row/u,
      `the enabled row was not named: ${mixedRows.report.slice(0, 400)}`)
    assert.ok(!mixedRows.report.includes('via row disabled-row'),
      'a disabled row was reported as the runtime')
  })
  rmSync(rowRoot, { recursive: true, force: true })

  // Activation no longer installs: the Store-UI path needs a VPN confirmation and a visible
  // Store window, so it stays behind pwsh7_install.
  const sweepMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: true })
  apply(sweepMachine.ctx, {})
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('activation: no automatic install is started at startup', () => {
    assert.equal(sweepMachine.jobSpecs.length, 0, 'activation started an automatic install')
  })

  process.env.PATH = savedPath
  process.env.LOCALAPPDATA = savedLocalAppData
  if (savedProgramFiles === undefined) delete process.env.ProgramFiles
  else process.env.ProgramFiles = savedProgramFiles
}

// --- dsh-ops compatibility patch ---------------------------------------------------------
const compatDir = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-compat-'))
const compatPatchPath = join(compatDir, 'cordis.patch.yml')
writeFileSync(compatPatchPath, '# dsh-win-pwsh7: dsh-ops compatibility (managed)\n- id: dsh-ops-compat\n  disabled: false\n- id: keep-me\n  name: keep-me\n', 'utf8')
const savedProfileDir = process.env.DSH_PROFILE_DIR
process.env.DSH_PROFILE_DIR = compatDir
const compatMachine = makeContext({
  pluginManager: {
    async listBundles() {
      return [{ name: 'dsh-ops', installed: true, rows: [{ moduleName: 'dsh-ops/compat' }] }]
    },
  },
})
apply(compatMachine.ctx, {})
await new Promise((resolve) => setTimeout(resolve, 50))
const compatWritten = readFileSync(compatPatchPath, 'utf8')
check('the enabled path delegates to the bundle and removes a legacy managed override', () => {
  assert.ok(!compatWritten.includes('dsh-win-pwsh7: dsh-ops compatibility'), 'a managed block survived')
  assert.ok(!compatWritten.includes('- id: dsh-ops-compat'), 'the bundle-owned override was written into the profile')
  assert.match(compatWritten, /- id: keep-me/u, 'the user patch entry was lost')
})
apply(compatMachine.ctx, { dshOpsCompat: false })
await new Promise((resolve) => setTimeout(resolve, 50))
const compatDisabled = readFileSync(compatPatchPath, 'utf8')
check('turning coexistence off writes only the managed disable override', () => {
  assert.match(compatDisabled, /dsh-win-pwsh7: dsh-ops compatibility disabled \(managed\)/u)
  assert.match(compatDisabled, /- id: dsh-ops-compat\n  disabled: true/u)
  assert.ok(!compatDisabled.includes('dsh-win-pwsh7: dsh-ops compatibility (managed)'), 'the enable marker survived')
  assert.ok(compatDisabled.includes('- id: keep-me'), 'the user patch entry was removed')
})
apply(compatMachine.ctx, { dshOpsCompat: true })
await new Promise((resolve) => setTimeout(resolve, 50))
const compatReenabled = readFileSync(compatPatchPath, 'utf8')
check('turning coexistence back on removes the disable override for the bundle', () => {
  assert.ok(!compatReenabled.includes('dsh-win-pwsh7: dsh-ops compatibility'), 'a managed block survived')
  assert.ok(!compatReenabled.includes('- id: dsh-ops-compat'), 'the bundle-owned override was written into the profile')
  assert.ok(compatReenabled.includes('- id: keep-me'), 'the user patch entry was removed')
})
if (savedProfileDir === undefined) delete process.env.DSH_PROFILE_DIR
else process.env.DSH_PROFILE_DIR = savedProfileDir
rmSync(compatDir, { recursive: true, force: true })

check('the bundle patch owns the enabled compatibility override', () => {
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.match(patch, /^- id: dsh-ops-compat\n  name: dsh-ops\/compat\n  disabled: false$/mu)
})

const orderDir = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-order-'))
writeFileSync(join(orderDir, 'package.json'), JSON.stringify({
  dsh: { profile: { bundles: ['dsh-win-pwsh7', 'dsh-ops'] } },
}), 'utf8')
writeFileSync(join(orderDir, 'cordis.patch.yml'), '- id: keep-me\n  name: keep-me\n', 'utf8')
const savedOrderDir = process.env.DSH_PROFILE_DIR
process.env.DSH_PROFILE_DIR = orderDir
const orderMachine = makeContext({
  pluginManager: {
    async listBundles() {
      return [{ name: 'dsh-ops', installed: true, rows: [{ moduleName: 'dsh-ops/compat' }] }]
    },
  },
})
apply(orderMachine.ctx, {})
await new Promise((resolve) => setTimeout(resolve, 50))
const orderPatch = readFileSync(join(orderDir, 'cordis.patch.yml'), 'utf8')
check('a reversed bundle order keeps the profile fallback instead of silently disabling compatibility', () => {
  assert.match(orderPatch, /dsh-win-pwsh7: dsh-ops compatibility \(managed\)/u)
  assert.match(orderPatch, /- id: dsh-ops-compat\n  disabled: false/u)
  assert.ok(orderPatch.includes('- id: keep-me'))
})
if (savedOrderDir === undefined) delete process.env.DSH_PROFILE_DIR
else process.env.DSH_PROFILE_DIR = savedOrderDir
rmSync(orderDir, { recursive: true, force: true })

// --- agent bridge hides only the duplicate tools ------------------------------------------
const bridgeDenies = []
const bridgeAgent = {
  ctx: {
    tools: {
      restrict({ deny }) {
        bridgeDenies.push(deny)
        return () => {}
      },
    },
  },
}
const bridgeMachine = makeContext({
  agents: { list: () => [bridgeAgent] },
  visible: [
    'read', 'ops_inspect_local_file',
    'glob', 'ops_glob',
    'grep', 'ops_grep',
    'bash', 'pwsh', 'pwsh_persistent', 'ops_bash',
  ],
})
apply(bridgeMachine.ctx, {})
check('dsh-ops bridge hides duplicate official tools but keeps pwsh', () => {
  const deny = bridgeDenies.at(-1) ?? []
  for (const name of ['read', 'glob', 'grep', 'bash', 'pwsh_persistent']) {
    assert.ok(deny.includes(name), `bridge did not hide ${name}: ${deny.join(', ')}`)
  }
  assert.ok(!deny.includes('pwsh'), 'bridge hid the native pwsh tool')
  assert.ok(!deny.includes('ops_bash'), 'bridge hid ops_bash')
})

const bridgeNames = new Set([
  'read', 'ops_inspect_local_file',
  'glob', 'ops_glob',
  'grep', 'ops_grep',
  'bash', 'pwsh', 'pwsh_persistent', 'ops_bash',
])
const bridgeRestrictable = new Set([...bridgeNames].filter((name) => name !== 'ops_bash'))
const bridgeTools = {
  view() {
    return { knownNames: bridgeNames, restrictableNames: bridgeRestrictable }
  },
}
check('the bridge plans from pre-restriction names, so hiding cannot flip it', () => {
  const first = bridgeDenyNames(toolNameFacts(bridgeTools, {}, []))
  assert.deepEqual(first, ['read', 'glob', 'grep', 'bash', 'pwsh_persistent'])
  // `visible` is now post-restriction; knownNames is unchanged, as the host's view guarantees.
  const second = bridgeDenyNames(toolNameFacts(bridgeTools, {}, first))
  assert.deepEqual(second, first)
})

check('the fallback view latches the names already hidden instead of oscillating', () => {
  const visible = new Set(bridgeNames)
  const fallbackTools = {
    view() {
      return { visible: new Map([...visible].map((name) => [name, {}])) }
    },
  }
  const first = bridgeDenyNames(toolNameFacts(fallbackTools, {}, []))
  for (const name of first) visible.delete(name)
  const second = bridgeDenyNames(toolNameFacts(fallbackTools, {}, first))
  assert.deepEqual(second, first)
})

check('a scope-local name cannot make the whole restriction plan throw', () => {
  const facts = toolNameFacts(bridgeTools, {}, [])
  const deny = bridgeDenyNames({ ...facts, restrictable: new Set([...bridgeRestrictable].filter((name) => name !== 'glob')) })
  assert.ok(!deny.includes('glob'), 'a non-restrictable name survived the filter')
  assert.ok(!deny.includes('ops_bash'), 'a scope-local counterpart was put in the deny list')
})

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

