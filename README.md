# dsh-win-pwsh7

<p align="center"><sub>简体中文 · <a href="README.en.md">English</a></sub></p>

把**真正的 PowerShell 7** 交给 Windows 上的 Harness `pwsh` 工具，而不是悄悄退回 Windows PowerShell 5.1。

1. **检测**这台机器上的 PowerShell 7（含可选的 `overridePath`）；
2. **校验**显式路径（`pwsh7_status` 的 `path` 参数）；
3. **安装**：脚本安装（`pwsh7_install` 打开 Microsoft Store 页面并点击安装）或手动安装（Win+R 打开同一个 Store 链接）。**没有启动时自动安装。**

启用本插件期间，`pwsh` 工具**只在实际执行器解析到 PowerShell 7+ 时才放行**；否则每次调用在 dispatch 之前被 `ctx.tools.guard` 拒绝，错误文案给用户三条路：**配置已装的 PowerShell 7 / 安装 / 禁用插件**，并且不会启动任何 PowerShell 进程。禁用插件即移除 gate，之后由默认执行器自行选择运行时，插件仍然不写 `pwshPath`。

## 验证环境

- Windows 10/11。
- 已在 DSH **0.2.1-rc.3** 上验证（见 `package.json` 的 `dsh.verifiedAgainst`）。
- 脚本安装需要 Microsoft Store 可用；手动安装只需要能打开 Store 页面。
- 不需要管理员权限。

## 它不做什么

- 不在启动时自动安装。
- 不写执行器的 `pwshPath`，也不修改 profile 补丁。
- 不卸载由 Store 安装的 PowerShell 7。
- 不做 VPN 自动检测，也不做计量连接预检。

## 安装本插件

```powershell
# 从 GitHub 安装（推荐锁定 tag）
dsh plugin --profile desktop add github:XinSpark/dsh-win-pwsh7#v0.2.0
# 或 npm
dsh plugin --profile desktop add dsh-win-pwsh7
```

装完重启 DSH。需要接线时，把 `pwsh7_status` 给出的 profile 补丁整段粘进 `~\.dsh\profiles\<profile>\cordis.patch.yml` 再重启；插件不会替你写执行器的 `pwshPath`。

## 两种安装方式

| 方式 | 说明 |
|---|---|
| **脚本安装** | 调用 `pwsh7_install`。插件先要求用户确认没有开启 VPN（`vpnOffConfirmed: true`）；随后打开 Microsoft Store 的 PowerShell 7 页面，先弹一个说明框（不要关闭商店窗口；VPN 开启请取消），再用 Windows UI Automation 点「安装」/「获取」/「Install」/「Get」。 |
| **手动安装** | Win+R → 粘贴 `ms-windows-store://pdp/?ProductId=9MZ1SNWT0N5D` → 回车 → 点「安装」。手动安装会被插件自动识别，无需 pin。 |

脚本安装的 Store 页面 90 秒内没有出现安装按钮时，报告会要求用户先确认 VPN：关闭 VPN、完全退出并重启 Microsoft Store，然后重试；或改用手动安装。

### 连续失败熔断

同一个 Host 进程内，连续 **3 次**脚本安装失败后：

- 下一次 `pwsh7_install` **不再启动作业**；
- 先要求用户检查网络，尤其是 VPN；
- 只有用户明确回复“问题已解决”后，模型才可以带 `userConfirmedFixed: true` 再试一次；该参数会清零计数；
- 若再次连续失败 3 次，继续熔断；
- 其余情况改用手动安装。

计数只存在当前进程，重启 DSH 后清零。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `overridePath` | 未设 | 优先级①的显式 `pwsh.exe`。必须能启动并报告 PowerShell 7+；未通过校验就回落到自动探测。**只影响探测与推荐，不接线**。 |

`overridePath` 是 `volatile()`：插件页配置区保存即生效；也可以写进 profile 补丁：

```yaml
- id: win-pwsh7
  config:
    overridePath: 'D:\tools\pwsh\pwsh.exe'
```

## 推荐搭配

脚本安装完成后，作业结果会包含一条**给模型的指令**：必须向用户推荐搭配 **dsh-ops**（[https://github.com/T-Auto/dsh-ops](https://github.com/T-Auto/dsh-ops)）插件使用，效果更佳；由模型询问用户是否安装，**不得未经同意自动安装**。安装命令：

```powershell
dsh plugin --profile <profile> add dsh-ops
```

推荐只出现在脚本安装完成的作业结果里；`pwsh7_status` 和手动安装不会反复推荐。

## 报告示例

`pwsh7_status` 返回下面的文本报告；插件页把同一份状态渲染成卡片，不直接铺开整段文本。

```
Executor rows:
  pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe (PowerShell 7.6.9, Store family alias)

The pwsh tool currently runs on PowerShell 7.6.9 via the executor (…).
The executor resolves to the version-stable Store family alias: … Nothing to configure.
```

没有可用运行时时，报告以 `Three ways forward:` 结束：安装 / 配置执行器 / 禁用插件。

## 插件页

插件页的状态区是原生卡片，显示状态、运行时和执行器路径，右上角有「重新检测」；配置区只有 `overridePath`。

## 禁用或卸载

禁用插件只移除 `pwsh` 的 gate 和插件页，不会卸载 PowerShell 7。只要机器上仍有 `pwsh.exe`，默认执行器仍会优先运行它（通常是 Store 版 PowerShell 7）；只有找不到 `pwsh.exe` 时才回退到 Windows PowerShell 5.1。要真正回到 5.1，需要卸载 Store 版或把执行器 pin 到 `powershell.exe`，不推荐这样做。

## 故障排查

| 现象 | 处理 |
|---|---|
| Store 页面打开但没有「安装」按钮 | 确认 VPN 已关闭，完全退出并重启 Microsoft Store 后重试；或改用手动安装。 |
| `pwsh` 仍运行 5.1 | 运行 `pwsh7_status`，按报告把 `pwshPath` 补丁粘进 profile 并重启；或安装 Store 版。 |
| 插件页看不到 | 确认当前 profile 已启用 `dsh-win-pwsh7`，然后重启 DSH。 |

## 验证

```powershell
$env:DSH_APP_DIR = 'E:\FXS\APP\DSH NEXT\resources\app.asar'
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-native-contracts.mjs
```

三套门都可以在打包安装（`resources/app.asar`）上离线复跑；`DSH_APP_DIR` 接安装根目录、`resources/app` 或 `resources/app.asar`。

## 设计约束

- 判定读执行器自己的 `ctx.shell.pwshPath`，不是扫配置行；`overridePath` 只影响探测与推荐。
- 不做 VPN 自动检测、不做计量连接预检；VPN 由用户在安装前确认，页面加载失败时再提示。
- 不自动重试；连续失败由熔断终止。
- 提交前跑三套门；端到端安装是发布证据，不是自动化门的一部分。

## License

[MIT](LICENSE)
