/**
 * Native-contract gate for dsh-win-pwsh7 — run it with `node tools/check-native-contracts.mjs`.
 *
 * The plugin depends on facts that are not part of any published seam: `PwshLocalExecutor`'s
 * `pwshPath` getter, the guard denial shape inside `ToolRuntime`, and the profile-editor rule that
 * only `include` rows are addressable. The shared-library experience entry `exp-native-first` says
 * those facts must be checked against the installed distribution, not remembered — a renamed export
 * or a changed getter otherwise shows up as a runtime symptom far from the cause.
 *
 * This gate therefore imports the installed packages and asserts the exact symbols, prototypes and
 * source-level contracts the plugin relies on. It is deliberately coupled to the running build:
 * line numbers move, so the assertions name symbols and behaviors, and
 * `docs/reference/native-contracts.md` records the build they were taken from.
 *
 * `DSH_APP_DIR` is resolved exactly like the Host gate (install root, `resources/app`, or
 * `resources/app.asar`). A machine with no installation fails with one actionable line instead of a
 * bare `Cannot find package`.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { register } from 'node:module'
import { resolveAppModulesDir } from './dsh-app-modules.mjs'

const PACKAGES = [
  'dsh-tools',
  'dsh-pwsh-sandbox',
  'dsh-tool-pwsh',
  'dsh-pwsh-local',
  'dsh-shell',
  'dsh-jobs',
  'dsh-jobs-local',
  'dsh-config-editor',
  'dsh-system-prompt',
  'dsh-subprocess',
  'dsh-agent',
  'dsh-scope',
]

const appModules = resolveAppModulesDir()
if (appModules === undefined) {
  console.error('note — no DSH installation found: set DSH_APP_DIR to the install root, resources/app, or resources/app.asar')
  process.exit(1)
}
if (appModules.includes('dsh-app-modules-')) {
  console.log(`note — the harness packages come from an asar archive, unpacked for this run into ${appModules}`)
}
process.env.DSH_APP_DIR = appModules
register('./node-app-modules-hook.mjs', import.meta.url)

/** Resolve one installed package directory. */
function packageDir(name) {
  return join(appModules, 'node_modules', '@deepseek-ai', name)
}

/** Read an installed package's manifest. */
function manifest(name) {
  return JSON.parse(readFileSync(join(packageDir(name), 'package.json'), 'utf8'))
}

/** Read the implementation file the contract is taken from. */
function source(name) {
  const candidates = ['lib/types/index.js', 'lib/index.js']
  for (const relative of candidates) {
    try {
      return readFileSync(join(packageDir(name), relative), 'utf8')
    } catch {
      /* try the next shape */
    }
  }
  throw new Error(`${name}: neither lib/types/index.js nor lib/index.js exists`)
}

/**
 * Read one named file of an installed package, or '' when the build does not have it.
 *
 * A contract can move between files without being lost: 0.2.2 moved the tool pipeline out of
 * `lib/index.js` into `lib/pipeline.js`. Reading a fixed list and joining what exists keeps the
 * assertion on the behavior when the file split changes, instead of on a remembered path.
 */
function trySource(name, relative) {
  try {
    return readFileSync(join(packageDir(name), relative), 'utf8')
  } catch {
    return ''
  }
}

/** The tool pipeline: one file up to 0.2.1, split into `lib/pipeline.js` from 0.2.2. */
function pipeline() {
  return ['lib/index.js', 'lib/pipeline.js'].map((relative) => trySource('dsh-tools', relative)).join('\n')
}

/** The single file that hosts the pre-execute waterfall in this build. */
function pipelineFile() {
  const split = trySource('dsh-tools', 'lib/pipeline.js')
  return split === '' ? trySource('dsh-tools', 'lib/index.js') : split
}

let checks = 0
/** One assertion with a stable label for the summary. */
function check(label, assertion) {
  assertion()
  checks += 1
  console.log(`  ok ${label}`)
}

/**
 * The gate body. Everything official is imported dynamically after the loader hook is registered;
 * static imports would be hoisted above `register()` and resolve before the installation is known.
 */
async function run() {
  // ---- package coherence -------------------------------------------------
  const versions = PACKAGES.map((name) => [name, manifest(name).version])
  const version = versions[0][1]
  check('all depended-on packages come from one DSH build', () => {
    const mismatched = versions.filter(([, value]) => value !== version)
    assert.deepEqual(mismatched, [], `mixed DSH package versions: ${mismatched.map(([name, value]) => `${name}@${value}`).join(', ')}`)
  })
  for (const name of PACKAGES) {
    check(`${name} ships a real entry point`, () => {
      assert.ok(source(name).length > 0)
    })
  }

  const tools = await import('@deepseek-ai/dsh-tools')
  const pwshLocal = await import('@deepseek-ai/dsh-pwsh-local')
  const shell = await import('@deepseek-ai/dsh-shell')
  const sandbox = await import('@deepseek-ai/dsh-pwsh-sandbox')
  const systemPrompt = await import('@deepseek-ai/dsh-system-prompt')
  const jobs = await import('@deepseek-ai/dsh-jobs-local')
  const configEditor = await import('@deepseek-ai/dsh-config-editor')
  const toolPwsh = await import('@deepseek-ai/dsh-tool-pwsh')

  // ---- tool registry: guard is global, monotonic, and lands as an error --
  check('defineTool is exported', () => assert.equal(typeof tools.defineTool, 'function'))
  for (const method of ['guard', 'restrict', 'execute']) {
    check(`ToolRuntime.${method} exists`, () => assert.equal(typeof tools.ToolRuntime.prototype[method], 'function'))
  }
  // 0.2.1 read guards in `guardReason`; 0.2.2 renamed it `checkGuards` and moved the one who
  // materializes the denial into `lib/pipeline.js`. The plugin only needs "guards are still read
  // once, after pre-execute, and the reason reaches the model" — not a particular private name.
  const GUARD_READERS = ['checkGuards', 'guardReason']
  const guardReader = GUARD_READERS.find((name) => typeof tools.ToolRuntime.prototype[name] === 'function')
  check('ToolRuntime reads its guards through one method', () => {
    assert.ok(
      guardReader !== undefined,
      `neither ${GUARD_READERS.join(' nor ')} exists — the gate cannot tell whether guards still deny`,
    )
  })
  check('a guard denial is materialized as `Error: <reason>`', () => {
    assert.match(pipeline(), /Error: \$\{denialReason\}/u)
    assert.ok(pipeline().includes(`.${guardReader}(`), `the denial pipeline never calls ${guardReader}`)
  })
  check('guards are read after the pre-execute waterfall', () => {
    const text = pipelineFile()
    const waterfall = text.search(/tools\/pre-execute/u)
    const read = text.search(new RegExp(`${guardReader}\\(`, 'u'))
    assert.ok(waterfall >= 0, 'the pre-execute waterfall is gone; the gate cannot be refreshed before a pwsh call')
    assert.ok(read > waterfall, 'guards run before the pre-execute waterfall, so a stale reading would decide the call')
  })
  check('restrict refuses a plain-context caller', () => {
    assert.match(source('dsh-tools'), /tools\.restrict\(\) requires a scoped context/u)
  })

  // ---- pwsh executor: the exact executable path is readable -------------
  check('PwshLocalExecutor extends ShellExecutor', () => {
    assert.equal(Object.getPrototypeOf(pwshLocal.PwshLocalExecutor.prototype), shell.ShellExecutor.prototype)
  })
  check('SandboxPwshExecutor extends PwshLocalExecutor', () => {
    assert.equal(Object.getPrototypeOf(sandbox.SandboxPwshExecutor.prototype), pwshLocal.PwshLocalExecutor.prototype)
  })
  check('PwshLocalExecutor.pwshPath is a getter', () => {
    const descriptor = Object.getOwnPropertyDescriptor(pwshLocal.PwshLocalExecutor.prototype, 'pwshPath')
    assert.equal(typeof descriptor?.get, 'function', 'pwshPath getter disappeared — the gate source must fall back to shell.config.pwshPath.get() + resolvePwshPath()')
  })
  check('PwshLocalExecutor keeps the declared/resolved path cache the refresh nudges', () => {
    const text = source('dsh-pwsh-local')
    assert.match(text, /declaredPwshPath/u)
    assert.match(text, /resolvedPwshPath/u)
  })
  check('PwshLocalExecutor.argv exists', () => assert.equal(typeof pwshLocal.PwshLocalExecutor.prototype.argv, 'function'))
  // The transitional UTF-8 console bridge is removable when upstream pins the console code page
  // itself. This check is deliberately red on that fix: red is the signal to follow the README
  // removal contract, not to relax the assertion.
  check('dsh-pwsh-local pins only .NET output encoding, not the console code page', () => {
    const preamble = pwshLocal.ENCODING_PREAMBLE
    assert.equal(typeof preamble, 'string', 'ENCODING_PREAMBLE disappeared; re-read the encoding contract')
    assert.ok(
      !/chcp(?:\.com)?\s+65001|SetConsoleOutputCP/iu.test(preamble),
      'upstream now pins the console code page: remove lib/utf8-console-bridge.js per the README removal contract',
    )
  })

  // ---- resolver: a configured path is trusted as-is ----------------------
  check('resolvePwshPath trusts an explicit configured path', () => {
    assert.equal(pwshLocal.resolvePwshPath('C:\\custom\\pwsh.exe', {}, 'win32'), 'C:\\custom\\pwsh.exe')
  })
  check('candidate order is Program Files, PATH, then Windows PowerShell 5.1', () => {
    assert.deepEqual(
      pwshLocal.candidatePwshPaths({ ProgramFiles: 'C:\\PF', SystemRoot: 'C:\\Win', PATH: 'C:\\A;C:\\B' }),
      [
        'C:\\PF\\PowerShell\\7\\pwsh.exe',
        'C:\\A\\pwsh.exe',
        'C:\\B\\pwsh.exe',
        'C:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ],
    )
  })
  check('resolvePwshPath falls back to Windows PowerShell 5.1 when no pwsh exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-win-pwsh7-contracts-'))
    try {
      const programFiles = join(root, 'PF')
      const systemRoot = join(root, 'Win')
      const modern = join(programFiles, 'PowerShell', '7', 'pwsh.exe')
      const legacy = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
      mkdirSync(join(programFiles, 'PowerShell', '7'), { recursive: true })
      mkdirSync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0'), { recursive: true })
      writeFileSync(legacy, '')
      const env = { ProgramFiles: programFiles, SystemRoot: systemRoot, PATH: '' }
      assert.equal(pwshLocal.resolvePwshPath(undefined, env, 'win32'), legacy)
      writeFileSync(modern, '')
      assert.equal(pwshLocal.resolvePwshPath(undefined, env, 'win32'), modern)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  // ---- system prompt: the pwsh section has a stable placement -----------
  check('SystemPrompt.getSectionOrder exists', () => assert.equal(typeof systemPrompt.SystemPrompt.prototype.getSectionOrder, 'function'))
  check('TOOL_PWSH is placed at 1010', () => assert.match(source('dsh-system-prompt'), /TOOL_PWSH: 1010/u))

  // ---- jobs: the install job spec can append and update progress --------
  check('LocalJobRegistry.start exists', () => assert.equal(typeof jobs.LocalJobRegistry.prototype.start, 'function'))
  check('the job handle exposes append and updateProgress', () => {
    const text = source('dsh-jobs-local')
    assert.match(text, /updateProgress: \(line\)/u)
    assert.match(text, /append: \(text, options\)/u)
  })

  // ---- config editor: only include rows are addressable -----------------
  check('ConfigEditor.entries and edit exist', () => {
    assert.equal(typeof configEditor.ConfigEditor.prototype.entries, 'function')
    assert.equal(typeof configEditor.ConfigEditor.prototype.edit, 'function')
  })
  check('entries() is limited to include-owned rows', () => {
    assert.match(source('dsh-config-editor'), /fiber\.entry\?\.id === "include"/u)
  })

  // ---- the pwsh tool: name and executor seam ----------------------------
  check('tool-pwsh exports the expected plugin metadata', () => {
    assert.equal(toolPwsh.name, 'tool-pwsh')
    assert.ok(toolPwsh.inject.includes('tools'))
    assert.ok(toolPwsh.inject.includes('shell'))
    assert.ok(toolPwsh.inject.includes('systemPrompt'))
  })
  check('the tool is named pwsh and runs through ctx.shell', () => {
    const text = source('dsh-tool-pwsh')
    assert.match(text, /name: "pwsh"/u)
    assert.match(text, /ctx\.shell\.(resolve|execute)/u)
  })

  console.log(`ok — native contracts: ${checks} checks on DSH ${version} (${PACKAGES.length} packages coherent)`)
}

try {
  await run()
} catch (error) {
  console.error(`not ok — ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
