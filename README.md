# dsh-win-pwsh7

<p align="center"><sub>简体中文 · <a href="README.en.md">English</a></sub></p>

把**真正的 PowerShell 7** 交给 Windows 上的 Harness `pwsh` 工具，而不是悄悄退回 Windows PowerShell 5.1。三件事：

1. **检测**这台机器上的 PowerShell 7（含你设置的 `overridePath`）；
2. **校验**你给出的路径（`pwsh7_status` 的 `path` 参数）；
3. **安装**：从 **Microsoft Store** 装（`pwsh7_install`，或配置里的 `installIfMissing`）—— **只有这一条路**，动手前先读连接成本，因为 Windows 会在计量连接上推迟商店下载。不想装，就把本插件关掉。

**它不自带 PowerShell，也不写你的配置。** 安装永远是显式动作（你要的工具调用，或你打开的配置项）；它从不卸载任何东西。

> 本文是简体中文版；完整证据与出处（含官方文档链接、逐条实测记录）在 [README.en.md](README.en.md)。

## 为什么需要它

Desktop 适配器按这个顺序解析 PowerShell 可执行文件：

1. `C:\Program Files\PowerShell\7\pwsh.exe`
2. `PATH` 里的每一项（**商店版**就是通过它的执行别名在这里被找到的）
3. `C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`（5.1）

在 5.1 上，`&&` 和 `||` 是**解析错误** —— 模型写下的每条带 `&&` 的命令都会在运行前直接失败。

## 安装 PowerShell 7：一条路，一个替代

[微软官方安装文章](https://learn.microsoft.com/en-us/powershell/scripting/install/install-powershell-on-windows?view=powershell-7.6) 把 WinGet 列为 Windows 客户端的推荐方式，而商店包列出的第一条好处是「**随 Windows 自动更新**」。本插件只提供这个论据支持的方案：

| 方案 | 内容 |
|---|---|
| **① 从 Microsoft Store 安装**（插件唯一的安装路径） | `pwsh7_install` 以后台作业运行 `winget install --id 9MZ1SNWT0N5D --source msstore`（[商店条目](https://apps.microsoft.com/detail/9mz1snwt0n5d)）。自更新、按用户安装、不需要提权。**连接被标为计量时 Windows 会推迟它**（见下），补救是那个设置，**永远不是换一个安装器**。 |
| **② 禁用本插件** | 这台机器不需要 PowerShell 7 时，在插件页把它关掉：建议与两个工具都停止，什么也不安装。注意 `pwsh` 工具仍会失败（执行器固定了一条不存在的路径），所以那是对 `pwsh` 本身的决定。 |

**没有 `route` 参数**，面向模型的任何文本（工具描述、报告、提示段）里都没有第二个安装器。开发期实测并**否掉**的两个替代方案只作历史留档，不作为选项：

- `winget install --id Microsoft.PowerShell --source winget`（7.6.0 起默认装 **MSIX**，`--installer-type wix` 才装 per-machine MSI）：它的 AppX 阶段会**第二次**拉取那个 336 MiB 的包，本机因此超时 `0x80072EE2`；7.7.0 起更没有 MSI 了。
- per-machine MSI：需要**交互式提权**，本插件的宿主进程拿不到（失败码 `1622`）。

两者都不会被 Windows 自动更新 —— 这正是"商店是唯一路径"的理由。

### 商店路线在计量连接上会「永远排队」

这是最费时间的一个坑，因此把证据留下（实测于 2026-10-14）：

1. `winget install --id 9MZ1SNWT0N5D --source msstore` 走到 `Started MSStore package execution` 之后就一直等 —— 无限期。
2. 商店自己的日志（`Microsoft-Windows-Store/Operational`）**既没有警告也没有错误** —— 所以它看起来像队列卡死，而不是失败。
3. 它的遥测显示请求带着 **`AllowDownloadOnAnyNetwork = 0`**，而连接报告 **`NetworkCostType = Fixed`**，也就是这个 Wi-Fi 配置文件被标成了「按流量计费的连接」。
4. 唯一有进展的一次，是**人**在商店界面里发起的（`IsInteractive = 1`，`ClientAppId = …Microsoft.WindowsStore…StartProductInstallWithOptionsForUserAsync`）。
5. 把连接**取消**计量标记之后，**同一条非交互**路线不到一分钟就装完了（`IsInteractive = false`，`ClientAppId = …WinGetCli-winget-StartProductInstallWithOptionsAsync`），winget 当天第一次以 0 退出。

这条策略有官方文档依据：[Windows 中的按流量计费的连接](https://support.microsoft.com/zh-cn/windows/experience/connectivity-networking/metered-connections-in-windows)（[英文](https://support.microsoft.com/en-us/windows/experience/connectivity-networking/metered-connections-in-windows)）写明计量连接会限制自动下载；微软 Q&A 里也有[同症状的帖子](https://learn.microsoft.com/en-us/answers/questions/5494248/microsoft-store-stuck-on-queuing-a-download-for-ov)。

所以 `pwsh7_install` **动手前**先读一次连接成本（用 Windows PowerShell 5.1 走 WinRT —— 只有它能从脚本里访问 WinRT），命中计量就**点名网络**，而补救永远只有一步：

- 设置 → 网络和 Internet → WLAN → **那个网络** → 关掉「按流量计费的连接」，然后再跑一次。

**不提供第二个安装器**：计量连接是连接设置的问题，不是离开商店的理由。读不到成本就**完全不出声** —— 插件不猜。

### 失败退出码只是证据，不是判决

商店路线也可能在运行时已经落地的情况下仍非零退出（实测一次退出 1 之后不久，PowerShell 7 就在位了）。插件因此在 winget 退出后**有界重探**（8 次 × 15 秒）才报失败，并把重探写在作业进度行上。判决永远是运行时，不是退出码：报「`winget exited with code 1` 但 PowerShell 7 已在位」时结论是**已安装**，那条误导性的退出码只作详情保留 —— 判词也不再声称是 winget 完成的，因为它无从知道。

### 两种商店路径形态：只有一种能 pin

| 形态 | 例子 | 能 pin 吗 |
|---|---|---|
| **家族别名** | `…\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe` | **能** —— 目录就是包家族名，不含版本号，跨商店更新存活 |
| **根别名** | `…\Local\Microsoft\WindowsApps\pwsh.exe` | **能** —— 同一套执行别名机制，也不含版本。执行器在宿主进程内的自探测常返回这一条，而 profile 行里 pin 的是按家族的那一条；两条都接受 |
| 版本号目录 | `C:\Program Files\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe` | **不能** —— 每次商店更新都会移动它，pin 在它上面的补丁会静默失效 |

别名是零长度重解析点（`Length=0`、`ReparsePoint`），Windows 通过 AppInfo 包激活解析它。实测（2026-10-13，PowerShell 7.6.6）：

- 别名能在 Harness `pwsh` 工具下启动；
- **ACL 沙箱对它运行的东西仍然生效**：会话处于 `workspace-write` 时，会话工作区内的写入成功，而工作区外两处常规可写路径（`%USERPROFILE%\.dsh\…` 与另一卷上的路径）被拒并报 `UnauthorizedAccessException`，且没有产生任何文件。

残余风险如实说明：包激活没有文档化，所以别名是"今天能用"的 pin，不是契约。报告里会写明这一点，`pwsh7_install` 是它万一失效时的出路。

### MSIX/商店运行时不会做什么

- 不会出现在 `C:\Program Files\PowerShell\7\`（那是 MSI 的位置）；
- 不会让执行器"自己找到它" —— 所以需要那条 profile 补丁指向别名；
- 更新由 Windows/商店负责 —— 这既是选它的理由，也意味着**换用别的安装方式就失去自动更新**。

## 两个工具

```
pwsh7_status [path]   报告现在跑的是什么；校验你给的路径；给出可粘贴的 pin 补丁
pwsh7_install         从 Microsoft Store 安装 PowerShell 7，以后台作业运行并立刻返回作业号，
                      用 job_output 看进度、job_kill 停止。无参数：安装路径只有一条
```

`pwsh7_install` 是有副作用的工具：只在用户明确要求时装。它会拒绝重复安装（已有普通 PowerShell 7 **或**可用的商店别名时报「already in place」），并且从不卸载 PowerShell —— 卸载插件不会动你的 PowerShell。另一个答案是**禁用插件**。

### 安装为什么是后台作业

这个工具的第一版 `await` 了 winget，在这台机器上的结果是一次**静默 12 分钟的调用**：winget 已经把包交给商店，而商店的下载正躺在队列里等人点一下，调用看起来就像挂了，直到被中途放弃。阻塞式调用没法显示这些；作业可以。

于是 `pwsh7_install` 把安装登记进平台自己的作业注册表（`ctx.jobs`，kind `pwsh7`）并立刻返回作业号。用 `job_output` 读、`job_kill` 停 —— 都是平台自带的工具，插件不再自己造一个进度工具。

### 进度从哪来

winget 往管道里不写有用的东西：stdout 被接管时它不画进度条，只打印几行，实测一次运行在单个静默的 `StagePackageAsync` 里待了 **4 分 15 秒**。它自己的诊断日志才是真正的数据源，所以作业跟随最新的 `…\Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\DiagOutputDir\WinGet-*.log`，把阶段行变成进度行，并把日志原文追加进作业输出：

| winget 日志行 | 进度行 |
|---|---|
| `Downloading to path:` | updating the winget source |
| `Packaged source open` | winget source ready |
| `Installer hash verified` | installer downloaded and verified |
| `Starting StagePackageAsync` | deploying the package（staging 覆盖下载） |
| `Starting RegisterPackageByFullNameAsync` | registering the package |
| `Leaf command succeeded` | winget finished |

那份日志是别的程序的私有格式，所以这里按"尽力而为"设计：找不到或读不了就退回耗时行（超过十分钟再叠加路线的停滞提示）。

### 下载字节与速度

winget **完全不报数字进度**。这不是读取方式的问题：PTY 实测（它画界面的终端里）只有转圈、零个百分比、以及终端的"不确定进度"信号 `OSC 9;4;3` —— winget 自己就不知道百分比。

所以数字自己量：安装包落在 `%TEMP%\WinGet\<包id>.<版本>\`，作业每次心跳统计这些字节，用增量算速度；当日志里出现的安装 URL 用 `HEAD` 回答 `content-length` 时，进度行还会带上百分比：

```
running 2m — deploying the package (staging covers the download) — downloaded 120.4 MiB / 335.9 MiB (36%) @ 4.5 MiB/s
```

字节与速度一旦磁盘上有东西就会出现；只有百分比取决于服务器是否肯报长度。

## 模型被告知什么，以及为什么不靠工具描述

pin PowerShell 7 的意义在于 **`&&` 和 `||` 在那里能用、在 Windows PowerShell 5.1 里是解析错误** —— 模型必须知道当前是哪一个。插件发布**一个提示段**，与报告用同一次读数刷新：

```
The `pwsh` tool on this machine runs PowerShell 7.6.6, so `&&` and `||` work in one command.
```

当某行 pin 的是 Windows PowerShell 5.1 —— 或这台机器根本没有 PowerShell 7（执行器回落到 5.1）—— 同一行会说这两个运算符是解析错误、请用 `;` 串联。第三种状态有自己的句子：某行 pin 的 `pwshPath` **已不存在**时，执行器用这个 pin 且不回落，每次调用都会以启动失败告终 —— 提示段会说明这一点，并给出**两条路**（从商店安装 / 禁用插件），这样模型第一次就能说清，而不是靠浪费调用去重新发现：

```
The `pwsh` tool cannot start: an executor row pins C:\…\pwsh.exe, which does not exist. …
```

其他情况什么都不渲染：**它从不猜**。成本：在 pin 了 PowerShell 7 的机器上约 25 token，另两种正常状态为零，只有工具真的坏掉时约 45 token。

**为什么用提示段而不是 `pwsh` 工具自己的描述**（读者会先想到的那个缝）：工具系统没有"描述钩子"，`systemPrompt.tools()` 的提供者是**拼接**而不是覆盖，加第二个 `pwsh` schema 只会造出一个重复工具。提示段是真正存在的那个缝。

## 配置（全部可选）

| 键 | 默认 | 说明 |
|---|---|---|
| `overridePath` | 未设 | 优先级①的显式 `pwsh.exe`。必须能启动并报告 PowerShell 7+；未通过校验就静默回落到自动探测 |
| `installIfMissing` | `false` | 启动时若没有可用的 PowerShell 7，就后台安装（等价于 `pwsh7_install`），结果写进状态报告 |

两项都是 `volatile()`：插件页的配置卡改完保存即生效，不需要重启。也可以直接写进 profile 补丁：

```yaml
- id: win-pwsh7
  config:
    overridePath: 'D:\tools\pwsh\pwsh.exe'
    installIfMissing: true
```

## 报告示例（本机：商店家族别名，用补丁接线）

```
Executor rows:
  pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe (PowerShell 7.6.6, Store family alias)
  desktop-windows-pwsh-sandbox : pwshPath = C:\Users\...\WindowsApps\...\pwsh.exe (PowerShell 7.6.6, Store family alias)

The pwsh tool currently runs on PowerShell 7.6.6 via row pwsh-sandbox.
That pin is the version-stable Store family alias: …
```

没有可用运行时的时候，报告以**两条路**结束：

```
Two ways forward:
  1. Install PowerShell 7 from the Microsoft Store — ask for pwsh7_install (this plugin runs it),
     or run it yourself: winget install --id 9MZ1SNWT0N5D --source msstore …
  2. Disable this plugin (the switch on its plugin page) if PowerShell 7 is not wanted here. …
```

## 插件页

插件页给的是同一份诊断（和工具报告同源）加一张配置卡；卡上保存即写进上面的两个键。报告里的路径是**可以整段粘进 profile 补丁**的。

## 验证

```powershell
npm run check                  # 两套门
node tools/check-host.mjs      # 只跑宿主半
node tools/check-client.mjs    # 只跑客户端半
```

`tools/` 随包发布，所以装在别人机器上也能跑。有一件事要告诉钩子 harness 在哪：重新指向 `@deepseek-ai/*` 的钩子先试 `DSH_APP_DIR`，再试 tools 目录或工作目录的祖先里有没有 `node_modules/@deepseek-ai/cordis`。**实践上请设 `DSH_APP_DIR`** —— 装进 profile 的 `node_modules` 的插件旁边没有 harness 包（实测：本 profile 的 `node_modules` 里没有 `@deepseek-ai/*`），所以探测在那里找不到东西。客户端门不需要这个变量：它用自己的桩渲染浏览器半。

`check-host.mjs` 离线地跑宿主半：加载 `index.js`、应用到一个桩上下文，然后按注册表自己的成功路径驱动两个工具（`execute` → 校验 → `render`）、5.1 与不存在路径的拒绝、两种商店形态（pin 家族别名必须读作稳定接线；pin 版本号目录必须被拒）、安装路径与"两条路"报告、以后台作业安装（调用必须在 winget 退出前返回；作业必须携带两条流、报告耗时、超过停滞阈值给出警告、并在落定时以重新校验过的结论收尾）、**作业取消**、**两条内联安装回退**、连接成本探测（命中计量必须点名；读不到必须沉默），以及提示段在 pin 了 PowerShell 7、pin 了 Windows PowerShell 5.1、pin 失效、运行时未知四种情况下的表现。行为那一半全部钉在夹具上（`PATH`、`LOCALAPPDATA`、`ProgramFiles`），所以在**任何**机器上都跑 —— 包括装了 per-machine MSI 的机器（早期版本正是在那里静默跳过了它）。两个**曾经坏过的不变量**各有自己的断言：停滞警告必须能与已知阶段同时出现；卡片的 `useSyncExternalStore` 回调必须在多次渲染间保持身份不变。它不启动任何进程。

`check-client.mjs` 是**渲染**客户端半而不是读它：通过桩 `window.__ModuleLoader__` 捕获浏览器模块，给一个会记录元素树的桩 React，应用到一个桩客户端上下文，然后断言读用户会看到的文本。这能抓住静态扫描看不见的缺陷 —— 比如把标签写成字面量（`h('label', null, 'overridePath')`）是合法文本，只有卡片真正画出来才会暴露。卡片自己的词典就是夹具，所以门里不重复任何翻译。

## 发布

```powershell
$env:DSH_APP_DIR = 'C:\Program Files\DSH Desktop\resources\app'   # 宿主门需要
npm run check                                                     # 先绿
# 改 package.json 的 version，然后：
git add -A; git commit -m 'dsh-win-pwsh7 X.Y.Z: ...'
git tag vX.Y.Z
npm publish                        # prepublishOnly 会重跑两套门，红了就中止发布
```

`prepublishOnly` 跑 `npm run check`，所以红的树发布不出去；它需要与本节相同的 `DSH_APP_DIR`。发布的内容是 `files` 白名单加上 `LICENSE`、`README.md`、`README.en.md`、`CHANGELOG.md` —— `npm pack --dry-run` 会打印准确清单，里面既没有产物也没有本机专属文件。

## 许可证

[MIT](LICENSE) —— 完全开源免费。
