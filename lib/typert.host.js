// lib/typert.host.js — build-time typert contract for dsh-win-pwsh7.
// The official dsh-typert-loader reads this export (package.json declares exports["./typert"])
// and registers the invocations at boot, so the client half can call them over Remote.
// ⚠️ This file must stay free of bare-package imports: the loader imports it directly with
// `import(pathToFileURL(path))`, and link-installed plugins resolve no bare packages there.

const PACKAGE = 'dsh-win-pwsh7'

const ARGS_SYMBOL = PACKAGE + '/typert#EndpointArgs'
const RESULT_SYMBOL = PACKAGE + '/typert#JsonResult'

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === null || proto === Object.prototype
}

/** Results only reject cyclic references; dropped undefined fields match the official src-json path. */
function assertMarshalable(value, seen) {
  const marker = seen || new Set()
  if (value === null || typeof value !== 'object') return value
  if (marker.has(value)) throw new TypeError('cyclic RPC result')
  marker.add(value)
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) assertMarshalable(value[index], marker)
      return value
    }
    for (const key of Reflect.ownKeys(value)) assertMarshalable(value[key], marker)
    return value
  } finally {
    marker.delete(value)
  }
}

/** Args codec: strict + non-empty typeSymbol + create() — the loader's hard requirements. */
export function argsCodec() {
  return {
    mode: 'strict',
    typeSymbol: ARGS_SYMBOL,
    create: () => ({
      parse(value) {
        if (!isPlainObject(value)) throw new TypeError(PACKAGE + ': endpoint args must be a plain object')
        return value
      },
    }),
  }
}

/** Result codec: encode is mandatory — a strict codec without it skips the gateway's own result handling. */
export function resultCodec() {
  return {
    mode: 'strict',
    typeSymbol: RESULT_SYMBOL,
    create: () => ({ parse: (value) => assertMarshalable(value) }),
    encode: (value) => assertMarshalable(value),
  }
}

/**
 * One internal endpoint's InvocationDescriptor.
 * ⚠️ namespace must equal the package name: the client-side service key is `remote.<namespace>`.
 * @param packageName - the package the endpoint lands on.
 * @param endpoint - the endpoint (method) name.
 * @returns the descriptor.
 */
export function buildInvocation(packageName, endpoint) {
  return {
    id: packageName + '#' + packageName + '/' + endpoint,
    service: packageName,
    namespace: packageName,
    method: endpoint,
    invocation: { kind: 'direct' },
    parameters: [{ name: 'args', wire: 'args', source: 'json', codec: argsCodec() }],
    result: resultCodec(),
    sourceLocation: { file: 'lib/typert.host.js', line: 1, column: 1 },
  }
}

/**
 * The export the official loader reads (mod.TYPERT). `schemas` stays empty on purpose: every
 * endpoint here takes one plain JSON object and answers with the status report and its gate
 * snapshot, so there is no per-endpoint type document to publish — the codecs above are the whole
 * contract.
 */
export const TYPERT = {
  package: PACKAGE,
  face: 'host',
  schemas: [],
  invocations: ['status'].map((name) => buildInvocation(PACKAGE, name)),
  model: { services: [], events: [], objects: [] },
}

export default TYPERT
