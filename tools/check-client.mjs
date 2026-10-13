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

let dictionaries = { en: {}, zh: {} }
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
  value: { overridePath: '', installIfMissing: false },
  getSnapshot() {
    const key = `${this.status}|${this.writable}|${this.value.overridePath}|${this.value.installIfMissing}`
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
const card = componentFor('plugins.row.config')
const diagnostics = componentFor('plugins.detail.section')
const redetect = componentFor('plugins.detail.actions')

check('the client half registers all three contributions', () => {
  assert.deepEqual(registered.map((item) => item.registration.name), [
    'plugins.row.config',
    'plugins.detail.section',
    'plugins.detail.actions',
  ])
  assert.equal(registered[0].registration.key, 'dsh-win-pwsh7#win-pwsh7')
})

// --- The configure card -------------------------------------------------------------------

const cardTree = card({ view: 'page' })
const cardTexts = textsOf(cardTree)

check('the card renders its labels from the dictionaries, never as bare config keys', () => {
  for (const key of ['overridePath', 'installIfMissing']) {
    assert.ok(!cardTexts.includes(key),
      `the card rendered the bare config key "${key}" — a label was written as a literal instead of t()`)
  }
  for (const expected of [dictionaries.zh.field_overridePath, dictionaries.zh.field_installIfMissing]) {
    assert.ok(cardTexts.includes(expected), `the card does not render the label "${expected}"`)
  }
})
check('each field label also keeps its raw config key, so the form maps to cordis.patch.yml', () => {
  const labels = elementsOf(cardTree, 'label').map((element) => textsOf(element).join(''))
  assert.equal(labels.length, 2, `expected two labels, found ${labels.length}`)
  for (const [index, key] of ['overridePath', 'installIfMissing'].entries()) {
    assert.match(labels[index], new RegExp(key, 'u'), `label ${index} drops the raw key ${key}`)
    assert.match(labels[index], /[\u4e00-\u9fff]/u, `label ${index} is not localized: ${labels[index]}`)
  }
})
check('the card renders every hint in Chinese', () => {
  for (const hint of [dictionaries.zh.overridePath_hint, dictionaries.zh.installIfMissing_hint]) {
    assert.ok(cardTexts.includes(hint), `the card does not render the hint "${hint.slice(0, 24)}…"`)
  }
})
check('the switch is a real switch, not a styled button', () => {
  const [control] = elementsOf(cardTree, 'button').filter((element) => element.props.role === 'switch')
  assert.ok(control !== undefined, 'the installIfMissing control does not declare role="switch"')
  assert.equal(control.props['aria-checked'], false)
})
check('the summary view renders nothing, as the row list expects', () => {
  assert.equal(card({ view: 'summary' }), null)
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

const diagnosticsTexts = textsOf(diagnostics({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('the diagnostics section renders its localized title and idle text', () => {
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.diagnostics_title),
    'the diagnostics section does not render its title from the dictionary')
  assert.ok(diagnosticsTexts.includes(dictionaries.zh.status_empty),
    'the diagnostics section does not render its idle text from the dictionary')
})
check('the diagnostics section stays out of other plugins pages', () => {
  assert.equal(diagnostics({ subject: { pkg: 'some-other-plugin' } }), null)
})
check('the action renders the localized Re-detect label', () => {
  const texts = textsOf(redetect({ subject: { pkg: 'dsh-win-pwsh7' } }))
  assert.ok(texts.includes(dictionaries.zh.redetect), `the action does not render "${dictionaries.zh.redetect}"`)
})

// --- Copy hygiene -------------------------------------------------------------------------

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')
check('the en dictionary carries no Chinese', () => {
  const en = JSON.stringify(dictionaries.en)
  assert.ok(typeof en === 'string' && en.length > 200,
    `the en dictionary looks empty, so this check would pass vacuously: ${en}`)
  const cjk = en.match(/[\u4e00-\u9fff]/gu)
  assert.equal(cjk, null, `Chinese in the en dictionary: ${cjk === null ? '' : cjk.join('')}`)
})
check('both style blocks define the button, so it is styled wherever it renders', () => {
  for (const name of ['CSS_CARD', 'CSS_DIAG']) {
    const start = source.indexOf(`const ${name} = \``)
    const body = source.slice(start, source.indexOf('`', start + 20))
    assert.ok(start > 0 && /\.dw7-btn\{/u.test(body),
      `${name} does not define .dw7-btn, so a button rendered without the card is unstyled`)
  }
})

check('every t() key the client asks for exists in both dictionaries', () => {
  const used = [...source.matchAll(/\bt\('([a-z0-9_]+)'/giu)].map((match) => match[1])
  assert.ok(used.length > 10, `only ${used.length} t() keys found — the extraction is probably wrong`)
  for (const key of new Set(used)) {
    for (const locale of ['en', 'zh']) {
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
let remoteAnswer = () => Promise.resolve({ ok: true, value: { report: 'HOST REPORT' } })
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
const remoteAction = remoteParts.find((item) => item.registration.name === 'plugins.detail.actions')?.component
const remoteSection = remoteParts.find((item) => item.registration.name === 'plugins.detail.section')?.component
const remoteButton = elementsOf(remoteAction({ subject: { pkg: 'dsh-win-pwsh7' } }), 'button')[0]
assert.ok(remoteButton !== undefined, 'the re-detect action rendered no button')

remoteButton.props.onClick()
await new Promise((resolve) => setTimeout(resolve, 0))
const readyTexts = textsOf(remoteSection({ subject: { pkg: 'dsh-win-pwsh7' } }))

check('the Remote flow mounts the namespace, calls the endpoint and renders its report', () => {
  assert.deepEqual(remoteCalls, ['dsh-win-pwsh7', 'status'], `the flow called ${remoteCalls.join(', ')}`)
  assert.ok(readyTexts.includes('HOST REPORT'),
    `the report never reached the section: ${readyTexts.join(' | ').slice(0, 200)}`)
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
