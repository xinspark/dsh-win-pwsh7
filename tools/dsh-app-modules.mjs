/**
 * Locate the harness packages (`node_modules/@deepseek-ai/*`) that a standalone `node` run has to
 * resolve a plugin's bare imports against.
 *
 * Two installation shapes exist and both must work with no path from the author's machine:
 *
 *   - **unpacked** — `<install>/resources/app/node_modules/@deepseek-ai/cordis`. Node resolves
 *     through it directly, so the directory is what the loader hook wants.
 *   - **packed** — `<install>/resources/app.asar`, with `app.asar.unpacked/` beside it holding only
 *     native modules and assets. Node cannot read a path inside an asar archive, and DSH 2.0 ships
 *     this shape, so pointing a gate at it fails with `Cannot find package '@deepseek-ai/cordis'`
 *     even though the packages are right there. The archive is therefore unpacked once into a
 *     temporary directory keyed by the archive's size and mtime, and that directory is used instead.
 *
 * Unpacking the whole tree — rather than reimplementing Node's resolution over the archive — is the
 * deliberate choice: the loader hook then hands Node a real filesystem, so `exports` maps,
 * conditions, JSON, CJS/ESM detection and dynamic `import()` behave exactly as they do under the
 * Host. A one-time write of ~150 MB is cheaper than a resolver that could disagree with Node and
 * turn this gate into a false green.
 */
import { closeSync, copyFileSync, existsSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, parse } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** `node_modules/@deepseek-ai/cordis` present: a directory Node can resolve through. */
function hasHarness(directory) {
  return existsSync(join(directory, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))
}

/** The nearest ancestor of `start` that carries the harness packages, or `undefined`. */
function harnessAbove(start) {
  let directory = start
  const root = parse(directory).root
  for (;;) {
    if (hasHarness(directory)) return directory
    if (directory === root) return undefined
    directory = dirname(directory)
  }
}

/** An asar archive: `[u32 4][u32 pickle size][u32 json length][json][files]`. */
function readArchiveHeader(archive) {
  const fd = openSync(archive, 'r')
  try {
    const head = Buffer.alloc(16)
    readSync(fd, head, 0, 16, 0)
    if (head.readUInt32LE(0) !== 4) throw new Error(`${archive} is not an asar archive: unexpected pickle header`)
    const pickleSize = head.readUInt32LE(4)
    const jsonLength = head.readUInt32LE(12)
    const json = Buffer.alloc(jsonLength)
    readSync(fd, json, 0, jsonLength, 16)
    return { fd, header: JSON.parse(json.toString('utf8')), base: 8 + pickleSize }
  } catch (error) {
    closeSync(fd)
    throw error
  }
}

/** Write one entry: directory subtree, unpacked sibling, symlink target, or packed bytes. */
function writeEntry(fd, archive, entry, destination, relative, base) {
  if (entry.files !== undefined) {
    mkdirSync(destination, { recursive: true })
    for (const [name, child] of Object.entries(entry.files)) {
      writeEntry(fd, archive, child, join(destination, name), relative === '' ? name : `${relative}/${name}`, base)
    }
    return
  }
  mkdirSync(dirname(destination), { recursive: true })
  if (entry.link !== undefined) {
    // Only read by the gate: materialise the symlink's target as a copy.
    const target = join(`${archive}.unpacked`, ...entry.link.split('/'))
    if (existsSync(target)) copyFileSync(target, destination)
    return
  }
  if (entry.unpacked === true) {
    const beside = join(`${archive}.unpacked`, ...relative.split('/'))
    if (existsSync(beside)) copyFileSync(beside, destination)
    return
  }
  const bytes = Buffer.alloc(entry.size)
  readSync(fd, bytes, 0, entry.size, base + Number(entry.offset))
  writeFileSync(destination, bytes)
}

/** Unpack `node_modules` (and the archive's own `package.json`) into a cache keyed by the archive. */
function unpackArchive(archive) {
  const { size, mtimeMs } = statSync(archive)
  const key = `${archive.replace(/[^a-z0-9]+/giu, '_')}-${size}-${Math.trunc(mtimeMs)}`
  const cache = join(tmpdir(), `dsh-app-modules-${key}`)
  if (hasHarness(cache)) return cache
  const staging = `${cache}.${process.pid}`
  rmSync(staging, { recursive: true, force: true })
  mkdirSync(staging, { recursive: true })
  const { fd, header, base } = readArchiveHeader(archive)
  try {
    for (const name of ['node_modules', 'package.json']) {
      const entry = header.files?.[name]
      if (entry !== undefined) writeEntry(fd, archive, entry, join(staging, name), name, base)
    }
  } finally {
    closeSync(fd)
  }
  rmSync(cache, { recursive: true, force: true })
  renameSync(staging, cache)
  return cache
}

/**
 * Resolve a user-supplied location to a directory Node can resolve the harness packages through.
 * @param location - `DSH_APP_DIR`, an install root, a `resources` directory, `app.asar`, or `app.asar.unpacked`.
 * @returns the directory, or `undefined` when this location is not a DSH installation.
 */
function fromLocation(location) {
  const trimmed = location.replace(/[\\/]+$/u, '')
  if (trimmed === '') return undefined
  if (existsSync(trimmed)) {
    const stats = statSync(trimmed)
    if (stats.isFile()) return /\.asar$/iu.test(trimmed) ? unpackArchive(trimmed) : undefined
    if (hasHarness(trimmed)) return trimmed
    if (/\.asar\.unpacked$/iu.test(trimmed)) {
      const archive = trimmed.replace(/\.unpacked$/iu, '')
      return existsSync(archive) ? unpackArchive(archive) : undefined
    }
    for (const inner of [join(trimmed, 'app.asar'), join(trimmed, 'resources', 'app.asar')]) {
      if (existsSync(inner)) return unpackArchive(inner)
    }
    for (const inner of [join(trimmed, 'app'), join(trimmed, 'resources', 'app')]) {
      if (hasHarness(inner)) return inner
    }
  }
  return undefined
}

/**
 * The directory a standalone run must resolve `@deepseek-ai/*` through.
 *
 * Order: `DSH_APP_DIR`, then the nearest ancestor of this file, then of the working directory —
 * which covers a plugin installed *inside* an installation with no configuration at all.
 * @returns the directory, or `undefined` when no installation can be found.
 */
export function resolveAppModulesDir() {
  const here = dirname(fileURLToPath(import.meta.url))
  const candidates = [process.env.DSH_APP_DIR, harnessAbove(here), harnessAbove(process.cwd())]
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || candidate === '') continue
    const resolved = fromLocation(candidate)
    if (resolved !== undefined) return resolved
  }
  return undefined
}
