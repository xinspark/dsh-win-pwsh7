#!/usr/bin/env node
// ============================================================================
// Documentation link check — every relative link and anchor in the public docs
// (and the private entry README) must resolve inside this repository.
// ----------------------------------------------------------------------------
// Scope: README / CHANGELOG / MAINTAINING / CONTRIBUTING / SECURITY /
// docs/**/*.md / docs-private/README.md / .github/**/*.md.
// Only repository-relative links are checked: http(s) / mailto / data: are
// skipped, directory links are allowed, and `file.md#anchor` is matched against
// GitHub's heading-slug rules.
//
// Usage: node tools/check-docs.mjs   (included in `npm run check`)
// ============================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function walkMarkdown(dir, out = []) {
  if (!fs.existsSync(dir)) return out
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      walkMarkdown(full, out)
    } else if (/\.md$/i.test(entry.name)) {
      out.push(full)
    }
  }
  return out
}

const files = [
  ...['README.md', 'README.en.md', 'CHANGELOG.md', 'MAINTAINING.md', 'CONTRIBUTING.md', 'SECURITY.md',
    // Only the private entry README is committed; its links must be checkable too.
    'docs-private/README.md']
    .map((name) => path.join(ROOT, name)),
  ...walkMarkdown(path.join(ROOT, 'docs')),
  ...walkMarkdown(path.join(ROOT, '.github')),
].filter((file) => fs.existsSync(file))

// GitHub heading anchors: drop formatting, lowercase, strip punctuation, spaces to hyphens (CJK kept).
function slugify(heading) {
  return heading
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, '')
    .replace(/`([^`]*)`/g, '$1')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s\-_]/gu, '')
    .trim()
    .replace(/\s+/g, '-')
}

function anchorsOf(file) {
  const anchors = new Set()
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const hit = /^#{1,6}\s+(.+?)\s*$/.exec(line)
    if (hit !== null) anchors.add(slugify(hit[1]))
  }
  return anchors
}

const cache = new Map()
const getAnchors = (file) => {
  if (!cache.has(file)) cache.set(file, anchorsOf(file))
  return cache.get(file)
}

const LINK = /(!?)\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g
const EXTERNAL = /^(?:[a-zA-Z][\w+.-]*:|\/\/)/
const errors = []

for (const file of files) {
  const raw = fs.readFileSync(file, 'utf8')
  // Brackets inside fenced blocks and inline code are not links.
  const text = raw.replace(/```[\s\S]*?```/g, '').replace(/`[^`\n]*`/g, '')
  for (const match of text.matchAll(LINK)) {
    const target = match[2]
    if (target === '' || EXTERNAL.test(target)) continue
    const [rawPath, rawAnchor] = target.split('#')
    const filePart = decodeURIComponent(rawPath)
    const rel = path.relative(ROOT, file)
    if (filePart === '') {
      // Same-file anchor.
      if (rawAnchor !== undefined && !getAnchors(file).has(decodeURIComponent(rawAnchor))) {
        errors.push(`${rel}: anchor does not exist #${rawAnchor}`)
      }
      continue
    }
    const resolved = path.resolve(path.dirname(file), filePart)
    if (!fs.existsSync(resolved)) {
      errors.push(`${rel}: target does not exist ${target}`)
      continue
    }
    if (rawAnchor !== undefined && /\.md$/i.test(resolved)) {
      const anchor = decodeURIComponent(rawAnchor)
      if (!getAnchors(resolved).has(anchor)) {
        errors.push(`${rel}: anchor does not exist ${target}`)
      }
    }
  }
}

if (errors.length > 0) {
  console.error(`check-docs: ${errors.length} broken link(s)`)
  for (const error of errors) console.error('  ' + error)
  process.exit(1)
}
console.log(`check-docs: ${files.length} documents, links and anchors all valid`)
