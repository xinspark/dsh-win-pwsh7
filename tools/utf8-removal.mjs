/**
 * UTF-8 console bridge — keep-or-remove verdict, and the executable form of the removal contract.
 *
 * The bridge (`lib/utf8-console-bridge.js`) exists only because the Host's `dsh-pwsh-local` pins the
 * .NET output encoding of the outer process and not the *console code page*: a nested
 * `pwsh -File` inherits code page 936 on a zh-CN machine and emits GBK, which the collector then
 * decodes as UTF-8. When upstream pins the code page itself, the bridge must go — and "must go" is
 * a judgement somebody has to make correctly at 0.3.0, not a memory to rely on.
 *
 * Two modes, one purpose: make that judgement mechanical.
 *
 *   node tools/utf8-removal.mjs
 *     Verdict on the installed build. Exits 1 when upstream has fixed it (a red signal: follow the
 *     removal contract), 0 while the bridge is still needed. Either way it prints every reference
 *     to the bridge, which is the deletion "whole block" made concrete.
 *
 *   node tools/utf8-removal.mjs --verify
 *     Post-deletion check. Exits 0 only when no reference remains anywhere (the README's acceptance
 *     criterion), 1 with the leftover list. Run it *after* deleting, and delete this file with the
 *     bridge (README removal contract, step 4).
 *
 * The second judgement in the README — "a nested `pwsh -File` under code page 936 already emits
 * UTF-8 without this plugin" — needs a real CP936 console and cannot be decided offline; this tool
 * says so instead of guessing.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { register } from 'node:module'
import { resolveAppModulesDir } from './dsh-app-modules.mjs'

const REPO = dirname(dirname(fileURLToPath(import.meta.url)))
const verifyOnly = process.argv.includes('--verify')

/** Every name the bridge answers to, in code, config and prose. */
const MARKERS = ['utf8-console-bridge', 'utf8Console', 'UTF8_CONSOLE_PATCH', 'utf8Command', 'chcp.com 65001']

/** Where a leftover reference can hide. `.git` and `node_modules` are not ours. */
const SKIP = new Set(['.git', 'node_modules', 'docs-private'])

/**
 * Walk the repository and list every line that mentions the bridge.
 * @returns `{ file, line, text }[]`, paths relative to the repository root.
 */
function references() {
  const found = []
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (SKIP.has(entry.name)) continue
      const full = join(directory, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!/\.(?:m?js|cjs|jsx|ts|json|ya?ml|md)$/u.test(entry.name)) continue
      let text
      try {
        if (statSync(full).size > 2_000_000) continue
        text = readFileSync(full, 'utf8')
      } catch {
        continue
      }
      const lines = text.split(/\r?\n/u)
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]
        if (!MARKERS.some((marker) => line.includes(marker))) continue
        found.push({ file: relative(REPO, full).replaceAll('\\', '/'), line: index + 1, text: line.trim() })
      }
    }
  }
  walk(REPO)
  return found
}

/**
 * Ask the installed build whether it pins the console code page itself.
 * @returns `{ verdict: 'fixed' | 'needed' | 'unknown', detail }`.
 */
async function upstreamVerdict() {
  const appModules = resolveAppModulesDir()
  if (appModules === undefined) {
    return { verdict: 'unknown', detail: 'no DSH installation found — set DSH_APP_DIR to the install root, resources/app, or resources/app.asar' }
  }
  process.env.DSH_APP_DIR = appModules
  register('./node-app-modules-hook.mjs', import.meta.url)
  try {
    const pwshLocal = await import('@deepseek-ai/dsh-pwsh-local')
    const preamble = pwshLocal.ENCODING_PREAMBLE
    if (typeof preamble !== 'string') {
      return { verdict: 'unknown', detail: 'ENCODING_PREAMBLE is gone from dsh-pwsh-local; re-read the encoding contract before deciding anything' }
    }
    if (/chcp(?:\.com)?\s+65001|SetConsoleOutputCP/iu.test(preamble)) {
      return { verdict: 'fixed', detail: 'ENCODING_PREAMBLE now pins the console code page itself' }
    }
    return { verdict: 'needed', detail: 'ENCODING_PREAMBLE still pins only the .NET output encoding (no chcp / SetConsoleOutputCP)' }
  } catch (error) {
    return { verdict: 'unknown', detail: `could not read dsh-pwsh-local: ${error instanceof Error ? error.message : String(error)}` }
  }
}

const found = references()

if (verifyOnly) {
  if (found.length === 0) {
    console.log('ok — no reference to the UTF-8 console bridge remains (README removal contract, acceptance criterion)')
    process.exitCode = 0
  } else {
    console.error(`not ok — ${found.length} reference(s) to the UTF-8 console bridge remain:`)
    for (const hit of found) console.error(`  ${hit.file}:${hit.line}  ${hit.text}`)
    console.error('\nThe removal contract deletes all of them together: the file, the import and mount,')
    console.error('Config.utf8Console, tools/check-utf8-bridge.mjs (and its line in the check chain), and the docs.')
    process.exitCode = 1
  }
} else {
  const { verdict, detail } = await upstreamVerdict()
  console.log(`upstream: ${detail}`)
  console.log(`bridge references: ${found.length}`)
  for (const hit of found) console.log(`  ${hit.file}:${hit.line}`)
  if (verdict === 'fixed') {
    console.error('\nnot ok — upstream pins the console code page. The bridge has done its job; remove it now:')
    console.error('  1. delete lib/utf8-console-bridge.js')
    console.error('  2. delete the import and the mountUtf8ConsoleBridge(...) mount in index.js')
    console.error('  3. delete Config.utf8Console')
    console.error('  4. delete tools/check-utf8-bridge.mjs and this file, and both lines from the check chain')
    console.error('  5. delete the README "Windows UTF-8 console" section and the CHANGELOG transition note')
    console.error('  6. release as 0.3.0, then run: node tools/check-utf8-bridge.mjs — it must be gone')
    process.exitCode = 1
  } else if (verdict === 'needed') {
    console.log('\nok — the bridge is still needed. Delete it only when this verdict flips, or when a real')
    console.log('CP936 console shows a nested `pwsh -File` already emitting UTF-8 without the plugin.')
    process.exitCode = 0
  } else {
    console.error(`\nunknown — ${detail}`)
    process.exitCode = 2
  }
}
