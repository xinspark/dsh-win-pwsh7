# dsh-win-pwsh7

<p align="center"><sub><a href="README.md">简体中文</a> · English</sub></p>

Give the Harness `pwsh` tool a real PowerShell 7 on Windows instead of silently falling back to
Windows PowerShell 5.1.

1. **Detect** PowerShell 7 on the machine (plus an optional `overridePath`);
2. **Validate** an explicit path (`pwsh7_status`'s `path` argument);
3. **Install** via the script path (`pwsh7_install` opens the Microsoft Store page and clicks
   Install) or the manual path (Win+R, same Store link). There is no automatic startup install.

While enabled, the `pwsh` tool is allowed **only when the live executor resolves to PowerShell 7+**.
Otherwise every call is denied by `ctx.tools.guard` before dispatch, the model is told to configure /
install / disable, and no PowerShell process starts. Disabling the plugin restores the default
runtime; the plugin still never writes `pwshPath`.

## Install this plugin

```powershell
dsh plugin --profile desktop add github:XinSpark/dsh-win-pwsh7#v0.16.7
# or
dsh plugin --profile desktop add dsh-win-pwsh7
```

Restart DSH after installing. To wire a path, paste the exact profile patch printed by
`pwsh7_status` into `~\.dsh\profiles\<profile>\cordis.patch.yml` and restart; the plugin never writes
the executor's `pwshPath` itself.

## Two install paths

| Path | Behavior |
|---|---|
| **Script install** | Call `pwsh7_install`. The tool first requires the user to confirm no VPN is active (`vpnOffConfirmed: true`). It then opens the Microsoft Store page for PowerShell 7, shows a notice (do not close the Store window; cancel if a VPN is on), and invokes the localized Install / Get / 获取 / 安装 button with Windows UI Automation. |
| **Manual install** | Win+R → paste `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D` → Enter → click Install. A manual install is detected automatically; no pin is needed. |

If the Store page exposes no Install button within 90 seconds, the report asks the user to confirm
the VPN first: disconnect it, fully quit and restart Microsoft Store, then retry or use the manual
path.

### Three-failure breaker

Within one Host process, after **3 consecutive failed script installs**:

- the next `pwsh7_install` starts no job;
- it first asks the user to check the network, especially the VPN;
- only after the user explicitly says it is fixed may the model call with
  `userConfirmedFixed: true`; that resets the counter and allows one retry;
- three more failures open the breaker again;
- otherwise the report points at the manual install.

The count lives in the current process and resets when DSH restarts.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `overridePath` | unset | Priority ① explicit `pwsh.exe`. It must spawn and report PowerShell 7+; a failed validation falls back to auto-detection. **It only changes probing and recommendations, not executor wiring.** |

`overridePath` is `volatile()`: the plugin-page configuration section saves it live; it can also be
set in the profile patch:

```yaml
- id: win-pwsh7
  config:
    overridePath: 'D:\tools\pwsh\pwsh.exe'
```

There is no startup auto-install.

## Recommended companion

When the script install completes, its job verdict contains an **instruction to the model**: tell the
user that dsh-win-pwsh7 works best paired with the **dsh-ops** plugin
([https://github.com/T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)); ask before installing it and
never install it without the user's consent. Command:

```powershell
dsh plugin --profile <profile> add dsh-ops
```

The recommendation appears only in the completed script-install result; `pwsh7_status` and manual
installs do not advertise it repeatedly.

## Report example

```
Executor rows:
  pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe (PowerShell 7.6.9, Store family alias)

The pwsh tool currently runs on PowerShell 7.6.9 via the executor (…).
The executor resolves to the version-stable Store family alias: … Nothing to configure.
```

When nothing usable exists, the report ends with `Three ways forward:`: install / configure the
executor / disable the plugin.

## Plugin page

The status section shows the current runtime, state and executor path, with Re-detect beside the
title; the configuration section exposes only `overridePath`.

## Verification

```powershell
$env:DSH_APP_DIR = 'E:\FXS\APP\DSH NEXT\resources\app.asar'
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-native-contracts.mjs
```

All three gates run offline against a packed installation (`resources/app.asar`); `DSH_APP_DIR`
accepts the install root, `resources/app`, or `resources/app.asar`.

## Design constraints

- The reading comes from the executor's own `ctx.shell.pwshPath`, not from config rows;
  `overridePath` only changes probing and recommendations.
- No VPN auto-detection and no metered-connection preflight: the user confirms the VPN before an
  install, and a page-load failure asks again.
- No automatic retries; the three-failure breaker ends the loop.
- Run all three gates before publishing; end-to-end installation is release evidence, not part of
  the automated gate.
