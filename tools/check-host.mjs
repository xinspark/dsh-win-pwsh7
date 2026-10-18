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
// The inline install graces, so the "still running" paths are reachable without a real wait.
process.env.DSH_WIN_PWSH7_ACTIVATION_GRACE_MS = '50'
process.env.DSH_WIN_PWSH7_INLINE_GRACE_MS = '200'

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
function makeContext({ rows = [], versions = {}, deferred = false, jobs = false } = {}) {
  const registered = new Map()
  const spawned = []
  const terminated = []
  const sections = []
  const orderNames = []
  const jobSpecs = []
  const pending = []
  /** Mutable so a test can make winget exit non-zero, as the Store route does. */
  const state = { wingetExit: 0 }
  const ctx = {
    // Loud on purpose: `apply` catches its own registration failures and warns, so a silent logger
    // here would turn a broken plugin into an empty tool map three checks later.
    logger: { info() {}, warn: (...args) => console.error('[host warn]', ...args) },
    effect(fn) {
      fn()
      return () => {}
    },
    plugin() {},
    get: (key) => {
      if (key === 'configForms') return { get: () => ({}) }
      if (key === 'jobs' && jobs) return jobRegistry
      return undefined
    },
    tools: {
      register(definition) {
        registered.set(definition.name, definition)
        return () => registered.delete(definition.name)
      },
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
        const version = isWinget ? undefined : versions[argv[0]]
        let exitCode = 0
        let stdout = ''
        if (isWinget) {
          exitCode = state.wingetExit
          stdout = 'Started MSStore package execution. ProductId: 9MZ1SNWT0N5D\r\n'
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
  return { ctx, registered, spawned, terminated, sections, orderNames, jobSpecs, state, settleAll: () => { for (const entry of pending.splice(0)) entry.settle() } }
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
  check('install path: the report offers exactly two ways forward, and no other installer', () => {
    assert.match(fallback.report, /Two ways forward/u)
    assert.match(fallback.report, /Install PowerShell 7 from the Microsoft Store/u)
    assert.match(fallback.report, /winget install --id 9MZ1SNWT0N5D --source msstore/u)
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
  const installReport = (await storeMachine.registered.get('pwsh7_install').execute({}, undefined)).report
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
  const startedReport = (await jobMachine.registered.get('pwsh7_install').execute({}, undefined)).report
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
  await jobMachine.registered.get('pwsh7_install').execute({}, undefined)
  const runningStub = { progress: [], updateProgress(line) { this.progress.push(line) }, append() {} }
  jobMachine.jobSpecs[1].run(runningStub)

  check('install: the Store install runs as a background job and the call returns at once', () => {
    assert.match(startedReport, /background as job pwsh7-1/u)
    assert.match(startedReport, /job_output/u)
    assert.ok(!/finished successfully/u.test(startedReport), 'the call must not wait for the install')
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
  check('install job: progress is reported, and a stalled Store run names the metered connection', () => {
    assert.match(jobStub.progress[0], /metered connection/u)
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
  await lyingMachine.registered.get('pwsh7_install').execute({}, undefined)
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

  // And when nothing lands, the verdict must say so — and name the real cause: the measured run
  // was gated by a metered connection, not by a broken Store — and offer the second path too.
  const storeRouteMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  storeRouteMachine.state.wingetExit = 1
  apply(storeRouteMachine.ctx, {})
  await storeRouteMachine.registered.get('pwsh7_install').execute({}, undefined)
  const storeSpec = storeRouteMachine.jobSpecs[0]
  const storeStub = { progress: [], appended: [], updateProgress(line) { this.progress.push(line) }, append(text) { this.appended.push(text) } }
  const realNow2 = Date.now
  Date.now = () => realNow2() + 11 * 60 * 1000
  const storeHooks = storeSpec.run(storeStub)
  Date.now = realNow2
  storeRouteMachine.settleAll()
  const storeOutcome = await storeHooks.done

  check('install job: a failed install explains the metered connection and names the second path', () => {
    assert.equal(storeOutcome.status, 'failed')
    assert.match(storeOutcome.result, /metered/u)
    assert.match(storeOutcome.result, /Metered connection/u)
    assert.match(storeOutcome.result, /disable this plugin/u)
  })

  // The one probe that turns "the Store just sits there" into a named cause. The stub answers the
  // Windows PowerShell 5.1 probe with a metered reading, so the report has to carry the warning.
  const fiftyOne = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const meteredMachine = makeContext({
    rows: [executorRow(undefined)],
    versions: { [fiftyOne]: 'Fixed|FixtureNet-5G' },
    deferred: true,
    jobs: true,
  })
  apply(meteredMachine.ctx, {})
  const meteredReport = (await meteredMachine.registered.get('pwsh7_install').execute({}, undefined)).report
  const clearMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(clearMachine.ctx, {})
  const clearReport = (await clearMachine.registered.get('pwsh7_install').execute({}, undefined)).report
  // The status report carries the same warning, but only when there is nothing to run: that is the
  // state a fresh session lands in after the runtime is uninstalled. The negative case is proved by
  // the spawn log rather than by wording: with a usable runtime the probe must not run at all, even
  // when the connection really is metered.
  const meteredStatus = (await meteredMachine.registered.get('pwsh7_status').execute({}, undefined)).report
  jobVersions[jobAlias] = '7.6.6'
  jobVersions[fiftyOne] = 'Fixed|FixtureNet-5G'
  const probesBefore = jobMachine.spawned.filter((executable) => /powershell\.exe$/iu.test(executable)).length
  const healthyStatus = (await jobMachine.registered.get('pwsh7_status').execute({}, undefined)).report
  const probesAfter = jobMachine.spawned.filter((executable) => /powershell\.exe$/iu.test(executable)).length

  check('install: a metered connection is named before the Store route starts, and no other installer is offered', () => {
    assert.match(meteredReport, /marked as metered/u)
    assert.match(meteredReport, /FixtureNet-5G/u)
    assert.match(meteredReport, /Metered connection/u, 'the remedy must name the setting to turn off')
    assert.ok(!/route "winget"/u.test(meteredReport),
      'a metered connection is answered by the connection setting, never by another installer')
    assert.ok(!/msi/iu.test(meteredReport), 'no second installer may be offered as the answer to a metered connection')
    assert.ok(!/marked as metered/u.test(clearReport), 'an unreadable cost must produce no warning')
  })
  check('status: the warning appears only while nothing is usable', () => {
    assert.match(meteredStatus, /marked as metered/u)
    assert.match(meteredStatus, /PowerShell 7: not usable/u)
    assert.match(healthyStatus, /PowerShell 7\.6\.6/u, `healthy report: ${healthyStatus.slice(0, 240)}`)
    assert.ok(!/marked as metered/u.test(healthyStatus), `a healthy machine must not be warned: ${healthyStatus.slice(0, 240)}`)
    assert.equal(probesAfter, probesBefore, 'the connection probe must not run while a runtime is usable')
  })

  // Progress has to come from winget's own log: with a captured stdout, winget draws no progress
  // bar and one measured run spent 4m15s inside a single silent staging phase.
  const logDir = join(jobAliasRoot, 'Packages', 'Microsoft.DesktopAppInstaller_8wekyb3d8bbwe', 'LocalState', 'DiagOutputDir')
  mkdirSync(logDir, { recursive: true })
  const logFile = join(logDir, 'WinGet-fixture.log')
  writeFileSync(logFile, '2026-10-13 23:44:30.385 <I> [CLI ] Installer hash verified\n')
  const logMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(logMachine.ctx, {})
  await logMachine.registered.get('pwsh7_install').execute({}, undefined)
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
  await downloadMachine.registered.get('pwsh7_install').execute({}, undefined)
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
  await cancelMachine.registered.get('pwsh7_install').execute({}, undefined)
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
  const inlineReport = (await inlineMachine.registered.get('pwsh7_install').execute({}, undefined)).report
  const refuseMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, jobs: 'refuse' })
  apply(refuseMachine.ctx, {})
  const refuseReport = (await refuseMachine.registered.get('pwsh7_install').execute({}, undefined)).report

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

  // `apply` does not await the sweep (`void activationSweep(...).then(...)`), so activation was never
  // blocked by an install — the review's premise on that point was wrong, and this case records the
  // real contract. What *was* wrong: the sweep awaited winget forever, so the install's outcome was
  // silently lost. It now gives up after a grace and reports.
  const sweepMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: true })
  apply(sweepMachine.ctx, { installIfMissing: true })
  await new Promise((resolve) => setTimeout(resolve, 60))
  check('activation: installIfMissing starts the install without holding apply', () => {
    assert.ok(sweepMachine.spawned.some((executable) => /winget/iu.test(executable)),
      'the install never started')
  })

  // The bounded grace, asserted where it is observable: an inline install whose winget never finishes
  // must report "still running" rather than waiting forever. The watchdog keeps a regression from
  // hanging the gate — a mutation that removes the grace times out and goes red.
  const pendingMachine = makeContext({ rows: [executorRow(undefined)], versions: {}, deferred: true, jobs: false })
  apply(pendingMachine.ctx, {})
  const pendingOutcome = await Promise.race([
    pendingMachine.registered.get('pwsh7_install').execute({}, undefined).then((value) => ({ report: value.report })),
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
  await lateMachine.registered.get('pwsh7_install').execute({}, undefined)
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
