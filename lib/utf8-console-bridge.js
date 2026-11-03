/**
 * Transitional Windows UTF-8 console bridge.
 *
 * The Host's `dsh-pwsh-local` collector decodes stdout as UTF-8, but a nested
 * `pwsh -File` / `powershell -File` started by a tool command inherits the console
 * code page (936 on a Simplified Chinese machine) and emits GBK. The Host preamble
 * only pins the .NET output encoding of the outer process; it does not change the
 * console code page. This module wraps the same `ctx.shell` executor the `pwsh` tool
 * uses and prepends `chcp.com 65001` so the code page is right before the command
 * runs.
 *
 * It is deliberately a leaf: no imports from the rest of the plugin, one mount in
 * `index.js`, one config field, and a documented removal contract. Delete this file,
 * the import/mount and the config field when the Host ships the same fix.
 *
 * REMOVE WHEN: the Host's `@deepseek-ai/dsh-pwsh-local` pins the console code page
 * itself (its `ENCODING_PREAMBLE` carries the `chcp.com 65001` switch), or a nested
 * `pwsh -File` under code page 936 already emits UTF-8 without this plugin. Follow
 * the README removal contract in the same change.
 */

/** One line of the wrapper's own diagnostics. */
const describe = (error) => (error instanceof Error ? error.message : String(error))

/** Marks an executor this module already wrapped, so HMR or a second mount cannot stack. */
export const UTF8_CONSOLE_PATCH = Symbol.for('dsh-win-pwsh7.utf8ConsoleBridge')

/** A command that already selects UTF-8 must not be prefixed twice. */
const ALREADY_UTF8 = /^\s*chcp(?:\.com)?\s+65001(?:\s|>|$)/iu

/**
 * Prefix a Windows command with the console code page switch.
 *
 * @param {unknown} command - the caller's command text.
 * @returns the command, prefixed once when it is a string and not already pinned.
 */
export function utf8Command(command) {
  if (typeof command !== 'string' || command.length === 0) return command
  if (ALREADY_UTF8.test(command)) return command
  return `chcp.com 65001 > $null; ${command}`
}

/**
 * Wrap the live shell executor the `pwsh` tool resolves.
 *
 * Fails open: a missing service, a non-writable executor or a shape change leaves
 * the plugin working exactly as before and logs one warning. The wrapper is removed
 * with the plugin's fiber; it never writes files, config or profile state.
 *
 * @param ctx - the row's Host context.
 * @param current - reads the live row configuration.
 * @param platform - injectable for tests; defaults to `process.platform`.
 * @returns void; the wrap is owned by the injected fiber.
 */
export function mountUtf8ConsoleBridge(ctx, current, platform = process.platform) {
  if (platform !== 'win32') return
  const warn = (message) => ctx.logger?.warn?.(`dsh-win-pwsh7: ${message}`)
  if (typeof ctx.inject !== 'function') return
  try {
    ctx.inject(['shell'], (scoped) => {
      try {
        const viaGet = typeof scoped.get === 'function' ? scoped.get('shell') : undefined
        const shell = viaGet ?? scoped.shell
        if (shell === undefined || shell === null) return
        if (shell[UTF8_CONSOLE_PATCH] === true) return
        const original = shell.execute
        if (typeof original !== 'function') {
          warn('the shell service exposes no execute(); the UTF-8 console bridge stays off')
          return
        }
        shell.execute = function executeWithUtf8Console(spec) {
          try {
            if (current?.()?.utf8Console === false) return original.call(this, spec)
            if (spec === null || typeof spec !== 'object' || typeof spec.command !== 'string') {
              return original.call(this, spec)
            }
            const command = utf8Command(spec.command)
            if (command === spec.command) return original.call(this, spec)
            return original.call(this, { ...spec, command })
          } catch (error) {
            warn(`the UTF-8 console bridge fell open: ${describe(error)}`)
            return original.call(this, spec)
          }
        }
        Object.defineProperty(shell, UTF8_CONSOLE_PATCH, { value: true, configurable: true })
        const restore = () => {
          try {
            shell.execute = original
          } catch { /* the executor was replaced by another owner */ }
          try {
            delete shell[UTF8_CONSOLE_PATCH]
          } catch { /* non-configurable; the marker is advisory */ }
        }
        if (typeof scoped.effect === 'function') {
          scoped.effect(() => restore, 'dsh-win-pwsh7: utf8 console bridge')
        }
      } catch (error) {
        warn(`the UTF-8 console bridge could not attach: ${describe(error)}`)
      }
    })
  } catch (error) {
    warn(`the UTF-8 console bridge could not inject the shell service: ${describe(error)}`)
  }
}
