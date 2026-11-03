/**
 * Gate for the transitional Windows UTF-8 console bridge.
 *
 * The bridge wraps the Host's `ctx.shell.execute`; this suite drives it with a fake
 * executor so the prefix, the opt-out, the fail-open paths and the restore are
 * verifiable without a DSH installation.
 */
import assert from 'node:assert/strict'
import { mountUtf8ConsoleBridge, utf8Command } from '../lib/utf8-console-bridge.js'

let failures = 0
function check(label, assertion) {
  try {
    assertion()
  } catch (error) {
    failures += 1
    console.error(`FAIL — ${label}: ${error.message}`)
  }
}

function fakeContext(shell, options = {}) {
  const effects = []
  const warnings = []
  const injected = []
  const scoped = {
    get: () => shell,
    effect(fn) { effects.push(fn()) },
  }
  const ctx = {
    logger: { warn: (message) => warnings.push(message) },
    inject(deps, callback) {
      injected.push(deps)
      callback(scoped)
    },
  }
  return { ctx, effects, warnings, injected }
}

function fakeShell() {
  const calls = []
  const shell = {
    execute(spec) {
      calls.push({ spec, self: this })
      return spec
    },
  }
  return { shell, calls }
}

// --- The pure command transform -----------------------------------------------------------

check('prefixes a bare command once', () => {
  assert.equal(utf8Command('Get-Location'), 'chcp.com 65001 > $null; Get-Location')
})
check('leaves an already-pinned command alone', () => {
  for (const command of [
    'chcp 65001 > $null; Get-Location',
    'chcp.com 65001 > $null; Get-Location',
    '  chcp.com 65001 >$null; Get-Location',
  ]) {
    assert.equal(utf8Command(command), command)
  }
})
check('leaves non-strings and empty strings alone', () => {
  for (const value of [undefined, null, 42, '']) assert.equal(utf8Command(value), value)
})

// --- The executor wrapper ----------------------------------------------------------------

check('wraps the shell executor and prefixes the command', () => {
  const { shell, calls } = fakeShell()
  const { ctx } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  const spec = { command: 'pwsh -NoProfile -File enc_test.ps1', cwd: 'C:\\work', timeoutMs: 1000 }
  shell.execute(spec)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].spec.command, 'chcp.com 65001 > $null; pwsh -NoProfile -File enc_test.ps1')
  assert.equal(calls[0].spec.cwd, 'C:\\work')
  assert.equal(calls[0].spec.timeoutMs, 1000)
  assert.equal(calls[0].self, shell)
})
check('passes through when the config field is off', () => {
  const { shell, calls } = fakeShell()
  const { ctx } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: false }), 'win32')
  shell.execute({ command: 'Get-Location' })
  assert.equal(calls[0].spec.command, 'Get-Location')
})
check('does not double-prefix a command that already selects UTF-8', () => {
  const { shell, calls } = fakeShell()
  const { ctx } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  shell.execute({ command: 'chcp.com 65001 > $null; Get-Location' })
  assert.equal(calls[0].spec.command, 'chcp.com 65001 > $null; Get-Location')
})
check('is idempotent when mounted twice on the same executor', () => {
  const { shell } = fakeShell()
  const { ctx } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  const once = shell.execute
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  assert.equal(shell.execute, once)
})
check('restores the original executor when the fiber disposes', () => {
  const { shell, calls } = fakeShell()
  const original = shell.execute
  const { ctx, effects } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  assert.notEqual(shell.execute, original)
  effects.forEach((dispose) => dispose())
  assert.equal(shell.execute, original)
  shell.execute({ command: 'Get-Location' })
  assert.equal(calls.at(-1).spec.command, 'Get-Location')
})

// --- Fail-open paths ---------------------------------------------------------------------

check('does nothing on non-Windows', () => {
  const { shell } = fakeShell()
  const { ctx, injected } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'linux')
  assert.deepEqual(injected, [])
})
check('warns and leaves a service without execute untouched', () => {
  const { ctx, warnings } = fakeContext({})
  mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /no execute/u)
})
check('warns instead of throwing on a frozen executor', () => {
  const shell = Object.freeze({ execute(spec) { return spec } })
  const { ctx, warnings } = fakeContext(shell)
  assert.doesNotThrow(() => mountUtf8ConsoleBridge(ctx, () => ({ utf8Console: true }), 'win32'))
  assert.equal(warnings.length, 1)
})
check('falls open when the config reader throws', () => {
  const { shell, calls } = fakeShell()
  const { ctx } = fakeContext(shell)
  mountUtf8ConsoleBridge(ctx, () => { throw new Error('config unavailable') }, 'win32')
  shell.execute({ command: 'Get-Location' })
  assert.equal(calls[0].spec.command, 'Get-Location')
})

if (failures > 0) {
  console.error(`utf8 bridge: ${failures} check(s) failed`)
  process.exit(1)
}
console.log('ok — utf8 console bridge: prefix, opt-out, idempotence, restore and fail-open paths')
