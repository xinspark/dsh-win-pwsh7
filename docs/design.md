# 设计说明

> 为什么这么实现、哪些约束不能破。装配细节见 [装配契约](reference/architecture.md)，
> 逐项上游证据见 [原生契约](reference/native-contracts.md)，踩坑记录见 [项目经验](experience/README.md)。

## 目标与非目标

**目标**：Windows 上的 `pwsh` 工具必须运行 **PowerShell 7+**，而不是悄悄回落到 Windows
PowerShell 5.1；当它做不到时，在 dispatch 之前给出可执行的三条路（配置 / 安装 / 禁用）。

**非目标**：不替代执行器、不写执行器的 `pwshPath`、不在启动时安装、不做 VPN 自动检测、
不做第二种安装器、不卸载 Store 版 PowerShell 7。

## 1. 判定读执行器，不读配置行

`pwsh` 工具最终通过 `ctx.shell.execute` 启动进程，`PwshLocalExecutor.argv()` 以
`this.pwshPath` 作为 argv[0]。所以“实际会运行什么”只有一个权威来源：**执行器自己的
`ctx.shell.pwshPath` getter**（[原生契约](reference/native-contracts.md) 的 “The exact executable”
行）。

`configEditor.entries()` 只暴露 `include` 拥有的行，Desktop 生成的 live 行可能不可寻址，
所以它只能作为没有 shell 服务时的降级读法，不能当权威。

`overridePath` 只影响**探测与推荐**：它让用户指定一个已被验证的 PowerShell 7，但插件不会
拿它去写执行器。给执行器接线永远是用户把 `pwsh7_status` 打印的 profile patch 粘进去。

## 2. 唯一允许 pin 的 Store 形态

Microsoft Store 安装有两种磁盘形态：

| 形态 | 例子 | 能 pin 吗 |
| --- | --- | --- |
| 家族别名 | `…\Local\Microsoft\WindowsApps\Microsoft.PowerShell_8wekyb3d8bbwe\pwsh.exe` | ✅ 目录名不含版本，Store 更新不移动它 |
| 版本号目录 | `…\WindowsApps\Microsoft.PowerShell_7.6.6.0_x64__8wekyb3d8bbwe\pwsh.exe` | ❌ 每次 Store 更新都换路径，pin 会静默失效 |

上游 resolver 经 MSIX 激活拿到的是版本号目录，所以插件在自动探测时主动换算出家族别名，
并把它当作“已就位”。版本号路径可以运行，但报告会明确说“能跑、别 pin”。

## 3. Gate：同步拒绝，异步保鲜

- `ctx.tools.guard` 是同步、全局、单调的：它在 dispatch 前看到每个 agent 的 `pwsh` 调用，
  在看不清运行时一律 fail-closed；
- `tools/pre-execute` 是异步瀑布，跑在 guard 之前；每次 `pwsh` 调用按 60 秒 TTL 刷新 gate，
  所以“刚装好 / 刚改 profile”不必等用户手动点状态；
- 插件的恢复工具 `pwsh7_status` / `pwsh7_install` **永远不被 gate**——它们是拒绝文案指出的出路；
- 拒绝文案自带三条路与“不要重试”，模型不必先调另一个工具才知道发生了什么。

## 4. 安装：Store 页面 + UI Automation，且由用户触发

没有启动时自动安装。`pwsh7_install` 先要 `vpnOffConfirmed: true`，然后把 UIA 脚本写成
**UTF-8 BOM 的临时 `.ps1`**，用系统 Windows PowerShell 5.1 启动：打开 Store 产品页、
弹出说明框，再用 UI Automation 找本地化的「安装 / 获取 / Install / Get / 更新」按钮并点击。
点击不等于装好：作业随后有界复检（8 次 × 15 秒），以运行时可解析为最终判据。

连续 3 次脚本安装失败后熔断：不再启动作业，先让用户确认 VPN / 网络；只有用户明确说
“问题已解决”后，模型才能带 `userConfirmedFixed: true` 再试一次。计数只在当前 Host 进程内。

## 5. 与 dsh-ops 共存交给 dsh-ops 自己

0.2.8 起本插件不再拥有共存状态。dsh-ops 0.5.0 增加「dsh-win-pwsh7 联动」：检测到本插件时
保持官方 `pwsh` 可见，让本插件继续管理它指向的 PowerShell 版本；官方 `read` / `glob` / `grep`
仍由 dsh-ops 的预设开关隐藏。联动是 dsh-ops 的配置，读写都在它自己的插件页，不依赖 bundle
顺序，也不要求本插件写 profile 补丁或在 agent 作用域隐藏工具。

本插件由此删除了整个 `dsh-ops-bridge`：没有 `dshOpsCompat` 配置、没有 `dsh-ops-compat`
覆盖、没有 `tools.restrict` 隐藏层。需要 dsh-ops >= 0.5.0；旧版本升级后如果 profile 里残留
带 `# dsh-win-pwsh7: ... (managed)` 的块，手动删除即可。

历史教训仍保留在[经验 02](experience/02-隐藏恢复振荡.md)：桥接层从限制后的可见集合规划时，
hide → restore 会互相触发。删除桥并没有否定那条教训——它说明隐藏工具应当由拥有工具面的
插件负责，而不是由版本探测插件代劳。

## 6. UTF-8 控制台桥是过渡层

宿主收集器按 UTF-8 解码输出，但命令里再启动的 `pwsh -File` / `powershell -File` 会继承
**控制台代码页**（简体中文机器通常是 936）并输出 GBK，于是中文变成 `�`。宿主的
`ENCODING_PREAMBLE` 只固定外层进程的 .NET 编码，没有改控制台代码页。

0.2.5 起用 `lib/utf8-console-bridge.js` 包装 `ctx.shell.execute`，在 Windows 命令前加
`chcp.com 65001 > $null;`。默认开启、可用 `utf8Console: false` 关闭、形状不符时 fail-open。
上游修复后按 [README 的删除契约](../README.md) 整块删除；判定条件与证据见
[经验 04](experience/04-嵌套pwsh乱码.md)。

## 7. 不能破的不变量

| 不变量 | 原因 |
| --- | --- |
| 不写执行器的 `pwshPath` | 插件只探测与推荐；接线是用户的 profile patch |
| 不写 profile 补丁 | 共存由 dsh-ops 自己管理；插件只探测与推荐，不替用户改 bundle |
| 只 pin 普通文件或 Store 家族别名 | 版本号目录会随 Store 更新移动 |
| gate fail-closed，UTF-8 过渡层 fail-open | 前者关系到“会不会跑错运行时”，后者只是编码增强 |
| 八本字典同一套键（zh / en / ja / de / es / fr / pt / ru） | 缺一本会在切换语言时回退或漏字；client 门会拦 |
| 插件自己的两个工具不被 gate | 否则被拦后没有恢复路径 |
| 公开文档只写已发生的事实 | 计划与过程留在 `docs-private/`，避免文档变成愿望清单 |

## 8. 已知取舍

- `hostContext` 仍是模块级，dispatch 服务用它找最新一次激活的 context；同一进程出现第二行
  或热重载时以最新为准（源码里记为 backlog）。
- gate 刷新会 spawn 探针（override / resolver / 行 / shell），TTL 60 秒；首次调用比后续慢。
- CI 不跑 host 三套门：它们需要真实 Windows DSH 安装，发布前在本机跑（见
  [验收记录](testing.md)）。
- Store 页面已安装时可能显示「打开」，脚本只匹配安装类按钮；这是“检测不到但确实已装”的
  边缘情况，报告会把用户引向 VPN 建议。它属于已知限制，改进方向记在私有待办。

## 9. 多语言

插件自有文案覆盖 DSH 的 **8 种官方语言**（zh / en / ja / de / es / fr / pt / ru），八本字典
注册进 `ctx.locale`，键集必须一致；`locale/*.json` 为每种语言提供包标题与描述。中 / 英为
人工撰写，日 / 德 / 西 / 法 / 葡 / 俄为机器翻译（人工粗校）。

`locale/*.json` 是宿主**启动时**读取的包元数据，改完要重启 DSH；`client.js` 里的界面字典
跟随页面刷新/客户端热重载。client 门强校验八本键集、非空、`en` 无 CJK 与八份 meta。
