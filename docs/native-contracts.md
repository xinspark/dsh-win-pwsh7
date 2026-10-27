# Native contracts

This file records the installed-DSH facts `dsh-win-pwsh7` relies on. It is evidence for the
shared-library rule **native first** (`exp-native-first`): read the distribution, cite the symbol,
and re-check after an upgrade. Line numbers belong to the build below; symbols are the durable part.

## Baseline

- DSH build: **0.2.1-rc.3** (every package below reports this version).
- Plugin baseline: **0.12.3** (verified by its author against desktop 0.2.1-rc.2; the rc.3 delta is
  what this file and `tools/check-native-contracts.mjs` cover).
- `app.asar`: 21,021 files.
- The plugin itself is installed from a tarball; this file is about the **harness**, not the plugin.

### Package-level reconciliation

File counts and bytes are the package subtree inside `app.asar`; `lib/index.js sha256` is the first
16 hex characters of the file the contract was read from. Recompute them on the next upgrade
instead of trusting this table.

| Package | Version | Files / bytes | `lib/index.js` sha256(16) |
|---|---|---|---|
| dsh-tools | 0.2.1-rc.3 | 18 / 424,851 | `1e53932e7c4213ea` |
| dsh-pwsh-sandbox | 0.2.1-rc.3 | 8 / 33,698 | `bed19d2cea875b15` |
| dsh-tool-pwsh | 0.2.1-rc.3 | 8 / 70,674 | `94c7f68c425e62c8` |
| dsh-pwsh-local | 0.2.1-rc.3 | 6 / 43,963 | `8b7b57eb7f6c597c` |
| dsh-shell | 0.2.1-rc.3 | 6 / 29,547 | `6c5aa32fda2d92ef` |
| dsh-jobs | 0.2.1-rc.3 | 11 / 39,050 | `7a7531c2fb189760` |
| dsh-jobs-local | 0.2.1-rc.3 | 8 / 60,093 | `cecdc8a766f62b28` |
| dsh-config-editor | 0.2.1-rc.3 | 196 / 1,012,356 | `373e05c8250d25dd` |
| dsh-system-prompt | 0.2.1-rc.3 | 8 / 52,411 | `7be9f7aafbf345d0` |
| dsh-subprocess | 0.2.1-rc.3 | 7 / 35,059 | `0ea9e95a73639f9e` |
| dsh-agent | 0.2.1-rc.3 | 16 / 104,700 | `7b59cf82c2784c25` |
| dsh-scope | 0.2.1-rc.3 | 6 / 28,282 | `2829df71d76e0894` |

## Contracts the plugin relies on

| Fact | Symbol and evidence | Behavior verified | Used by |
|---|---|---|---|
| The `pwsh` tool is registered under that exact name and executes through `ctx.shell` | `dsh-tool-pwsh/lib/index.js:465-466` `defineTool({ name: "pwsh" })`; `:628` `execute`; `:649/660/672` `ctx.shell.resolve/execute`; exports `name = "tool-pwsh"`, `inject` includes `tools`, `shell`, `systemPrompt` | A global guard on `exec.name === "pwsh"` sees the call; the path the tool spawns is the executor's resolved path | gate |
| The exact executable the pwsh tool will spawn | `dsh-pwsh-local/lib/index.js:154-161` `PwshLocalExecutor.pwshPath` getter; `:197-205` `argv()` uses it; `dsh-pwsh-sandbox/lib/index.js:118` `SandboxPwshExecutor extends PwshLocalExecutor`; `dsh-shell/lib/index.js:83-93` the `shell` service | `ctx.get('shell').pwshPath` is the live resolved path; reading the getter re-resolves when the declared config changes | gate / report |
| A configured `pwshPath` is trusted as-is | `dsh-pwsh-local/lib/index.js:59-65` `resolvePwshPath`: a non-empty configured value is returned before any existence check | A pin pointing at a missing file fails at spawn; there is no fallback to 5.1 | config guidance |
| Default resolution order | `dsh-pwsh-local/lib/index.js:23-34` `candidatePwshPaths`; `:42-49` `candidateExists` | `%ProgramFiles%\PowerShell\7\pwsh.exe` → every PATH entry → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; a file or a reparse point qualifies | detection |
| Guards are global, synchronous, monotonic, and deny with a reason | `dsh-tools/lib/types/index.js:531` `guard`; `:535` `guardReason`; `:875` `prepareExecution`; `:896-907` materializes `content: "Error: <reason>"`, `isError: true`, `error.message = reason`; `:497-500` `restrict` requires an agent scope | A plain-context guard covers every agent; no later guard can force-allow; the model sees the reason as the tool error | gate |
| `tools/pre-execute` runs before guards | `dsh-tools/lib/types/index.js:885` waterfall, then `:896` `guardReason` | An async listener can refresh the gate for `pwsh` before the synchronous guard reads it | gate freshness |
| The install job handle exposes `append` and `updateProgress` | `dsh-jobs-local/lib/index.js:412-439`: `start(spec)` validates kind/label, builds `handle = { append, updateProgress }`, calls `spec.run(handle)` | The existing install job spec is compatible; `jobs.start` requires a job controller for the owner | install job |
| `configEditor.entries()` only exposes `include`-owned rows | `dsh-config-editor/lib/index.js:30-35` filters `entry.parent.tree.ctx.fiber.entry?.id === "include"`; `:69-135` `edit` writes the profile patch | A Desktop-generated live executor row may not be addressable; scanning rows is not a reliable "what runs" source | report / config guidance |
| The pwsh prompt section has a stable placement | `dsh-system-prompt/lib/index.js:10-43`, `TOOL_PWSH: 1010`; `SystemPrompt.getSectionOrder` | `getSectionOrder('TOOL_PWSH')` is the right anchor for `tool:pwsh-runtime` | prompt |
| Client slots used by the page still exist | live `Slots.listSubTree`: `plugins.row.config` (key `dsh-win-pwsh7#win-pwsh7`), `plugins.detail.section` (`dsh-win-pwsh7.diagnostics`, order 50), `plugins.detail.actions` (`dsh-win-pwsh7.redetect`, order 50) | The detail page, config card and Re-detect button remain registered; additions must not replace them | client |

## Findings that changed the plan

1. **The gate reads `ctx.shell.pwshPath`, not a reconstruction from `configEditor.entries()`.**
   The executor itself resolves the path; `dsh-tool-pwsh` then uses `ctx.shell`. Reconstructing from
   rows misses the Desktop-generated live row and can disagree with the tool.
2. **`pwshPath` is a `PwshLocalExecutor` getter, not part of the `ShellExecutor` abstract type.**
   The plugin must feature-detect it and fall back to `shell.config.pwshPath.get()` +
   `resolvePwshPath()`, then to the default resolver. `check-native-contracts.mjs` guards the getter.
3. **`restrict` is the wrong mechanism for this requirement.** It requires an agent scope and hides
   the tool; the chosen behavior is call-time denial, which is `guard`.
4. **Config guidance is copy-paste, not a write.** `ConfigEditor.edit` exists, but the plugin must not
   write `pwshPath` or the user's profile patch; the current value is used only to render the patch.
5. **The prompt section order is 1010, not a guessed value.** Use `getSectionOrder('TOOL_PWSH')`.

## Re-verification

```powershell
$env:DSH_APP_DIR = 'E:\FXS\APP\DSH NEXT\resources\app.asar'   # install root, resources/app, or app.asar
npm run check:contracts
```

On an upgrade: rerun the gate, recompute the package table, and update the baseline only after the
gate is green. Do not claim a build is verified against a DSH version the gate has not seen.

## Known limits

- The network-cost check (`NetworkCostType` through Windows PowerShell 5.1 + WinRT) is a **plugin
  gap-fill**: DSH has no network-cost service. It is documented here as L2, not as a native fact.
- The rc.2 → rc.3 delta has no per-package snapshot in this repository; the table is the rc.3
  baseline. If a future upgrade needs the delta, capture the previous table before bumping.
- The client slot names are checked against the live page, not by this gate; the client half's own
  gate covers its registrations. A slot rename remains a release-time inspection item.
