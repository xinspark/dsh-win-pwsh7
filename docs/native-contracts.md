# Native contracts

This file records the installed-DSH facts `dsh-win-pwsh7` relies on. It is evidence for the
shared-library rule **native first** (`exp-native-first`): read the distribution, cite the symbol,
and re-check after an upgrade. Line numbers belong to the build below; symbols are the durable part.

## Baseline

- DSH build: **0.2.2-rc.1** (every package below reports this version); desktop shell
  **2.0.22-next**, `app.asar` 237,037,363 bytes.
- Plugin baseline: **0.2.6** (`package.json` `dsh.verifiedAgainst`). 0.2.5 was verified against
  **0.2.1-rc.3 / rc.4**; the rc.4 → 0.2.2-rc.1 delta is what this file and
  `tools/check-native-contracts.mjs` cover.
- The plugin itself is installed from a tarball; this file is about the **harness**, not the plugin.

### Package-level reconciliation, 0.2.1-rc.4 → 0.2.2-rc.1

The delta is small and mostly structural:

- `dsh-tools/lib/index.js` is **split**: the tool pipeline moved out to `lib/pipeline.js`
  (entry file 3,810 → 665 lines; `lib/pipeline.js` is new, 948 lines). `ToolRuntime.guardReason`
  was renamed **`checkGuards`**, and `ToolRuntime.prepareExecution` is **gone** — the scheduler's
  `prepare()` now lives in `lib/pipeline.js`. The plugin never called either; only the gate did.
- `dsh-tool-pwsh/lib/index.js` is **byte-identical** to rc.4 (736 lines): the `pwsh` tool still
  executes through `ctx.shell.execute(...)` at call time, which is what the guard and the UTF-8
  bridge rely on.
- `dsh-pwsh-local/lib/index.js` adds exactly three lines: `PYTHONIOENCODING: "utf-8"` in
  `ENV_OVERRIDES`. `ENCODING_PREAMBLE` still only pins the .NET output encoding — **no `chcp`**, so
  the console code page is still 936 on a zh-CN machine and the transitional UTF-8 bridge stays.
- `dsh-shell`, `dsh-jobs`, `dsh-jobs-local`, `dsh-subprocess`, `dsh-scope` keep the same
  `lib/index.js` hashes as rc.4.

File counts and bytes are the package subtree inside `app.asar`; `lib/index.js sha256` is the first
16 hex characters of the file the contract was read from. Recompute them on the next upgrade
instead of trusting this table.

| Package | Version | Files / bytes | `lib/index.js` sha256(16) |
|---|---|---|---|
| dsh-tools | 0.2.2-rc.1 | 25 / 230,167 | `1889cbf718d64518` |
| dsh-pwsh-sandbox | 0.2.2-rc.1 | 14 / 34,827 | `bed19d2cea875b15` |
| dsh-tool-pwsh | 0.2.2-rc.1 | 14 / 71,485 | `157aa3964db76e64` |
| dsh-pwsh-local | 0.2.2-rc.1 | 14 / 45,363 | `6bea799112c6c282` |
| dsh-shell | 0.2.2-rc.1 | 6 / 29,547 | `6c5aa32fda2d92ef` |
| dsh-jobs | 0.2.2-rc.1 | 11 / 39,050 | `7a7531c2fb189760` |
| dsh-jobs-local | 0.2.2-rc.1 | 14 / 61,221 | `cecdc8a766f62b28` |
| dsh-config-editor | 0.2.2-rc.1 | 202 / 1,013,498 | `17e953c5ef913d36` |
| dsh-system-prompt | 0.2.2-rc.1 | 14 / 54,839 | `18b692b03bbb7175` |
| dsh-subprocess | 0.2.2-rc.1 | 7 / 35,059 | `0ea9e95a73639f9e` |
| dsh-agent | 0.2.2-rc.1 | 22 / 119,947 | `8673b5cfadfbb6e6` |
| dsh-scope | 0.2.2-rc.1 | 6 / 28,282 | `2829df71d76e0894` |

`dsh-tools/lib/pipeline.js` (34,464 bytes) sha256(16) = `f6c850cefce30831`. It did not exist in
rc.4; the contract below cites its symbols, not this hash.

## Contracts the plugin relies on

| Fact | Symbol and evidence | Behavior verified | Used by |
|---|---|---|---|
| The `pwsh` tool is registered under that exact name and executes through `ctx.shell` | `dsh-tool-pwsh/lib/index.js:465-466` `defineTool({ name: "pwsh" })`; `:628` `execute`; `:649/660/672` `ctx.shell.resolve/execute`; exports `name = "tool-pwsh"`, `inject` includes `tools`, `shell`, `systemPrompt` | A global guard on `exec.name === "pwsh"` sees the call; the path the tool spawns is the executor's resolved path | gate |
| The exact executable the pwsh tool will spawn | `dsh-pwsh-local/lib/index.js:154-161` `PwshLocalExecutor.pwshPath` getter; `:197-205` `argv()` uses it; `dsh-pwsh-sandbox/lib/index.js:118` `SandboxPwshExecutor extends PwshLocalExecutor`; `dsh-shell/lib/index.js:83-93` the `shell` service | `ctx.get('shell').pwshPath` is the live resolved path; reading the getter re-resolves when the declared config changes | gate / report |
| The executor caches the resolved path | `dsh-pwsh-local/lib/index.js` fields `declaredPwshPath` / `resolvedPwshPath`; getter only re-resolves when the declared value differs | An install performed while the host runs leaves the cached 5.1 path; writing a sentinel into `declaredPwshPath` forces the same getter to re-run the resolver. Feature-detected; without the fields the report prints pin + reload | install / status |
| A configured `pwshPath` is trusted as-is | `dsh-pwsh-local/lib/index.js:59-65` `resolvePwshPath`: a non-empty configured value is returned before any existence check | A pin pointing at a missing file fails at spawn; there is no fallback to 5.1 | config guidance |
| Default resolution order | `dsh-pwsh-local/lib/index.js:23-34` `candidatePwshPaths`; `:42-49` `candidateExists` | `%ProgramFiles%\PowerShell\7\pwsh.exe` → every PATH entry → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; a file or a reparse point qualifies | detection |
| Guards are global, synchronous, monotonic, and deny with a reason | `dsh-tools/lib/index.js:649` `guard`; `:657` `checkGuards` returns the first denial reason (0.2.1 exposed it as `guardReason`; 0.2.2 renamed it and removed `ToolRuntime.prepareExecution`); `:453-467` `restrict` requires an agent scope; `dsh-tools/lib/pipeline.js:402` reads the guards, `:404-418` materializes `content: [{type: "text", text: \`Error: <reason>\`}]`, `isError: true`, `error.message = reason` | A plain-context guard covers every agent; no later guard can force-allow; the model sees the reason as the tool error | gate |
| `tools/pre-execute` runs before guards | `dsh-tools/lib/pipeline.js:386` waterfall, then `:402` `checkGuards` | An async listener can refresh the gate for `pwsh` before the synchronous guard reads it | gate freshness |
| The install job handle exposes `append` and `updateProgress` | `dsh-jobs-local/lib/index.js:412-439`: `start(spec)` validates kind/label, builds `handle = { append, updateProgress }`, calls `spec.run(handle)` | The existing install job spec is compatible; `jobs.start` requires a job controller for the owner | install job |
| `configEditor.entries()` only exposes `include`-owned rows | `dsh-config-editor/lib/index.js:30-35` filters `entry.parent.tree.ctx.fiber.entry?.id === "include"`; `:69-135` `edit` writes the profile patch | A Desktop-generated live executor row may not be addressable; scanning rows is not a reliable "what runs" source | report / config guidance |
| The pwsh prompt section has a stable placement | `dsh-system-prompt/lib/index.js:10-43`, `TOOL_PWSH: 1010`; `SystemPrompt.getSectionOrder` | `getSectionOrder('TOOL_PWSH')` is the right anchor for `tool:pwsh-runtime` | prompt |
| Client slots used by the page still exist | live `Slots.listSubTree`: `plugins.row.config` (key `dsh-win-pwsh7#win-pwsh7`), `plugins.detail.section` (`dsh-win-pwsh7.diagnostics`, order 50) | The detail page and configure section remain registered; the Re-detect button renders inside the diagnostics section, and `plugins.detail.actions` is no longer used by this plugin | client |

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
6. **The executor's path cache needs a nudge after an install.** `pwsh7_status` must not call a
   cached 5.1 executor "native" just because the standalone resolver now finds a Store alias; the
   install and status paths force the getter to re-resolve, and fall back to pin + reload when the
   cache fields are absent.

## Re-verification

```powershell
$env:DSH_APP_DIR = 'E:\FXS\APP\DSH NEXT\resources\app.asar'   # install root, resources/app, or app.asar
node tools/check-native-contracts.mjs
```

On an upgrade: rerun the gate, recompute the package table, and update the baseline only after the
gate is green. Do not claim a build is verified against a DSH version the gate has not seen.

## Known limits

- The rc.4 → 0.2.2-rc.1 snapshot lives in this file (the delta section above). The rc.2 → rc.3
  table was not kept; if a future upgrade needs an older baseline, capture the current table first.
- The client slot names are checked against the live page, not by this gate; the client half's own
  gate covers its registrations. A slot rename remains a release-time inspection item.
- `engines.dsh` is a second gate on the same upgrade: the loader **skips a bundle whose range the
  running build does not satisfy, and prints nothing**. `tools/check-host.mjs` asserts the range
  ends at the next minor (`<X.<minor+1>.0-0`), because a bound on the next patch's prerelease
  silently uninstalls the plugin after every DSH patch release.
