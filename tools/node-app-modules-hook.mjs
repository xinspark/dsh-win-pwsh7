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
// When neither works, a bare import fails with a message that says which variable to set, instead
// of reporting a confusing "cannot find package".

import { existsSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { dirname, join, parse } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

/**
 * Node's own modules are bare specifiers too when written without the `node:` prefix
 * (`import 'fs'`), so they must never be re-parented to the installation.
 */
const BARE_BUILTINS = new Set(builtinModules)

/** The first ancestor of `start` that carries the harness packages, or `undefined`. */
function installationAbove(start) {
  let directory = start
  const root = parse(directory).root
  for (;;) {
    if (existsSync(join(directory, 'node_modules', '@deepseek-ai', 'cordis', 'package.json'))) {
      return directory
    }
    if (directory === root) return undefined
    directory = dirname(directory)
  }
}

const APP_DIR = process.env.DSH_APP_DIR
  ?? installationAbove(dirname(fileURLToPath(import.meta.url)))
  ?? installationAbove(process.cwd())

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
      `cannot resolve "${specifier}" for a standalone run: set DSH_APP_DIR to your DSH installation's ` +
      'resources/app directory (the one whose node_modules holds @deepseek-ai/cordis), or run this from ' +
      'inside that installation.',
    )
  }
  return nextResolve(specifier, { ...context, parentURL: PARENT_URL })
}
