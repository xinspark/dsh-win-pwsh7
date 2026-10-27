# dsh-win-pwsh7

<p align="center"><sub><a href="README.md">简体中文</a> · English</sub></p>

Puts a real **PowerShell 7** under the Harness `pwsh` tool on Windows, instead of silently
falling back to Windows PowerShell 5.1. Three legs, in priority order:

1. **Detect** the PowerShell 7 install on this machine (including an `overridePath` you set),
2. **Validate** any path you hand it (`pwsh7_status` takes an optional `path` argument),
3. **Install** PowerShell 7 from the Microsoft Store when you ask for it (`pwsh7_install`, or
   `installIfMissing: true`) — self-updating, with the connection checked first, because Windows
   defers Store downloads on a metered one. The other answer is to disable this plugin.

**It does not ship PowerShell, and it does not write configuration.** Installing is always
an explicit act (a tool you ask for, or a config key you set); it never uninstalls anything.

## 0.13.0: enabled means gated

While this plugin is enabled, the `pwsh` tool is allowed **only when the executor actually resolves
to PowerShell 7+**. Otherwise every call is denied by a global `ctx.tools.guard` before dispatch,
the model is told to report install / configure / disable, and **no PowerShell process starts**.
Disabling the plugin restores the default runtime; the plugin still never writes `pwshPath`.

- The reading comes from the executor's own `ctx.shell.pwshPath`, not from config rows;
  `overridePath` only changes probing and recommendations, **not executor wiring**.
- After an install the plugin first nudges the executor's cached `pwshPath`; only when that cache
  is unavailable does it print the pin + reload instruction.
- A failed automatic install no longer blames metering by default: it re-reads the connection,
  translates the Store error code, and on a non-metered connection points at the Store queue
  (pause → resume) and the manual Store page. A manual install is detected automatically; no pin
  is needed.
- The automatic download can sit in the Store's "Queued" state: the start report, the progress
  hint and the failure verdict all offer pause → resume, disable any VPN and fully restart
  Microsoft Store, and the manual Store page. Poll a job in **30-second rounds** with
  `job_output(wait:true, timeout_ms:30000)` + `job_list`; `wait aborted` is not a failure. The
  settled state is injected into the model context.
- Manual install is spelled out: press Win+R, paste
  `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D`, press Enter, click Install (outside a VPN). A
  manual install is detected automatically; no pin is needed.
- The install preflight is mandatory: winget present, an active network, and neither metered nor
  behind an active VPN. Metered / `Unknown` / a failed probe / no winget / VPN **start no install
  job** and name the network or adapter plus the setting to turn off. VPN detection is a
  name/default-route heuristic; a false positive still leaves the manual Store path.
- When the gate blocks, the answer has three paths: **configure** an installed PowerShell 7
  (`pwsh7_status` prints the `pwsh-sandbox.pwshPath` patch and reload), **install** (auto or
  manual), or disable the plugin.
- The Re-detect button lives beside the status title in the diagnostics section, not in the detail
  page's head actions.
- Configuration guidance prints a pasteable patch (add vs update, with a wholesale-`config`
  warning); `pwsh7_status` / `pwsh7_install` stay outside the gate as the recovery path.

## Installing this plugin

```powershell
# From GitHub (recommended: pinned to the tag, so a later push cannot change what is installed)
dsh plugin --profile desktop add github:XinSpark/dsh-win-pwsh7#v0.13.0
# replace `desktop` with the profile you use — `dsh plugin list` says which one that is
```

- **npm**: `dsh plugin --profile desktop add dsh-win-pwsh7` (or `npm i dsh-win-pwsh7` directly)
- **Local development**: `npm pack`, then `dsh plugin --profile desktop add file:<absolute path to the .tgz>`

Restart DSH afterwards, then check the runtime it reads on the plugin page (or by asking for
`pwsh7_status`). To wire the executor, paste the profile patch the report prints into
`~\.dsh\profiles\<profile>\cordis.patch.yml` and restart. **It never edits the executor's
`pwshPath` for you** — that is deliberate (see below).

This plugin is **pure JavaScript with no runtime dependencies**, for Windows: the host half only
does meaningful work there, and the client half is an ordinary web card.

## Why it is needed

The Desktop adapter resolves the PowerShell executable from well-known candidates plus
`PATH` entries:

1. `C:\Program Files\PowerShell\7\pwsh.exe`
2. every `PATH` entry (this is where a **Microsoft Store** install is found — through its
   execution alias)
3. `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe` (5.1)

On 5.1, `&&` and `||` are **parse errors**, so every command the model writes with `&&`
fails before it runs.

## Installing PowerShell 7: one path, and one alternative

[Microsoft's install article](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6)
names WinGet the recommended way to install PowerShell on Windows clients, and the Store
package's first listed benefit is **"Automatic updates built right into Windows"**. This plugin
offers exactly what that argument supports, and nothing else:

| path | what it is |
|---|---|
| **1. Install from the Microsoft Store** (the plugin's only install path) | `pwsh7_install` runs `winget install --id 9MZ1SNWT0N5D --source msstore` ([Store listing](https://apps.microsoft.com/detail/9mz1snwt0n5d)) as a background job. Self-updating, per-user, no elevation. On a connection marked metered Windows defers it — see below; the remedy is the connection setting, never another installer. |
| **2. Disable this plugin** | If PowerShell 7 is not wanted on this machine, turn the plugin off on its page. Its advice and its two tools stop, and nothing is installed. The `pwsh` tool keeps failing while an executor row pins a path that does not exist, so that is a decision about `pwsh` itself. |

There is **no `route` parameter** and no second installer in any model-facing text — tool
description, report, or prompt section. Two alternatives were measured and rejected during
development, and they stay here as history rather than as options:

- `winget install --id Microsoft.PowerShell --source winget` (since the 7.6.0 package that is the
  **MSIX** by default; `--installer-type wix` forces the per-machine MSI). Its AppX stage fetches
  the 336 MiB bundle a second time and timed out here with `0x80072EE2`; from 7.7.0 there is no MSI
  at all.
- the per-machine MSI, which needs an **interactive elevation** this plugin's host process could
  not obtain — it failed with `1622`.

Neither would be kept up to date by Windows, which is the whole reason the Store is the one path.

### The Store path "queues forever" on a metered connection

This is the one trap that cost the most time to find, so it is written down with its evidence
(measured 2026-10-14):

1. `winget install --id 9MZ1SNWT0N5D --source msstore` reached
   `Started MSStore package execution. ProductId: 9MZ1SNWT0N5D` and then simply waited — forever.
2. The Store's own log (`Microsoft-Windows-Store/Operational`) recorded **no warning and no
   error**, which is why it looks like a hung queue rather than a failure.
3. Its telemetry showed the request carried **`AllowDownloadOnAnyNetwork = 0`**, and the
   connection reported **`NetworkCostType = Fixed`** — i.e. the Wi-Fi profile was marked
   *Metered connection*.
4. The only run that progressed was the one a human started in the Store UI
   (`IsInteractive = 1`, `ClientAppId = …Microsoft.WindowsStore…StartProductInstallWithOptionsForUserAsync`).
5. After the network was un-marked as metered, the **same non-interactive** route finished in
   under a minute (`IsInteractive = false`, `ClientAppId = …WinGetCli-winget-StartProductInstallWithOptionsAsync`),
   and winget exited 0 for the first time all day.

Windows documents the policy this reflects — metered connections restrict automatic downloads —
in [Metered connections in Windows](https://support.microsoft.com/en-us/windows/experience/connectivity-networking/metered-connections-in-windows)
([中文](https://support.microsoft.com/zh-cn/windows/experience/connectivity-networking/metered-connections-in-windows)),
and a [Microsoft Q&A thread](https://learn.microsoft.com/en-us/answers/questions/5494248/microsoft-store-stuck-on-queuing-a-download-for-ov)
has the same symptom.

So `pwsh7_install` reads the connection cost **before** starting the install (one probe through
Windows PowerShell 5.1, which is the only PowerShell that reaches WinRT from a script) and says so
up front when it is metered, naming the network — and the remedy is always the same single step:

- turn off **Metered connection** for that network (Settings → Network & Internet → Wi-Fi → *that
  network*) and run the install again.

No second installer is offered, in the warning or anywhere else in the model-facing text: a metered
connection is a connection setting, not a reason to leave the Store. `pwsh7_install` starts the
store route anyway and leaves the choice to the user; an unreadable probe produces no warning at
all, because the plugin does not guess.

### A failed winget exit is evidence, not a verdict

The Store route can also exit non-zero *while the runtime lands anyway* (a measured run exited 1
after twelve minutes and PowerShell 7 was in place shortly after). The plugin therefore re-probes
for a bounded while after winget exits (eight probes, 15 s apart) before it reports a failure, and
says so on the job's progress line. The verdict is always the runtime, never the exit code: a run
that reports `winget exited with code 1` but ends with PowerShell 7 in place is reported as
**installed**, with the misleading exit code kept as detail — and the wording no longer claims
winget did the work, because it cannot know that.

### Two Store path shapes — only one of them may be pinned

| Form | Example | Pinnable? |
|---|---|---|
| **family alias** | `…\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe` | **yes** — the directory is the package family name, so it carries no version and survives Store updates |
| **root alias** | `…\Local\Microsoft\WindowsApps\pwsh.exe` | **yes** — the same execution-alias mechanism, also free of any version. The executor's own probe tends to return this one inside the host process while a profile row pins the per-family path; both are accepted |
| version-numbered package executable | `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe` | **no** — every Store update moves it, so a patch pinned to it silently stops working |

The alias is a zero-length reparse point (`Length=0`, `ReparsePoint`) that Windows resolves
through AppInfo package activation. Measured on a machine running the alias (2026-10-13,
PowerShell 7.6.6, current Windows):

- the alias spawns under the Harness `pwsh` tool, and
- **the ACL sandbox still applies to what it runs**: with the session on `workspace-write`, a
  write inside the session workspace succeeded, while writes to two normally writable
  out-of-workspace paths (`%USERPROFILE%\.dsh\…` and a path on another volume) were refused
  with `UnauthorizedAccessException` and no file was created.

Residual risk, stated rather than hidden: package activation is undocumented, so the alias is
a "works today" pin and not a contract. The report says so, and `pwsh7_install` is the way off
it if a future Windows or Store change breaks it.

### What a MSIX/Store runtime does not do

From the same article's limitations list, worth knowing before choosing it:

- single-user install only — there is no all-users option,
- **no PowerShell remoting (WSMan)**: `Register-PSSessionConfiguration` and friends need write
  access to `$PSHOME`, which the package blocks,
- no AllUsers profile scripts, and no `Set-ExecutionPolicy -Scope LocalMachine`.

Choose the MSI instead where those matter (servers, enterprise deployment, Microsoft
Update-managed fleets).

## The two tools

```
pwsh7_status [path]        report what runs today; validate an explicit path; produce the
                           exact profile patch for a pinnable PowerShell 7
pwsh7_install              install PowerShell 7 from the Microsoft Store as a background job and
                           return its id at once — read progress with job_output, stop it with
                           job_kill. No parameters: there is one install path
```

The `pwsh` tool itself is gated: while this plugin is enabled, every call is denied by
`ctx.tools.guard` before dispatch unless the executor actually resolves to PowerShell 7+; the
reason names install / configure / disable. `pwsh7_status` and `pwsh7_install` stay outside the
gate as the recovery path.

`pwsh7_install` is a side-effecting tool: only ask for it when you mean it. It runs a **network
preflight** (winget present, an active network, not metered) and returns the fix instead of
starting a job when that fails. It refuses to double-install (reports "already in place" when an
ordinary PowerShell 7 **or** a working Store alias exists) and it never uninstalls PowerShell —
uninstalling the plugin leaves your PowerShell alone. The other answer, when PowerShell 7 is not
wanted, is to disable the plugin; see
[Installing PowerShell 7](#installing-powershell-7-one-path-and-one-alternative).

### Why the install is a background job

The first version of this tool `await`ed winget, and on this machine that meant a **silent twelve
minute call** — winget had handed the package to the Store, whose download was sitting queued
waiting for a click, and the call looked hung until it was abandoned mid-flight. A blocking call
cannot show that; a job can.

So `pwsh7_install` registers the install with the platform's job registry (`ctx.jobs`, kind
`pwsh7`) and returns the job id immediately. Read it with `job_output` and stop it with
`job_kill` — the platform's own tools, so the plugin does not ship a progress tool of its own.

### Where the progress comes from

winget writes nothing useful to a pipe: with stdout captured it draws no progress bar and prints
only a few lines, and one measured run spent **4m15s inside a single silent `StagePackageAsync`**.
Its own diagnostic log is the real feed, so the job follows the newest
`…\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir\WinGet-*.log`
and turns its phase lines into the progress line, appending the raw lines to the job output:

| winget log line | progress line |
|---|---|
| `Downloading to path:` | updating the winget source |
| `Packaged source open` | winget source ready |
| `Installer hash verified` | installer downloaded and verified |
| `Starting StagePackageAsync` | deploying the package (staging covers the download) |
| `Starting RegisterPackageByFullNameAsync` | registering the package |
| `Leaf command succeeded` | winget finished |

### Download bytes and speed

winget reports **no numeric download progress at all**. That is not a reading problem: a PTY run
(the terminal it draws its UI in) showed a spinner, zero percent tokens, and the *indeterminate*
taskbar signal `OSC 9;4;3` — winget itself does not know a percentage for this download.

So the numbers are measured instead: the installer lands under `%TEMP%\WinGet\<Id>.<Version>\`,
and the job sums those bytes every tick, turning the growth into a speed. When the installer URL
(a URL in the log) answers a `HEAD` with a `content-length`, the line also carries a percentage:

```
running 2m — deploying the package (staging covers the download) — downloaded 120.4 MiB / 335.9 MiB (36%) @ 4.5 MiB/s
```

Bytes and speed always show up once anything is on disk; the percentage is the only part that
depends on the server saying how large the file is.

The log is another program's private format, so this is best-effort by design: if it cannot be
found or read, the job falls back to the elapsed-time line — and, past ten minutes, to the
route's stall warning. On settle the plugin re-probes for a bounded while (see
[above](#a-failed-winget-exit-is-evidence-not-a-verdict)) and writes the verdict into the ring,
so a runtime that lands after winget gave up is still reported as installed.

## What the model is told, and why it is not the tool's description

The point of pinning PowerShell 7 is that **`&&` and `||` work there and are parse errors in
Windows PowerShell 5.1** — so the model has to know which one it is on. The plugin publishes
one prompt section, refreshed by the same reading the report uses:

```
The `pwsh` tool on this machine runs PowerShell 7.6.6, so `&&` and `||` work in one command.
```

On a row that pins Windows PowerShell 5.1 — or on a machine with no PowerShell 7 at all, where
the executor falls back to 5.1 — the same line says the operators are parse errors and to chain
with `;`. A third state gets its own line: when a row pins a `pwshPath` that **no longer
exists**, the executor uses the pin and does not fall back, so every call fails with a spawn
error — the section says so, and the model can report it on the first try instead of
rediscovering it by wasting calls:

```
The `pwsh` tool cannot start: an executor row pins C:\…\pwsh.exe, which does not exist. …
```

Anything else renders nothing: it never guesses.
Cost: one line (~25 tokens) on a machine whose executor pins a PowerShell 7, zero in the other
normal states, and ~45 tokens only while the tool is actually broken.

**Why the section and not the `pwsh` tool's own description** (the seam a reader would expect):

- `ctx.tools.register()` inserts into a per-layer name table that throws on a duplicate, and a
  profile plugin registers in the global layer — re-registering `pwsh` is refused.
- the tool registry has no description hook: its extension points are
  `tools/pre-execute` / `tools/execute` / `tools/post-execute` / `tools/result`, guards, and
  `restrict()`, none of which touch the model-facing schema.
- `systemPrompt.tools(provider)` **concatenates** providers (no dedupe, no override), so a
  second `pwsh` schema would put two tools of the same name in the request.
- shadowing the shipped `tool:pwsh` section through `agent.ctx` would *replace* its
  exit-code note rather than add to it.

So the plugin owns a section beside the shipped one, placed at the shared `TOOL_PWSH` order.

## Configuration (all optional)

Add this under the plugin's own row in the profile patch:

```yaml
- id: win-pwsh7
  config:
    overridePath: 'D:\tools\pwsh\pwsh.exe'   # priority ① — validated; must spawn and report PowerShell 7+
    installIfMissing: true                    # install the Store package through winget at startup when nothing usable exists
```

- `overridePath` is validated on every start; a rejected value falls through to auto-detect
  and is reported with its reason. A Store family alias is accepted here; a version-numbered
  Store path is accepted as a runtime but reported as un-pinnable. It only changes what the
  plugin probes and recommends — **it does not wire the executor**; use the printed patch for that.
- `installIfMissing` defaults to `false`. When it triggers, it first runs the same network
  preflight as `pwsh7_install`; a metered, unknown or unreadable connection is logged and the
  auto-install is skipped. A passing preflight runs the install inline at activation, is logged,
  and is skipped once an ordinary PowerShell 7 or a Store alias exists.

## Example report (this machine: the Store family alias, wired in by a patch)

```
Executor rows:
  pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe (PowerShell 7.6.6, Store family alias)
  desktop-windows-pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\...\pwsh.exe (PowerShell 7.6.6, Store family alias)

The pwsh tool currently runs on PowerShell 7.6.6 via row desktop-windows-pwsh-sandbox.
(Row `pwsh-sandbox` above pins the same alias but is disabled, and a disabled row does not run — so it
is deliberately not the row named here.)
That pin is the version-stable Store family alias: its directory carries no version, so Store
updates do not move it, and the ACL sandbox still confines what it runs. Nothing to configure.
Caveat: Windows resolves the alias through AppInfo package activation, which is undocumented —
if a future Windows or Store change stops it, run pwsh7_install, or pin an ordinary pwsh.exe.
```

The same summary is written to the host logs at startup under `dsh-win-pwsh7:`.

## The plugin page

The bundle's page gains three pieces, all reading and writing the same Host state as the
tools (one operation, two callers):

- a **diagnostics section** carrying the same report `pwsh7_status` produces, plus a
  **Re-detect** action in the page head that refreshes it,
- a **configure card** on the row's own page (open it through the row's 配置/Configure
  control) for `overridePath` and `installIfMissing` — edits are written through
  configForms and take effect without a restart.

The card talks to the Host over the package's build-time typert contract
(`lib/typert.host.js`), which the official loader registers at boot.

## Verify

```powershell
npm run check                  # both gates
node tools/check-host.mjs      # the Host half alone
node tools/check-client.mjs    # the Client half alone
```

`tools/` ships with the package, so these run on an installed copy too. One thing has to be told
where the harness is: the hook that re-parents `@deepseek-ai/*` tries `DSH_APP_DIR` first, then the
nearest ancestor of the tools directory or the working directory that carries
`node_modules/@deepseek-ai/cordis`. **In practice, set `DSH_APP_DIR`** — a plugin installed into a
profile's `node_modules` has no harness packages beside it (measured: this profile's `node_modules`
holds no `@deepseek-ai/*`), so discovery has nothing to find there. Since DSH 2.0 the installation
ships packed (`resources/app.asar`), and Node cannot resolve a path inside an asar archive, so the
variable accepts any of three hand-offs: the install root, `resources/app` (an unpacked install), or
`resources/app.asar` (a packed one) — `tools/dsh-app-modules.mjs` unpacks the tree once into a
temporary directory (`dsh-app-modules-*`, reused per archive by size and mtime, carrying
`node_modules`, `package.json` and the `dsh/` directory a desktop build keeps its harness in), and
the Host gate opens with
`note — the harness packages come from an asar archive, unpacked for this run into …`. A packed
installation comes in two internal layouts: DSH 2.0.19-next keeps the harness at the archive root,
while the desktop build (`DeepSeek Harness.exe` 0.2.1) keeps a shell there — its
`node_modules/@deepseek-ai` holds eight packages (cordis, cosmokit, dsh-api-gateway, dsh-brand,
dsh-deque, dsh-timeout, dsh-typert-protocol, schemastery) — and puts all 306 harness packages under
`dsh/`. The harness root is therefore recognised by carrying **both** `cordis` and `dsh-tools`, not
`cordis` alone: the weaker test mistakes the shell for the harness and reports the misleading
`Cannot find package '@deepseek-ai/dsh-tools'`. The client gate needs no such variable: it renders
the browser half through its own stubs.

```powershell
$env:DSH_APP_DIR = 'C:\Program Files\DSH NEXT'   # the install root; resources/app or resources/app.asar also work
npm run check
```

`check-host.mjs` runs the host half's gate offline: it loads `index.js`, applies it to a stub
context, and drives both tools through the registry's own success path (`execute` → validate →
`render`), the 5.1 / missing-path rejections, the two Store path shapes (a pinned family alias
must read as stable wiring; a pinned version-numbered path must be refused), the install path and
its two-ways-forward report, the install **as a background job** (the call must return before
winget exits; the job must carry both streams, report elapsed time, warn past the stall threshold,
and settle with a re-validated verdict), the connection-cost probe (a metered reading must be named;
an unreadable one must stay silent), and the runtime prompt section on a pinned PowerShell 7, a
pinned Windows PowerShell 5.1, a pin that no longer exists, and an unknown runtime. The behaviour
half is fixture-pinned (`PATH`, `LOCALAPPDATA`, `ProgramFiles`) so it runs on any machine — including
one that has the per-machine MSI installed, which is where an earlier version silently skipped it —
and it drives job cancellation and both inline install fallbacks as well. Two invariants that broke
once are asserted in their own right: the stall warning must coexist with a known phase, and the
card's `useSyncExternalStore` callbacks must keep their identity across renders. It spawns nothing.

`check-client.mjs` **renders** the client half instead of reading it: the browser module is
captured through a stub `window.__ModuleLoader__`, given a stub React that records the element
tree, and applied to a stub client context, then the assertions read the text a user would see.
That is what catches a defect no static scan can see — a label written as a literal
(`h('label', null, 'overridePath')`) is valid text and only shows up once the card is drawn.
The card's own dictionaries are the fixtures, so no translation is duplicated into the gate.

After installing (or applying a patch) and restarting DSH:

```powershell
$PSVersionTable.PSVersion
```

and confirm that writing outside the session workspace is still refused — the sandbox
must stay intact.

## Releasing

```powershell
$env:DSH_APP_DIR = 'C:\Program Files\DSH Desktop\resources\app'   # the host gate needs this
npm run check                                                     # green before anything else
# bump "version" in package.json and write the CHANGELOG entry, then:
git add -A; git commit -m 'dsh-win-pwsh7 X.Y.Z: ...'
git tag vX.Y.Z
git push origin main --tags     # the tag publishes: no local npm login needed
```

Pushing the tag runs `.github/workflows/publish.yml`: it refuses to continue unless the tag is
byte-identical to `v$(package.json version)`, runs the client gate (the Host gate needs a real
Windows DSH installation, so it runs locally before tagging — which is why `--ignore-scripts` skips
`prepublishOnly`), and then runs `npm publish --access public --provenance`. Authentication is npm
**trusted publishing** over OIDC, so no npm token is stored in the repository and the published
tarball carries a sigstore provenance attestation.

**Provenance has one hard requirement**: `package.json` `repository.url` must be byte-identical to
the GitHub context (`https://github.com/xinspark/dsh-win-pwsh7`). Writing
`git+https://github.com/XinSpark/dsh-win-pwsh7.git` gets the publish rejected with
`E422 Unprocessable Entity … Error verifying sigstore provenance bundle` — not one character may
differ.

What ships is the `files` allowlist plus `LICENSE`, `README.md`, `README.en.md` and `CHANGELOG.md` —
`npm pack --dry-run` prints the exact list, and it holds no artifact or machine-specific file.

## License

[MIT](LICENSE) — free and open source.

