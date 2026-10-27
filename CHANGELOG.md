# Changelog

## 0.16.3 — link the dsh-ops companion

- The completed script-install recommendation now includes the companion repository link:
  https://github.com/T-Auto/dsh-ops.
- Both READMEs link the same repository.

## 0.16.2 — recommend the companion only after the script install completes

- 0.16.1 appended the dsh-ops recommendation to every healthy `pwsh7_status` report. That was too
  broad: the request is a **one-time recommendation to the model after the script install
  completes**.
- The recommendation now appears only in the successful Store-UI job verdict, after the runtime is
  detected. `pwsh7_status`, manual installs, and the plugin page do not advertise it.
- READMEs and the host gate assert the narrower behavior.

## 0.16.1 — recommend dsh-ops after a working runtime appears

- `pwsh7_status` appends a companion recommendation once a usable PowerShell 7 is detected, and a
  successful Store-UI install includes it in the job verdict: **dsh-ops** — native file/PTC tools
  plus Windows host PowerShell integration — pairs well with this plugin. It is explicitly not
  installed automatically; the suggested command is
  `dsh plugin --profile <profile> add dsh-ops`.
- Both READMEs document the recommendation.
- Host gate asserts a healthy status report names `dsh-ops` and says it is not installed
  automatically.

## 0.16.0 — no startup auto-install, three-failure breaker

- **`installIfMissing` is gone.** The config field, its activation branch, the install-attempt report
  text and the client switch are removed. Starting the Host only detects and reports; installing is
  always an explicit `pwsh7_install` (or the manual Win+R path). This also removes the old winget
  startup route, so the only user-facing install methods are script install and manual install.
- **Three-failure breaker, per Host process.** Consecutive failed script installs are counted
  (exit 2/3/4/5 and job/spawn errors; a started-but-not-yet-installed click does not count). After
  3, `pwsh7_install` starts no job: it asks the user to check the network/VPN, and only accepts
  `userConfirmedFixed: true` after the user explicitly says it is fixed. That resets the counter and
  allows one retry; three more failures open the breaker again. Success and an already-installed
  runtime reset it. The failure text now begins by asking whether a VPN is active.
- **Tool schema** gains `userConfirmedFixed`; the block is enforced before the VPN confirmation, so
  repeating `vpnOffConfirmed: true` cannot bypass it.
- **Docs** rewritten to the current behavior: two install paths, VPN confirmation, Store notice,
  breaker, no metered preflight, three gates, no `installIfMissing`.
- **Tests.** Host gate covers the breaker/no-job path and the explicit-fix reset; activation must
  not start an install; client gate no longer expects the removed switch; all old config-driven
  install tests use `method: 'store'` internally.

## 0.15.1 — the Store script survives 5.1 encoding, and only two install paths

The 0.15.0 Store-UI script failed before opening the page with a parser error, not a VPN problem:
Windows PowerShell 5.1 decoded the inline text in the host's ANSI code page, and characters inside
the Chinese notice string became illegal tokens.

- **The script is a UTF-8 BOM file, not inline text.** `spawnStoreUi` writes it to a temporary
  `.ps1` with a BOM and launches `powershell.exe -File`; 5.1 reads BOM-prefixed files as UTF-8
  regardless of the console code page. The temporary directory is removed when the job settles.
- **Smart quotes are gone.** The Store notice uses 「安装」/「取消」 instead of curly quotes, which
  PowerShell 7 itself treats as string delimiters. The generated script now parses under both
  Windows PowerShell 5.1 and PowerShell 7.
- **Only two install paths are exposed.** The `pwsh7_install` schema no longer has a `method`
  parameter and the status/report text no longer offers a winget command: the tool is the script
  install (open Store, notice, click Install), and the other path is manual Win+R. The manual
  instructions remain in every report and failure message.
- **Tests.** The host gate still drives the Store-UI click/failure jobs and no longer expects a
  winget command in the report.

## 0.15.0 — VPN confirmation, Store notice, no metered probe, no context injection

The 2026-10-27 run exposed three usability gaps around the Store-UI install and one unnecessary
mechanism: the model could start an install without asking about the VPN; the Store window could be
closed because nothing explained it; the metered preflight was no longer relevant to the manual
Store page; and the injected status note was unwanted.

- **VPN is now a question, not a probe.** `pwsh7_install` requires `vpnOffConfirmed: true`. Without
  it the tool starts nothing and returns: ask the user whether a VPN is active, have them
  disconnect it and restart Microsoft Store, then call again. There is no adapter/default-route
  detection anywhere.
- **The Store window explains itself.** Before opening the page, the UI script shows a modal
  `MessageBox`: dsh-win-pwsh7 is about to open Microsoft Store and click Install; do not close the
  Store window; if a VPN is active, cancel, disconnect it, fully quit/restart Store, then retry.
  Closing the notice with Cancel exits cleanly and the job reports "cancelled at the Store notice".
- **Metered/network preflight removed.** `METERED_COST`, `NETWORK_COST_SCRIPT`, `networkCost`,
  `networkWarning`, the metered status warning and the install preflight are gone. `store-ui` is
  the manual Store page, where the metered queue behaviour does not apply; `method: 'store'` keeps
  the winget job but no longer probes the connection.
- **Context injection removed.** `agent.inject`, `createUserMessage`, the settled-state note and the
  related contract check are gone; the job output and `pwsh7_status` remain the sources of truth.
- **Tests.** The host gate asserts the confirmation gate starts no job, a store-ui click job, a
  page-not-loaded failure with VPN/manual guidance, and no network preflight; the probe environment
  stays isolated from the host's real PowerShell.

## 0.14.0 — open the Store page and click Install

The 2026-10-27 test proved that the manual Store page is the path that works, and that a script can
open it and invoke the same Install button with Windows UI Automation. `pwsh7_install` now defaults
to that route; winget remains available as `method: 'store'`.

- **`store-ui` (default).** It opens
  `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D`, waits up to 90 seconds for the Store window, then
  invokes the localized Install / 获取 / Get / 更新 / Update button through `UIAutomationClient` and
  falls back to `LegacyIAccessiblePattern`. This is the same Store page and button a human uses.
- **A click is not a failed install.** The job reports "Store page opened and Install was clicked —
  downloading/installing in the background", tells the model not to retry, and asks it to poll
  `pwsh7_status`; a runtime found within the bounded re-check is reported as installed.
- **Page-load failure asks about the VPN.** If no Install button appears within the timeout — or the
  page cannot be opened/invoked — the report says the Store page did not load, and tells the user:
  disconnect any VPN, fully quit and restart Microsoft Store, then retry; manual Win+R steps remain.
- **VPN auto-detection is gone.** The 0.13.4 adapter/default-route heuristic was removed; the
  network probe is back to `<cost>|<profile>` and the only automatic connection gate is metering.
  The VPN question is asked only when the Store page fails to load, as the user requested.
- **`store` remains.** `pwsh7_install` with `method: 'store'` runs the existing winget background job
  with its queue hints and 30-second polling guidance.
- **Tests.** The host gate drives a successful Store-UI click, a page-not-loaded failure with VPN
  and manual guidance, and keeps all winget tests on `method: 'store'`; the probe environment is
  isolated from the host's real PowerShell so the gate is reproducible with PowerShell 7 installed.

## 0.13.4 — configure-it guidance, manual Store steps, VPN preflight

Two gaps from the 2026-10-27 run: the blocked `pwsh` call mentioned install and disable but not the
case where PowerShell 7 is already installed and only needs wiring, and the automatic install was
also blocked by an active VPN while the plugin only understood metering.

- **The denial and status now offer three ways.** When a usable PowerShell 7 is detectable, the
  first answer is "configure the executor": call `pwsh7_status` for the exact
  `pwsh-sandbox.pwshPath` patch, apply it to the active profile and reload DSH. Installing
  (`pwsh7_install` or manual) and disabling stay available. The status report says
  "Three ways forward" with the same split.
- **Manual Store install is spelled out.** Every install path prints:
  press Win+R, paste `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D`, press Enter; outside a VPN the
  Store page for PowerShell 7 opens — click Install. A manual install is auto-detected; no pin.
  (The product id in the text is generated from `STORE_PRODUCT_ID`.)
- **VPN is detected and intercepted.** The Windows PowerShell 5.1 probe now also inspects active
  adapters whose name/description match common VPN/TUN clients, a default route through such an
  adapter, and `Get-VpnConnection`. A reading of `Unrestricted|<profile>|WireGuard` (or any active
  VPN) makes the install preflight refuse to start and returns: disconnect the VPN, fully quit and
  restart Microsoft Store, retry; or use the manual Store steps. `pwsh7_status` shows the same
  warning; a failed install re-checks and names the VPN if it appeared after the preflight.
  The adapter-name match is a heuristic — a false positive still leaves the manual Store install.
- **Tests.** The host gate asserts manual/configure text in the denial, a VPN preflight that starts
  no job and names the adapter, and the VPN status warning.

## 0.13.3 — queued Store, VPN, 30-second polling, context injection

The automatic Store download can sit in "Queued" indefinitely; the reports confirmed the cause is
the Store client/queue, not the plugin's preflight. This release makes that state actionable and
stops the model from waiting on one long `job_output` call.

- **The queue is a first-class recovery path.** The install start report, the 2-minute progress
  hint, and the failure verdict all say: pause/resume the PowerShell entry in Microsoft Store →
  Downloads/Library; if the Store itself is stuck, disable any VPN, fully quit and restart Microsoft
  Store; or install manually from `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D`. A manual Store
  install is detected automatically, no `pwshPath` pin.
- **The model is told to poll in 30-second rounds.** `pwsh7_install` now says
  `job_output(wait:true, timeout_ms:30000)` then `job_list`; a `wait aborted` is not an install
  failure. This is guidance for the model, not a change to the job's own 15-second progress tick.
- **The settled state is injected into the agent context.** When the background job finishes, the
  owning agent receives a short `agent.inject()` note (feature-detected): runtime now effective,
  install failed with the queue/VPN/manual options, or installed-but-still-pinned. The prompt
  section alone could not tell a model that stopped looking.
- **The queue hint names VPN.** The progress line after `Started MSStore package execution` now
  includes pause/resume, VPN off + restart Store, and the Windows Update pause check.
- **Tests.** The install start report carries the 30-second/`timeout_ms:30000`/VPN text; the
  settled failure injects a note into a stub agent.

## 0.13.2 — the Store handoff is named correctly

The 2026-10-27 work-exp reports showed the automatic install failing on a **non-metered**
connection while the plugin still told the user to turn metering off. The failure path now re-reads
the connection, translates the Store error codes, and offers the recovery that actually worked:
the Store entry was parked in "Queued", and pause → resume started the download.

- **Failure attribution re-reads the connection.** `installVerdict` calls `networkCost` again;
  metered advice appears only for `Fixed` / `Variable`. An unreadable cost is explicitly not
  attributed to metering.
- **Store error codes are translated.** `wingetFailureCode` normalizes decimal exit codes to
  `0x…`, and `describeWingetFailure` explains `0x80D03801` (download/deployment), `0x80004004`
  (E_ABORT) and `0x80072EFD` (WinHTTP 12029).
- **Non-metered failures point at the queue and the manual fallback.** The verdict says to open
  Microsoft Store → Downloads/Library, pause and resume a "Queued" PowerShell entry, check Windows
  Update is not paused, and gives `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D`. A manual Store
  install is detected automatically — no `pwshPath` pin is needed.
- **The handoff is visible in progress.** `Started MSStore package execution` is now a named phase;
  after `DSH_WIN_PWSH7_STORE_QUEUE_HINT_MS` (default 2 minutes) the progress line says the entry may
  be queued, and the stall line names both the queue and metering instead of only metering.
- **The gate stub formats `%s`** (OBS-01), so the host gate no longer prints the placeholder.
- **Tests.** A non-metered failure must not give metering advice; `0x80D03801` must be translated and
  keep the manual Store path; the metered preflight still starts no job.

## 0.13.1 — install, then actually usable

The 0.13.0 gate read the executor correctly but inherited the executor's own cache: `pwsh7_install`
could install PowerShell 7.6.9 while the running `PwshLocalExecutor` still resolved to 5.1, so the
tool stayed blocked and `pwsh7_status` could even answer "Nothing to configure". Both are fixed.

- **The install now nudges the executor cache.** `PwshLocalExecutor.pwshPath` re-resolves only when
  its declared config changes. After a successful install the plugin writes a sentinel into that
  cache and re-reads the getter, so the same running process resolves the new Store alias. No
  profile patch and no restart are needed when the concrete executor exposes the cache.
- **The nudge is feature-detected.** If a composition does not expose `declaredPwshPath` /
  `resolvedPwshPath`, the install report says so and prints the pin + reload patch instead of
  pretending the tool is ready. `tools/check-native-contracts.mjs` now guards both fields.
- **The status can no longer call a stale executor "native".** When the live executor still reports
  5.1, the report keeps the `running executor still resolves to Windows PowerShell 5.1` warning,
  prints the pin patch, and never says "Nothing to configure" just because the standalone resolver
  now finds a Store alias.
- **Failures that cannot be nudged are explicit.** `installVerdict` distinguishes "the running
  executor now resolves to 7.6.9" from "it still resolves to 5.1; pin pwsh-sandbox.pwshPath and
  reload DSH", so the user is not left with a contradictory success message.
- **The Re-detect button moved into the status section.** It used to sit in the detail page's
  head actions, away from the text it refreshes; it now renders beside the status title, where a
  reader looks for it. `plugins.detail.actions` no longer carries a second copy.
- **Tests.** A stale live 5.1 + resolver 7 case must not render "Nothing to configure"; a stubbed
  executor cache must be refreshed by the nudge; the contract gate asserts the cache fields exist;
  the client gate renders the section's own Re-detect and drives the Remote flow through it.

Measured against the 2026-10-27 work-exp report: install landed 7.6.9, the tool remained blocked
until a manual `pwsh-sandbox.pwshPath` pin, and status said "Nothing to configure" in the same
window. This release removes that manual step on the normal path and makes the fallback honest.

## 0.13.0 — enabled means gated

The plugin was observational: with only Windows PowerShell 5.1 it warned the model and let the
command run. This release makes the enabled state a contract. The model sees a call-time error
before dispatch, the user sees the install/configure/disable choices, and no PowerShell process is
started for a denied call.

- **The gate reads the executor, not a reconstruction.** `ctx.shell.pwshPath` is the exact
  executable `dsh-tool-pwsh` will spawn (`PwshLocalExecutor.argv()` uses it). The read
  feature-detects that concrete getter and falls back to `shell.config.pwshPath.get()` +
  `resolvePwshPath()`, then to the default resolver. `configEditor.entries()` only exposes
  `include`-owned rows, so a Desktop-generated live row could be missed; the report still lists the
  rows for diagnosis.
- **`ctx.tools.guard` denies `pwsh` before dispatch.** A per-context snapshot drives the guard; a
  `tools/pre-execute` listener refreshes it when the snapshot is unknown or older than
  `DSH_WIN_PWSH7_GATE_TTL_MS`, and `app-boot/config-reload` / `plugin-manager/changed` refresh it
  after profile changes. `pwsh7_status` and `pwsh7_install` are never gated.
- **The denial is self-contained.** It names the reason (5.1, broken pin, no PowerShell 7, unknown),
  says not to retry, and offers `pwsh7_status` (exact patch), `pwsh7_install` (after the user
  agrees), or disabling the plugin. The 5.1 prompt section now says the tool is blocked instead of
  advising the `;` workaround.
- **Install preflight.** `resolveWinget()` then `networkCost()`: the install starts only for
  `Unrestricted` with a readable profile. `Fixed` / `Variable` / `Unknown` / an unreadable probe /
  a missing winget returns a report naming the network and the setting to turn off, and registers
  **no job**. `installIfMissing` skips with the same reason instead of starting a doomed install.
- **Configuration guidance.** The report keeps the row's existing config fields (the `config` block
  is replaced wholesale), distinguishes add vs update, and states that `overridePath` only changes
  probing and recommendations — not executor wiring.
- **Client.** The diagnostics section derives a metered-network line and a fix block with the
  profile patch and a copy button from the report it already receives.
- **Native contracts.** `docs/native-contracts.md` records the 0.2.1-rc.3 package table and the
  symbols the plugin relies on; `tools/check-native-contracts.mjs` (36 checks over 12 packages)
  runs after the host and client gates and fails when a symbol or prototype disappears.
- **Tests.** Gate allow/deny, broken pin, own tools, pre-execute refresh, config reload, add/update
  patch, wholesale-config warning, overridePath-not-wiring, metered/unknown/no-winget starting no
  job, and the client's network line and copyable patch.

This is a breaking behavioral change for anyone who relied on the 5.1 fallback while the plugin was
enabled. Disabling the plugin restores the previous behavior; the plugin still never writes
`pwshPath` and never uninstalls PowerShell.

## 0.12.3 — the gates read the desktop build's nested harness

The desktop build (`DeepSeek Harness.exe` 0.2.1-rc.2) packs a different layout than 2.0.19-next: the
archive root carries only a shell — `dsh`, `node_modules`, `lib`, `package.json`, `renderer` — and its
`node_modules/@deepseek-ai` holds eight packages (cordis, cosmokit, dsh-api-gateway, dsh-brand,
dsh-deque, dsh-timeout, dsh-typert-protocol, schemastery), while all 306 harness packages sit under
`dsh/`. `0.12.2` accepted any root carrying `cordis`, so it picked the shell and the Host gate died
with `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-tools'`.

- **The harness is recognised by carrying both `cordis` and `dsh-tools`**, not `cordis` alone, and a
  root or its `dsh`/`app` subdirectory is searched for it — `harnessAt()` in
  `tools/dsh-app-modules.mjs`.
- **The unpack now also takes `dsh/`**, so a packed desktop archive yields `<cache>\dsh`, and the
  `note — the harness packages come from an asar archive, unpacked for this run into …` line names it.
- **A cache created by an older release is not trusted**: it is reused only when the full harness is
  inside it, so upgrading the plugin repairs the stale unpack instead of failing again.
- **Measured**: new desktop install 30 s cold / 6 s cached, previous 2.0.19-next install 6 s cached,
  both gates green; no installation at all still prints the actionable note and exits 1.
- **The READMEs now describe all three layouts** and the "Releasing" sections explain that the tag
  publishes through CI (trusted publishing, OIDC) and that provenance requires `repository.url` to be
  byte-identical to the GitHub context.

## 0.12.2 — the gates read a packed DSH 2.0 install

DSH 2.0.19-next ships its packages inside `resources/app.asar`, and the Host gate could not find them
there: Node resolves nothing inside an archive, and the sibling `app.asar.unpacked` holds only five
packages (cordis is not among them), so the run ended in
`ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/cordis'`. The plugin's own halves were never
affected — both load and run on 2.0.19-next — but nobody could re-run the gates on a 2.0 machine,
which is exactly when they are wanted.

- **`tools/dsh-app-modules.mjs` (new)** resolves the harness: `DSH_APP_DIR` first, then the nearest
  ancestor of the tools directory or the working directory that carries
  `node_modules/@deepseek-ai/cordis`. `DSH_APP_DIR` now accepts an install root, `resources/app`
  (an unpacked install), or `resources/app.asar` (a packed one).
- **A packed installation is unpacked once** into `%TEMP%\dsh-app-modules-<archive>-<size>-<mtime>` —
  only `node_modules` and `package.json`, staged under `<cache>.<pid>` and renamed into place, reused
  by later runs. Unpacking the real tree instead of re-implementing Node's resolution over the archive
  is deliberate: a hand-written resolver can disagree with Node on `exports` maps, conditions, and
  CJS/ESM, and that disagreement would show up as a green gate that proves nothing.
- **The hook and the Host gate use it**, and the gate says where the packages came from. A machine
  with no installation at all still fails the gate — with one actionable line naming the three
  accepted hand-offs, instead of a bare `ERR_MODULE_NOT_FOUND`.
- **Measured on 2.0.19-next**: 38 s cold (the unpack is most of it), 6 s on the cached second run,
  both gates green.

## 0.12.1 — first public release

`dsh-win-pwsh7` puts a real PowerShell 7 under the Harness `pwsh` tool on Windows. This is the first
release published outside its author's machine, and it is the behaviour the README documents:

- **Detection and reporting** — `pwsh7_status` reads the executor rows, validates an explicit path,
  refuses a version-numbered Store path as un-pinnable, and prints a pasteable profile patch for the
  version-stable Store family alias.
- **One install path** — `pwsh7_install` installs the Microsoft Store package as a background job.
  It reads the connection cost first, because Windows defers Store downloads on a connection marked
  as metered, and the remedy it offers is that setting — never a second installer. When PowerShell 7
  is not wanted at all, the other answer is to disable the plugin.
- **A failed exit is evidence, not a verdict** — the runtime is re-probed before a failure is
  reported, because the Store can finish an install after winget has already exited non-zero.
- **Progress that is measured** — the job follows winget's own diagnostic log for named phases
  (downloading, deploying, registering) and measures the installer download from the bytes on disk,
  because winget reports no numeric progress of its own.
- **A prompt section** — the model is told which PowerShell the executor actually runs, so it knows
  whether `&&` and `||` work before it writes a command.
- **Two offline gates** under `tools/`, shipped with the package so anyone can re-run them. They run
  unconditionally — the behaviour half is fixture-pinned (`PATH`, `LOCALAPPDATA`, `ProgramFiles`)
  rather than skipped on a machine that has the per-machine MSI — they cover job cancellation and
  both inline install fallbacks, and every assertion has been shown to fail under a deliberate
  mutation.
- **Reviewed independently before release** — three Open Code Review passes, 36 findings triaged.
  30 were confirmed and fixed. The material ones: a gate that silently skipped half its checks; all
  inline install paths taking a single-shot verdict instead of the bounded re-probe; a stall warning
  that had become unreachable; a cancelled job that kept working (twice — the re-probe loop was the
  second half); an activation-time install that reported nothing because it waited forever; a report
  that could name a disabled row as the runtime. 4 findings were refuted with citations (the harness's
  own schema dialect, the ecosystem's client descriptor shape, the optional `jobs` service, and the
  string-error envelope), and 1 is recorded as backlog: the module-level state a second application
  in one process would share.
- **Confirmed on the machine that found it** — the "a disabled row is never named as the runtime" fix
  is not theoretical. This profile carries `pwsh-sandbox` (disabled) beside
  `desktop-windows-pwsh-sandbox` (enabled), both pinning the same Store family alias; the report named
  the *disabled* row until the fix, and after the restart it names the enabled one instead.
