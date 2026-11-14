# Native contracts

This file records the installed-DSH facts `dsh-win-pwsh7` relies on. It is evidence for the
shared-library rule **native first** (`exp-native-first`): read the distribution, cite the symbol,
and re-check after an upgrade. Line numbers belong to the build below; symbols are the durable part.
Public documentation starts at [docs/README.md](../README.md); the upgrade checklist is in
[version compatibility](compatibility.md).

## Baseline

- DSH build: **0.2.2-rc.3** (every package below reports this version); desktop shell
  **2.0.23-next**, `app.asar` 273,810,296 bytes.
- Plugin baseline: **0.2.10** (`package.json` `dsh.verifiedAgainst` = **0.2.2-rc.3**). 0.2.9
  shipped against **0.2.2-rc.1**; 0.2.6 loaded on that same build; 0.2.5 was verified against
  **0.2.1-rc.3 / rc.4**. The rc.1 → rc.3 re-check is what this file and
  `tools/check-native-contracts.mjs` now cover.
- The plugin itself is installed from a tarball; this file is about the **harness**, not the plugin.

### Package-level reconciliation, 0.2.2-rc.1 → 0.2.2-rc.3

The package subtrees now include source and README files, so file counts and bytes are not
comparable with the rc.1 table; hashes are:

- `dsh-pwsh-local`, `dsh-pwsh-sandbox`, `dsh-shell`, `dsh-config-editor` and `dsh-scope` keep the
  same `lib/index.js` hash. The executor, sandbox subclass, `ctx.shell` service, config editor and
  scope contracts are unchanged.
- `dsh-tools`, `dsh-tool-pwsh`, `dsh-jobs`, `dsh-jobs-local`, `dsh-system-prompt`,
  `dsh-subprocess` and `dsh-agent` changed, but every one of the 38 asserted symbols still passes;
  the contract rows below point at the rc.3 lines.
- `dsh-pwsh-local` still pins only the .NET output encoding — **no `chcp`**, so the console code
  page is still 936 on a zh-CN machine and the transitional UTF-8 bridge stays.
- `dsh-shell/lib/index.js` still exports the `ShellExecutor` service registered as `ctx.shell`
  (`:83`); the pwsh executor still subclasses it.

File counts and bytes are the package subtree inside `app.asar`; `lib/index.js sha256` is the first
16 hex characters of the file the contract was read from. Recompute them on the next upgrade
instead of trusting this table.

| Package | Version | Files / bytes | `lib/index.js` sha256(16) |
|---|---|---|---|
| dsh-tools | 0.2.2-rc.3 | 36 / 400,536 | `bf71a6ce1e95c5df` |
| dsh-pwsh-sandbox | 0.2.2-rc.3 | 16 / 49,139 | `bed19d2cea875b15` |
| dsh-tool-pwsh | 0.2.2-rc.3 | 17 / 120,098 | `03a29fb9cff98766` |
| dsh-pwsh-local | 0.2.2-rc.3 | 16 / 68,974 | `6bea799112c6c282` |
| dsh-shell | 0.2.2-rc.3 | 9 / 46,522 | `6c5aa32fda2d92ef` |
| dsh-jobs | 0.2.2-rc.3 | 18 / 73,886 | `5a211fa87fba8054` |
| dsh-jobs-local | 0.2.2-rc.3 | 18 / 105,943 | `8ff369369641d059` |
| dsh-config-editor | 0.2.2-rc.3 | 203 / 1,022,168 | `17e953c5ef913d36` |
| dsh-system-prompt | 0.2.2-rc.3 | 15 / 84,930 | `619c2f5d6291377e` |
| dsh-subprocess | 0.2.2-rc.3 | 11 / 66,435 | `04ae23eb9704bb8b` |
| dsh-agent | 0.2.2-rc.3 | 30 / 198,439 | `bc2a39dea1174c2b` |
| dsh-scope | 0.2.2-rc.3 | 8 / 44,483 | `2829df71d76e0894` |

`dsh-tools/lib/pipeline.js` (35,733 bytes) sha256(16) = `679072e59502fc21`. The contract below
cites its symbols, not this hash.

## Contracts the plugin relies on

| Fact | Symbol and evidence | Behavior verified | Used by |
|---|---|---|---|
| The `pwsh` tool is registered under that exact name and executes through `ctx.shell` | `dsh-tool-pwsh/lib/index.js:490-491` `defineTool({ name: "pwsh" })`; `:653` `execute`; `:674/685/697` `ctx.shell.resolve`; `:703` `ctx.shell.execute`; exports `name = "tool-pwsh"`, `inject` includes `tools`, `shell`, `systemPrompt` | A global guard on `exec.name === "pwsh"` sees the call; the path the tool spawns is the executor's resolved path | gate |
| The exact executable the pwsh tool will spawn | `dsh-pwsh-local/lib/index.js:157-163` `PwshLocalExecutor.pwshPath` getter; `:200-207` `argv()` uses it; `dsh-pwsh-sandbox/lib/index.js:118` `SandboxPwshExecutor extends PwshLocalExecutor`; `dsh-shell/lib/index.js:83` the `ShellExecutor` service registered as `ctx.shell` | `ctx.get('shell').pwshPath` is the live resolved path; reading the getter re-resolves when the declared config changes | gate / report |
| The executor caches the resolved path | `dsh-pwsh-local/lib/index.js` fields `declaredPwshPath` / `resolvedPwshPath`; getter only re-resolves when the declared value differs | An install performed while the host runs leaves the cached 5.1 path; writing a sentinel into `declaredPwshPath` forces the same getter to re-run the resolver. Feature-detected; without the fields the report prints pin + reload | install / status |
| A configured `pwshPath` is trusted as-is | `dsh-pwsh-local/lib/index.js:59-65` `resolvePwshPath`: a non-empty configured value is returned before any existence check | A pin pointing at a missing file fails at spawn; there is no fallback to 5.1 | config guidance |
| Default resolution order | `dsh-pwsh-local/lib/index.js:23-34` `candidatePwshPaths`; `:42-49` `candidateExists` | `%ProgramFiles%\PowerShell\7\pwsh.exe` → every PATH entry → `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`; a file or a reparse point qualifies | detection |
| Guards are global, synchronous, monotonic, and deny with a reason | `dsh-tools/lib/index.js:649` `guard`; `:657` `checkGuards` returns the first denial reason (0.2.1 exposed it as `guardReason`; 0.2.2 renamed it and removed `ToolRuntime.prepareExecution`); `:453-467` `restrict` requires an agent scope; `dsh-tools/lib/pipeline.js:402` reads the guards, `:404-418` materializes `content: [{type: "text", text: \`Error: <reason>\`}]`, `isError: true`, `error.message = reason` | A plain-context guard covers every agent; no later guard can force-allow; the model sees the reason as the tool error | gate |
| `tools/pre-execute` runs before guards | `dsh-tools/lib/pipeline.js:386` waterfall, then `:402` `checkGuards` | An async listener can refresh the gate for `pwsh` before the synchronous guard reads it | gate freshness |
| The install job handle exposes `append` and `updateProgress` | `dsh-jobs-local/lib/index.js:436-442`: `start` builds `handle = { append, updateProgress }`, calls `spec.run(handle)` | The existing install job spec is compatible; `jobs.start` requires a job controller for the owner | install job |
| `configEditor.entries()` only exposes `include`-owned rows | `dsh-config-editor/lib/index.js:31` filters `entry.parent.tree.ctx.fiber.entry?.id === "include"`; `:69` `edit` writes the profile patch | A Desktop-generated live executor row may not be addressable; scanning rows is not a reliable "what runs" source | report / config guidance |
| The pwsh prompt section has a stable placement | `dsh-system-prompt/lib/index.js:18` `TOOL_PWSH: 1010`; `:264` `SystemPrompt.getSectionOrder` | `getSectionOrder('TOOL_PWSH')` is the right anchor for `tool:pwsh-runtime` | prompt |
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

- The rc.1 → 0.2.2-rc.3 snapshot lives in this file (the delta section above). Older tables live in
  git history; capture the current table before the next baseline jump.
- The client slot names are checked against the live page, not by this gate; the client half's own
  gate covers its registrations. A slot rename remains a release-time inspection item.
- `engines.dsh` is a second gate on the same upgrade: the loader **skips a bundle whose range the
  running build does not satisfy, and prints nothing**. `tools/check-host.mjs` asserts the range
  ends at the next minor (`<X.<minor+1>.0-0`), because a bound on the next patch's prerelease
  silently uninstalls the plugin after every DSH patch release.
