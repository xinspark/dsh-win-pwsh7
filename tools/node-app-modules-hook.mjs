// A standalone `node` run has to resolve a plugin's bare imports the way the Host does. A plugin
// installed with `link:` sits outside the DSH installation and has no `node_modules` beside it:
// `@deepseek-ai/cordis`, `@deepseek-ai/dsh-tools`, … live in the installation, which the Host's own
// loader consults.
//
// This hook re-parents every bare specifier to that installation before Node's default resolution,
// so `node tools/check-host.mjs` loads the very same files the Host loads.
//
// The installation root is found in this order, and no path from the author's machine is baked in:
//   1. `DSH_APP_DIR` — the documented override, for an installation anywhere (including a `link:`ed
//      plugin, where the installation is not an ancestor of this file);
//   2. the nearest ancestor of this file, or of the working directory, that has
//      `node_modules/@deepseek-ai/cordis` — which is how a plugin installed *inside* an
//      installation (the npm layout) finds it with no configuration at all.
// `DSH_APP_DIR` may also point at a DSH 2.0 install root or at `resources/app.asar`; the packed
// shape is unpacked once into a temporary directory, because Node cannot resolve a path inside an
// asar archive. `./dsh-app-modules.mjs` owns that rule.
// When neither works, a bare import fails with a message that says which variable to set, instead
// of reporting a confusing "cannot find package".

import { builtinModules } from 'node:module'
import { pathToFileURL } from 'node:url'
import { resolveAppModulesDir } from './dsh-app-modules.mjs'

/**
 * Node's own modules are bare specifiers too when written without the `node:` prefix
 * (`import 'fs'`), so they must never be re-parented to the installation.
 */
const BARE_BUILTINS = new Set(builtinModules)

const APP_DIR = resolveAppModulesDir()

const PARENT_URL = APP_DIR === undefined
  ? undefined
  : pathToFileURL(/[\\/]$/u.test(APP_DIR) ? APP_DIR : `${APP_DIR}${process.platform === 'win32' ? '\\' : '/'}`).href

/**
 * Re-parent bare specifiers to the DSH installation.
 * @param specifier - the requested specifier.
 * @param context - the importer's resolution context.
 * @param nextResolve - Node's default resolution.
 * @returns the resolved module.
 */
export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.includes(':') || BARE_BUILTINS.has(specifier)) {
    return nextResolve(specifier, context)
  }
  if (PARENT_URL === undefined) {
    throw new Error(
      `cannot resolve "${specifier}" for a standalone run: set DSH_APP_DIR to your DSH installation — ` +
      'its install root, `resources/app` (unpacked builds), or `resources/app.asar` (DSH 2.0 and later) ' +
      '— or run this from inside that installation.',
    )
  }
  return nextResolve(specifier, { ...context, parentURL: PARENT_URL })
}
