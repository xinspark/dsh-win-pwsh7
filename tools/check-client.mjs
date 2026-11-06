/**
 * Client-half gate for dsh-win-pwsh7 — run with `node tools/check-client.mjs`.
 *
 * The card is *rendered* here rather than read as text. The browser module is captured through
 * a stub `window.__ModuleLoader__`, handed a stub React that records the element tree, and
 * applied to a stub client context; the assertions then read the text a user would see.
 *
 * That is the only way to catch the defect this gate exists for: a label written as a literal
 * (`h('label', null, 'overridePath')`) is valid text and passes every static scan — it only
 * shows up when the card is drawn. The dictionaries the card registers are the fixtures, so no
 * translation is copied into this file.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const failures = []
function check(label, assertion) {
  try {
    assertion()
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
  }
}

// --- Stub React: records the tree, never renders it --------------------------------------

const storeCalls = []
const React = {
  createElement(type, props, ...children) {
    const flat = children.flat(Infinity).filter((child) => child !== null && child !== undefined && child !== false)
    return { type, props: props ?? {}, children: flat }
  },
  useEffect() { /* effects are not run: this gate asserts one render, not behaviour */ },
  useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
  useSyncExternalStore(subscribe, getSnapshot) {
    storeCalls.push({ subscribe, getSnapshot })
    return getSnapshot()
  },
}

/** Every string rendered anywhere in the tree, in document order. */
function textsOf(node, found = []) {
  if (typeof node === 'string' || typeof node === 'number') {
    found.push(String(node))
    return found
  }
  if (node === null || node === undefined || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, found)
    return found
  }
  for (const child of node.children) textsOf(child, found)
  return found
}

/** Every element of one type in the tree (for structural assertions). */
function elementsOf(node, type, found = []) {
  if (node === null || typeof node !== 'object') return found
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, type, found)
    return found
  }
  if (node.type === type) found.push(node)
  for (const child of node.children) elementsOf(child, type, found)
  return found
}

// --- Stub client context ------------------------------------------------------------------

let dictionaries = {}
const LOCALES = ['zh', 'en', 'ja', 'de', 'es', 'fr', 'pt', 'ru']
const registered = []
// A controller's `getSnapshot` has to return a stable reference until the state changes — React
// compares with `Object.is` and re-renders forever otherwise. This fixture models that contract
// (the old one returned a fresh literal per call, i.e. the very anti-pattern the identity assertion
// further down exists to catch).
let formSnapshotCache = null
let formSnapshotKey = null
const form = {
  status: 'ready',
  writable: true,
  value: { overridePath: '' },
  getSnapshot() {
    const key = `${this.status}|${this.writable}|${this.value.overridePath}`
    if (formSnapshotCache === null || formSnapshotKey !== key) {
      formSnapshotKey = key
      formSnapshotCache = { status: this.status, writable: this.writable, value: this.value }
    }
    return formSnapshotCache
  },
  subscribe() { return () => {} },
  async set() { return true },
  async unset() { return true },
}

const ctx = {
  // The module declares `inject: ['slots','locale','configForms','remote']`, so these arrive as
  // properties; `get` is kept for the one lookup the client does itself (`remote`).
  configForms: { get: () => form },
  get: (key) => (key === 'configForms' ? { get: () => form } : undefined),
  effect(fn) { const cleanup = fn(); return () => { if (typeof cleanup === 'function') cleanup() } },
  locale: {
    register(_namespace, dicts) { dictionaries = dicts; return () => {} },
    bind: () => (key, params) => {
      const text = dictionaries.zh[key]
      if (text === undefined) throw new Error(`the card asked for "${key}", which no dictionary defines`)
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/gu, (whole, name) => (name in params ? String(params[name]) : whole))
    },
  },
  slots: {
    inject(_slot, register) { return register() },
    register(registration, component) { registered.push({ registration, component }); return () => {} },
  },
}

let entry
globalThis.window = { __ModuleLoader__: { load(definition) { entry = definition } } }
await import('../client.js')
assert.ok(entry !== undefined, 'client.js did not call window.__ModuleLoader__.load()')
const client = entry.factory((name) => {
  if (name === 'react') return React
  throw new Error(`the client half required an unexpected module: ${name}`)
})
client.apply(ctx)

const componentFor = (slot) => registered.find((item) => item.registration.name === slot)?.component
const componentById = (slot, id) => registered.find((item) => item.registration.name === slot && item.registration.id === id)?.component
const card = componentFor('plugins.row.config')
const diagnostics = componentById('plugins.detail.section', 'dsh-win-pwsh7.diagnostics')
const starSection = componentById('plugins.detail.section', 'dsh-win-pwsh7.star')

check('the client half registers the three contributions the page uses', () => {
  assert.deepEqual(registered.map((item) => [item.registration.name, item.registration.id ?? item.registration.key]), [
    ['plugins.row.config', 'dsh-win-pwsh7#win-pwsh7'],
    ['plugins.detail.section', 'dsh-win-pwsh7.diagnostics'],
    ['plugins.detail.section', 'dsh-win-pwsh7.star'],
  ])
  const star = registered.find((item) => item.registration.id === 'dsh-win-pwsh7.star').registration
  assert.equal(star.order, 80)
  assert.ok(star.order < 90, 'the star line must render before the market source row (order 90)')
  assert.equal(star.locale, 'dsh-win-pwsh7')
})

// --- The configure card -------------------------------------------------------------------

const cardTree = card({ view: 'page' })
const cardTexts = textsOf(cardTree)

check('the card renders its labels from the dictionaries, never as bare config keys', () => {
  for (const key of ['overridePath']) {
    assert.ok(!cardTexts.includes(key),
      `the card rendered the bare config key "${key}" — a label was written as a literal instead of t()`)
  }
  for (const expected of [dictionaries.zh.field_overridePath]) {
    assert.ok(cardTexts.includes(expected), `the card does not render the label "${expected}"`)
  }
})
check('the retired coexistence switch is gone with the dsh-ops bridge', () => {
  const text = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
  assert.ok(!text.includes('dshOpsCompat'), 'client.js still reads or writes the retired coexistence config')
  assert.ok(!text.includes('dsh-ops-compat'), 'client.js still mentions the retired compatibility row')
  assert.ok(!text.includes('Switch'), 'client.js still imports a switch for the removed card')
})
check('the card renders every hint in Chinese', () => {
  for (const hint of [dictionaries.zh.overridePath_hint]) {
    assert.ok(cardTexts.includes(hint), `the card does not render the hint "${hint.slice(0, 24)}…"`)
  }
})
check('the configure card does not carry the star line', () => {
  assert.ok(!cardTexts.includes(dictionaries.zh.star),
    'the star line is still in the configuration card; it belongs at the bottom of the page')
})
check('the summary view renders nothing, as the row list expects', () => {
  assert.equal(card({ view: 'summary' }), null)
})
check('the configure surface uses the dsh-ops card language', () => {
  // Aligned with the installed dsh-ops branch: one hairline card per group and a shaded
  // card body for the editable field.
  const sections = elementsOf(cardTree, 'section')
  assert.equal(sections.length, 1, `expected one card, found ${sections.length}`)
  for (const section of sections) {
    assert.match(String(section.props.className), /\bdw7-card\b/u)
    assert.match(String(section.props.className), /\bdw7-group\b/u)
  }
  const bodies = elementsOf(cardTree, 'div').filter(node => node.props.className === 'dw7-card-body')
  assert.equal(bodies.length, 1, `expected one shaded body for the editable card, found ${bodies.length}`)
  assert.ok(!elementsOf(cardTree, 'section').some(node => /\bdw7-section\b/u.test(String(node.props.className))),
    'the retired flat section class survived')
})

// A second application with no controller for this row — the state that used to throw inside the
// render (`form.subscribe` on undefined). The card must report the Host's "unavailable" state.
const registeredBefore = registered.length
client.apply({ ...ctx, configForms: { get: () => undefined }, get: () => undefined })
const noFormCard = registered.slice(registeredBefore)
  .find((item) => item.registration.name === 'plugins.row.config')?.component
let noFormTexts = null
let noFormError = null
try {
  noFormTexts = textsOf(noFormCard({ view: 'page' }))
} catch (error) {
  noFormError = error
}

check('the configure card survives a missing form controller instead of throwing', () => {
  assert.ok(noFormCard !== undefined, 'the second application registered no card')
  assert.equal(noFormError, null, `the card threw with no form controller: ${noFormError?.message}`)
  assert.ok(noFormTexts?.includes(dictionaries.zh.form_unavailable),
    `the card did not report the unavailable form: ${(noFormTexts ?? []).join(' | ').slice(0, 160)}`)
})

// `useSyncExternalStore` compares snapshots with `Object.is` and re-subscribes whenever `subscribe`
// changes identity, so the callbacks a component hands it must be built once. The missing-controller
// path is exactly where this broke: a fallback written inline returned a fresh object per call, which
// React answers with an infinite render loop ("The result of getSnapshot should be cached"). A
// single-render gate cannot see a loop, so this renders twice and compares the identities.
storeCalls.length = 0
noFormCard({ view: 'page' })
const firstCallbacks = storeCalls.slice()
storeCalls.length = 0
noFormCard({ view: 'page' })
const secondCallbacks = storeCalls.slice()

check('the missing-controller callbacks keep a stable identity across renders', () => {
  assert.ok(firstCallbacks.length > 0 && secondCallbacks.length > 0,
    'the card never subscribed to a snapshot')
  assert.ok(Object.is(firstCallbacks[0].subscribe, secondCallbacks[0].subscribe),
    'subscribe changed identity between renders — React would re-subscribe on every render')
  assert.ok(Object.is(firstCallbacks[0].getSnapshot(), firstCallbacks[0].getSnapshot()),
    'getSnapshot returned a fresh object — React would re-render forever')
})

// --- The diagnostics section and the action -----------------------------------------------

const diagnosticsTree = diagnostics({ subject: { pkg: 'dsh-win-pwsh7' } })
const diagnosticsTexts = textsOf(diagnosticsTree)

check('the diagnostics section does not carry the star line', () => {
  assert.ok(!diagnosticsTexts.includes(dictionaries.zh.star),
    'the star line is still inside the diagnostics section; it belongs to its own detail section')
})

const starTree = starSection({ subject: { pkg: { name: 'dsh-win-pwsh7' } } })
const starTexts = textsOf(starTree)
check('the star section renders the localized line for this package', () => {
  const star = elementsOf(starTree, 'p').find((node) => node.props.className === 'dw7-star-line')
  assert.ok(star !== undefined, 'the star section renders no star line')
  assert.deepEqual(star.children, [dictionaries.zh.star])
  assert.equal(star.props['data-pwsh7-star'], 'detail')
  assert.ok(starTexts.includes(dictionaries.zh.star), 'the star line text is missing')
})
check('the star section prefers the slot-injected translator', () => {
  const injected = starSection({ subject: { pkg: { name: 'dsh-win-pwsh7' } }, t: (key) => `T:${key}` })
  assert.ok(textsOf(injected).includes('T:star'), 'props.t was not used')
})
check('the star section stays out of other plugins pages and subjects', () => {
  assert.equal(starSection({ subject: { pkg: { name: 'some-other-plugin' } } }), null)
  assert.equal(starSection({ subject: { kind: 'item', id: 'some-item' } }), null)
  assert.equal(starSection({}), null)
})

check('the diagnostics section renders its localized title and detecting state', () => {
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.diagnostics_title),
    'the diagnostics section does not render its title from the dictionary')
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.status_detecting),
    'the diagnostics section does not render its detecting state')
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.status_lead_detecting),
    'the diagnostics section does not render its detecting lead')
})
check('the diagnostics section stays out of other plugins pages', () => {
  assert.equal(diagnostics({ subject: { pkg: 'some-other-plugin' } }), null)
})
check('the diagnostics section renders the localized Re-detect label', () => {
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.redetect),
    `the section does not render "${dictionaries.zh.redetect}"`)
  assert.ok(!registered.some((item) => item.registration.name === 'plugins.detail.actions'),
    'the Re-detect button still has a second home in plugins.detail.actions')
})

// --- Copy hygiene -------------------------------------------------------------------------

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('all eight official locale dictionaries are registered with identical keys', () => {
  for (const locale of LOCALES) {
    assert.ok(dictionaries[locale] !== undefined && typeof dictionaries[locale] === 'object',
      `the ${locale} dictionary was never registered`)
  }
  const keys = Object.keys(dictionaries.zh).sort()
  for (const locale of LOCALES) {
    assert.deepEqual(Object.keys(dictionaries[locale]).sort(), keys,
      `the ${locale} dictionary key set diverges from zh`)
    for (const [key, value] of Object.entries(dictionaries[locale])) {
      assert.equal(typeof value, 'string', `${locale}.${key} is not a string`)
      assert.ok(value.trim() !== '', `${locale}.${key} is empty`)
    }
  }
})
check('every translated value keeps the English placeholder set', () => {
  const placeholders = (text) => [...text.matchAll(/\{(\w+)\}/gu)].map((match) => match[1]).sort()
  for (const key of Object.keys(dictionaries.en)) {
    const expected = placeholders(dictionaries.en[key])
    for (const locale of LOCALES) {
      assert.deepEqual(placeholders(dictionaries[locale][key]), expected,
        `${locale}.${key} changed the placeholders of the English source`)
    }
  }
})
check('the Latin-script dictionaries carry no CJK', () => {
  for (const locale of ['en', 'de', 'es', 'fr', 'pt', 'ru']) {
    const text = JSON.stringify(dictionaries[locale])
    assert.ok(text.length > 200, `the ${locale} dictionary looks empty: ${text}`)
    const cjk = text.match(/[\u3400-\u9fff]/gu)
    assert.equal(cjk, null, `CJK in the ${locale} dictionary: ${cjk === null ? '' : cjk.join('')}`)
  }
})
check('every official locale ships its package title and description', () => {
  for (const locale of LOCALES) {
    const meta = JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8'))
    assert.ok(typeof meta?.meta?.title === 'string' && meta.meta.title.trim() !== '',
      `locale/${locale}.json has no meta.title`)
    assert.ok(typeof meta?.meta?.description === 'string' && meta.meta.description.trim() !== '',
      `locale/${locale}.json has no meta.description`)
  }
  const enMeta = JSON.stringify(JSON.parse(readFileSync(new URL('../locale/en.json', import.meta.url), 'utf8')))
  const cjk = enMeta.match(/[\u3400-\u9fff]/gu)
  assert.equal(cjk, null, `CJK in locale/en.json: ${cjk === null ? '' : cjk.join('')}`)
})
check('one card-language stylesheet covers both surfaces', () => {
  assert.ok(/const CSS = `/u.test(source), 'the shared stylesheet is missing')
  assert.ok(!/CSS_CARD|CSS_DIAG/u.test(source), 'the old per-card stylesheets survived')
  for (const selector of ['.dw7-card{', '.dw7-card-body{', '.dw7-group-title{', '.dw7-detail{', '.dw7-status-card{',
    '.dw7-status-body{', '.dw7-facts{', '.dw7-input{', '.dw7-save{', '.dw7-small{', '.dw7-code{', '.dw7-star-section{', '.dw7-star-line{']) {
    assert.ok(source.includes(selector), `the stylesheet does not define ${selector}`)
  }
  // The dsh-ops branch's card chrome: a 0.5px hairline on radius-lg with a shaded body,
  // 13px/600 group titles, and description-list labels sized to their own text.
  assert.ok(source.includes('border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg);padding:14px;gap:10px;'),
    'the card chrome no longer matches the dsh-ops card')
  assert.ok(source.includes('background:var(--dsw-alias-interactive-bg-hover);'),
    'the card body no longer uses the sunken surface')
  assert.ok(source.includes('font-size:13px;font-weight:600;line-height:20px;'),
    'the group title metrics no longer match the dsh-ops card')
  assert.ok(source.includes('grid-template-columns:max-content minmax(0,1fr);align-items:baseline;column-gap:14px;'),
    'the fact list no longer uses the native max-content label column')
  const start = source.indexOf('const CSS = `')
  const css = source.slice(start, source.indexOf('`', start + 20))
  assert.ok(!/#[0-9a-f]{3,8}\b/iu.test(css), 'the stylesheet hard-codes a color instead of using a theme token')
})

check('no metered-network copy or branch remains', () => {
  assert.ok(!/metered/iu.test(source), 'the removed metered-network feature still has copy or a branch')
})

check('every t() key the client asks for exists in all eight dictionaries', () => {
  const used = [...source.matchAll(/\bt\('([a-z0-9_]+)'/giu)].map((match) => match[1])
  assert.ok(used.length > 10, `only ${used.length} t() keys found — the extraction is probably wrong`)
  for (const key of new Set(used)) {
    for (const locale of LOCALES) {
      assert.ok(typeof dictionaries[locale][key] === 'string', `${key} is missing from the ${locale} dictionary`)
    }
  }
})

storeCalls.length = 0
card({ view: 'page' })
const servedFirst = storeCalls.slice()
storeCalls.length = 0
card({ view: 'page' })
const servedSecond = storeCalls.slice()

check('the served-controller callbacks keep a stable identity too', () => {
  assert.ok(servedFirst.length > 0 && servedSecond.length > 0, 'the card never subscribed to a snapshot')
  assert.ok(Object.is(servedFirst[0].subscribe, servedSecond[0].subscribe),
    'subscribe changed identity between renders — React would re-subscribe on every render')
  assert.ok(Object.is(servedFirst[0].getSnapshot(), servedFirst[0].getSnapshot()),
    'getSnapshot returned a fresh object — React would re-render forever')
})

// --- The Remote flow: the only path that talks to the Host ---------------------------------
// Nothing drove it before — the stubs made effects and writes no-ops — so `refresh()` (mount the
// namespace, call the endpoint, unwrap the envelope, publish a snapshot) never executed here, and
// that is exactly where the client half meets the Host. The action's own onClick is the seam: it is
// what a user clicks.
const EXECUTOR_PATH = 'C:\\Users\\FXS\\AppData\\Local\\Microsoft\\WindowsApps\\pwsh.exe'
const allowGate = {
  state: 'allow',
  version: '7.6.9',
  path: EXECUTOR_PATH,
  source: 'shell',
  origin: 'store-alias',
  reasonCode: 'ok',
  at: 1790000000000,
}
let remoteAnswer = () => Promise.resolve({ ok: true, value: { report: 'HOST REPORT', gate: allowGate } })
const remoteCalls = []
const remoteCtx = {
  ...ctx,
  get: (key) => {
    if (key === 'remote') {
      return {
        $mount: (spec) => {
          remoteCalls.push(spec.package)
          return Promise.resolve({ mounted: true })
        },
      }
    }
    if (key === 'remote.dsh-win-pwsh7') {
      return {
        status: () => {
          remoteCalls.push('status')
          return remoteAnswer()
        },
      }
    }
    return undefined
  },
}
const remoteBefore = registered.length
client.apply(remoteCtx)
const remoteParts = registered.slice(remoteBefore)
const remoteSection = remoteParts.find((item) => item.registration.name === 'plugins.detail.section'
  && item.registration.id === 'dsh-win-pwsh7.diagnostics')?.component
const remoteButton = elementsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }), 'button')[0]
assert.ok(remoteButton !== undefined, 'the re-detect action rendered no button')

remoteButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const readyTexts = textsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('the Remote flow mounts the namespace, calls the endpoint and renders the status facts', () => {
  assert.deepEqual(remoteCalls, ['dsh-win-pwsh7', 'status'], `the flow called ${remoteCalls.join(', ')}`)
  for (const expected of [
    dictionaries.zh.status_ready,
    'PowerShell 7.6.9',
    EXECUTOR_PATH,
    dictionaries.zh.status_lead_ready,
    dictionaries.zh.status_note_store,
  ]) {
    assert.ok(readyTexts.includes(expected), `the status card does not render "${expected}": ${readyTexts.join(' | ')}`)
  }
  assert.ok(!readyTexts.includes('HOST REPORT'),
    'the raw model-facing report still leaks into the status card')
  const facts = elementsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }), 'dd')
  assert.equal(facts.length, 3, `expected three status facts, found ${facts.length}`)
})

// A client half can briefly run against an older Host half: that Host answers only `report`.
remoteAnswer = () => Promise.resolve({ ok: true, value: { report: 'LEGACY REPORT' } })
remoteButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const legacyTexts = textsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('an older Host that answers only report still has a usable fallback', () => {
  assert.ok(legacyTexts.includes('LEGACY REPORT'),
    `the legacy report never reached the section: ${legacyTexts.join(' | ').slice(0, 200)}`)
})

// A failure report can carry both the network cause and a pasteable patch. The section has to
// expose both without making the user copy the prose by hand.
const deniedGate = {
  state: 'deny',
  version: undefined,
  path: undefined,
  source: 'rows',
  reasonCode: 'no-ps7',
  at: 1790000000000,
}
remoteAnswer = () => Promise.resolve({ ok: true, value: { report: [
  'PowerShell 7: not usable — no PowerShell 7 installation was found.',
  '',
  '- id: pwsh-sandbox',
  '  config:',
  "    pwshPath: 'C:\\\\Tools\\\\pwsh.exe'",
].join('\n'), gate: deniedGate } })
remoteButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const fixTexts = textsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('the diagnostics section exposes a copyable patch without shipping a log box', () => {
  assert.ok(fixTexts.includes(dictionaries.zh.patch_note), 'no guidance above the patch')
  assert.ok(fixTexts.includes(dictionaries.zh.copy_patch), 'no copy-patch button')
  assert.ok(fixTexts.some((text) => text.includes('pwshPath')), 'the patch text is missing')
  const blocks = elementsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }), 'pre')
  assert.equal(blocks.length, 1, `expected exactly the patch code block, found ${blocks.length}`)
  assert.equal(blocks[0].props.className, 'dw7-code')
})

remoteAnswer = () => Promise.resolve({ ok: false, error: { code: 'E-NOT-AVAILABLE', message: 'not mounted' } })
remoteButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const failedTexts = textsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('a failed Remote call is reported in the user language', () => {
  assert.ok(failedTexts.some((text) => text.startsWith('检测失败：')),
    `the failure was not localized: ${failedTexts.join(' | ').slice(0, 200)}`)
})

// --- Verdict ------------------------------------------------------------------------------

if (failures.length > 0) {
  console.error(`FAIL (${failures.length})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exitCode = 1
} else {
  // The first application's count: the guard check above applies the client a second time on
  // purpose, and counting that would misreport how many contributions the half registers.
  console.log(`ok — client half: ${registeredBefore} contributions render from the dictionaries`)
}
