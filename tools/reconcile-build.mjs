/**
 * Per-package reconciliation of one harness build against an earlier one — run it with
 * `node tools/reconcile-build.mjs --from 0.2.2-rc.3`.
 *
 * **Two channels ship the same package, and they are not byte-identical.** The desktop shell
 * carries its own copy inside `app.asar`; npm publishes `@deepseek-ai/*` separately. Measured on
 * 2026-11-19: `dsh-pwsh-local/lib/index.js` inside the shell's archive is 17,001 bytes and contains
 * `PYTHONIOENCODING: "utf-8"`, while the tarball of *the same version number* is 16,816 bytes
 * without it. Comparing the installed copy against the previous version's tarball therefore reports
 * a change that is not a version change at all.
 *
 * So this tool compares like with like:
 *
 *   1. **version delta** — the previous build's tarball against the installed build's tarball. Same
 *      channel, so a difference here is real code movement. This decides the exit code.
 *   2. **channel drift** — the installed tarball against the installed copy on disk. Expected
 *      noise; printed so nobody mistakes it for news, and so a *new* drift is visible when it moves.
 *
 * Neither file counts nor byte totals are evidence (`exp-native-first`): the archive drops
 * `lib/types/**` and inlines nested dependencies, so both numbers disagree between the channels even
 * for identical code. Only the bytes of files **both sides ship** are compared.
 *
 * Exit codes: 0 = no code difference outside `package.json`, 1 = code moved (list printed),
 * 2 = could not decide (no installation, or a download failed). The gate
 * (`check-native-contracts.mjs`) proves the symbols still behave; this tool answers the earlier and
 * cheaper question — *how much of the build actually moved* — so a baseline bump is known to be a
 * declaration and not a migration. It is deliberately not in `npm run check`: it needs the network.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join, relative, sep } from 'node:path'
import { resolveAppModulesDir } from './dsh-app-modules.mjs'

/** The packages this plugin's contracts point at — the same list `check-native-contracts.mjs` loads. */
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

/** Published by npm but never a code change. */
const MANIFEST = 'package.json'

/** Parse `--name value` / `--name=value`; an unknown flag is a usage error, not silently ignored. */
function parseArgs(argv) {
  const known = new Set(['--from', '--registry', '--json'])
  const options = { from: undefined, registry: undefined, json: false }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const name = argument.startsWith('--') ? argument.split('=')[0] : argument
    if (!known.has(name)) throw new Error(`unknown argument \`${argument}\` — usage: reconcile-build.mjs --from <version> [--registry <url>] [--json]`)
    if (name === '--json') {
      options.json = true
      continue
    }
    const inline = argument.includes('=') ? argument.slice(argument.indexOf('=') + 1) : undefined
    const value = inline ?? argv[index + 1]
    if (value === undefined) throw new Error(`${name} needs a value`)
    if (inline === undefined) index += 1
    if (name === '--from') options.from = value
    else options.registry = value
  }
  if (options.from === undefined) throw new Error('missing --from <version>, e.g. --from 0.2.2-rc.3')
  return options
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

/** Every regular file below `directory`, keyed by POSIX-style relative path. */
function walk(directory, base = directory, out = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const full = join(directory, entry.name)
    if (entry.isDirectory()) walk(full, base, out)
    else if (entry.isFile()) out.set(relative(base, full).split(sep).join('/'), full)
  }
  return out
}

/** The copy on disk, hashed: `lib/**` plus archive-root files (the manifest is reported separately). */
function installedFiles(packageDir) {
  const files = new Map()
  for (const [name, path] of walk(packageDir)) {
    if (name === MANIFEST || name.startsWith('lib/')) files.set(name, sha256(readFileSync(path)))
  }
  return files
}

/** Minimal `tar` reader: enough for npm tarballs (regular files, ustar + GNU long names). */
function tarFiles(tar) {
  const out = new Map()
  let offset = 0
  let longName
  while (offset + 512 <= tar.length) {
    const block = tar.subarray(offset, offset + 512)
    if (block.every((byte) => byte === 0)) break
    const field = (start, end) => block.subarray(start, end).toString('utf8').replace(/\0.*$/s, '')
    const name = field(0, 100)
    const prefix = field(345, 500)
    const size = Number.parseInt(field(124, 136).trim(), 8) || 0
    const type = String.fromCharCode(block[156])
    const body = tar.subarray(offset + 512, offset + 512 + size)
    const path = (longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^package\//, '')
    if (type === 'L') longName = body.toString('utf8').replace(/\0.*$/s, '')
    else if (type === '0' || type === '\0') out.set(path, sha256(body))
    if (type !== 'L') longName = undefined
    offset += 512 + Math.ceil(size / 512) * 512
  }
  return out
}

/** Download one published package and return its file hashes. */
async function publishedFiles(name, version, registry) {
  const url = `${registry.replace(/\/$/, '')}/@deepseek-ai/${name}/-/${name}-${version}.tgz`
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`GET ${url} → ${response.status} ${response.statusText}`)
  return tarFiles(gunzipSync(Buffer.from(await response.arrayBuffer())))
}

/** Compare two hash maps, keeping only `lib/**` and the manifest (the manifests are code-relevant). */
function compare(left, right) {
  const leftFiles = [...left.keys()].filter((file) => file === MANIFEST || file.startsWith('lib/'))
  const changed = leftFiles.filter((file) => right.has(file) && right.get(file) !== left.get(file))
  const onlyLeft = leftFiles.filter((file) => !right.has(file))
  const onlyRight = [...right.keys()].filter((file) => (file === MANIFEST || file.startsWith('lib/')) && !left.has(file))
  return { compared: leftFiles.filter((file) => right.has(file)).length, changed, onlyLeft, onlyRight }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const registry = options.registry ?? process.env.NPM_CONFIG_REGISTRY ?? 'https://registry.npmjs.org'

  const appModules = resolveAppModulesDir()
  if (appModules === undefined) {
    console.error('cannot decide — no DSH installation found: set DSH_APP_DIR to the install root, resources/app, or resources/app.asar')
    process.exit(2)
  }
  const installedVersion = JSON.parse(
    readFileSync(join(appModules, 'node_modules', '@deepseek-ai', 'dsh-tools', 'package.json'), 'utf8'),
  ).version

  const report = { from: options.from, to: installedVersion, installed: appModules, registry, packages: [], codeChanges: 0 }
  for (const name of PACKAGES) {
    const packageDir = join(appModules, 'node_modules', '@deepseek-ai', name)
    if (!existsSync(packageDir)) {
      report.packages.push({ name, unavailable: 'not installed in this build' })
      continue
    }
    let fromFiles
    let toFiles
    try {
      fromFiles = await publishedFiles(name, options.from, registry)
      toFiles = await publishedFiles(name, installedVersion, registry)
    } catch (error) {
      console.error(`cannot decide — ${name}: ${error.message}`)
      process.exit(2)
    }
    const delta = compare(fromFiles, toFiles)
    const drift = compare(toFiles, installedFiles(packageDir))
    const codeChanges = delta.changed.filter((file) => file !== MANIFEST)
    report.codeChanges += codeChanges.length
    report.packages.push({ name, compared: delta.compared, changed: codeChanges, manifestOnly: delta.changed.length - codeChanges.length, onlyFrom: delta.onlyLeft, onlyTo: delta.onlyRight, channelDrift: drift.changed })
  }

  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
  } else {
    console.log(`comparing @deepseek-ai/*@${options.from} → @${installedVersion} (tarball vs tarball, the one comparable pair)`)
    console.log(`installed copy read from ${appModules}\n`)
    for (const entry of report.packages) {
      if (entry.unavailable) {
        console.log(`${entry.name.padEnd(20)} not installed — skipped`)
        continue
      }
      const verdict = entry.changed.length === 0 ? 'unchanged' : `CHANGED ${entry.changed.join(', ')}`
      const manifest = entry.manifestOnly ? ' (+package.json)' : ''
      const gone = entry.onlyFrom.length ? ` | dropped: ${entry.onlyFrom.join(', ')}` : ''
      const added = entry.onlyTo.length ? ` | added: ${entry.onlyTo.join(', ')}` : ''
      const drift = entry.channelDrift.length ? ` | channel drift: ${entry.channelDrift.join(', ')}` : ''
      console.log(`${entry.name.padEnd(20)} ${String(entry.compared).padStart(3)} files  ${verdict}${manifest}${gone}${added}${drift}`)
    }
    console.log(`\ncode changes between the two published builds: ${report.codeChanges}`)
    console.log(report.codeChanges === 0
      ? 'verdict — zero migration: bumping dsh.verifiedAgainst is a declaration, not a port'
      : 'verdict — code moved: read the changed files before touching dsh.verifiedAgainst')
    const drifted = report.packages.filter((entry) => entry.channelDrift?.length)
    if (drifted.length) {
      console.log(`note — ${drifted.length} package(s) differ between the npm tarball and the shell's own copy;`)
      console.log('       that drift predates this reconciliation and is not a version change.')
    }
  }
  process.exit(report.codeChanges === 0 ? 0 : 1)
}

await main()
