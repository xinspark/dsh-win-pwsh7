# 0.13.0 验收清单（work-exp）

本文件只给验收用；`work-exp` 里安装的是本分支的 `link:` 包（0.13.0），不是发布版。

## 前置

- 旧版 `dsh-win-pwsh7` 从**其他 profile**（如 `desktop`）卸载；`work-exp` 里的这份**不要卸载**，它就是要验收的 0.13.0。
- PowerShell 7 已卸载，机器上只剩 Windows PowerShell 5.1。
- 启动 `work-exp` 后打开「插件」→ `dsh-win-pwsh7`，确认它是启用状态。

> PowerShell 7 请在启动 `work-exp` **之前**卸载。执行器在构造时缓存解析出的 `pwshPath`；如果先启动、后在外部卸载 PS7，需要重启 `work-exp` 让它重新解析（否则门禁会以“路径不存在/无法判定”而不是“5.1”来拒绝）。

## 1. 状态页（pull）

详情页的「PowerShell 7 状态」应显示：

- `Executor rows:` 下有 `pwsh-sandbox : (pwshPath not set — the executor probes well-known locations itself)`；
- `PowerShell 7: not usable — only Windows PowerShell 5.1 is available.`；
- `Two ways forward:` 安装 / 禁用；
- **没有** `- id: pwsh-sandbox` 的 patch 块（因为当前没有可 pin 的 PS7）；
- 如果当前网络被标为计量，报告里会多一段 `marked as metered`，详情页出现网络行。

## 2. 调用 `pwsh`（push）

让模型执行任意 PowerShell 命令（例如 `pwsh -Command "Get-Host"`）。期望：

- 工具**报错**，内容以 `Error: dsh-win-pwsh7 blocked this call:` 开头；
- 原因是 `the pwsh tool would run Windows PowerShell 5.1 (C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe)`；
- 含 `Do not retry.`，以及 `pwsh7_status` / `pwsh7_install` / `disable dsh-win-pwsh7` 三条路；
- **命令没有执行**（没有输出、没有副作用）。

模型应当在回复里向用户说明：需要安装或配置 PowerShell 7，或禁用插件。

## 3. 恢复通道

- `pwsh7_status` 必须仍可调用，返回上面的报告。
- `pwsh7_install` 必须仍可调用，并且**先预检**：
  - 计量连接 / `Unknown` / 探测失败 / 无 winget → **不启动 job**，报告点名网络、要关掉的「按流量计费的连接」、验证方式与手动命令；
  - 非计量且 winget 可用 → 启动后台作业，返回 job id。
- 不要求真的装完；看返回文本/作业号即可。**注意**：如果网络正常，`pwsh7_install` 会真的重新安装 PowerShell 7；不想恢复就不要运行它。

## 4. 禁用插件

- 在插件页关闭 `dsh-win-pwsh7`（必要时重启/重载）。
- `pwsh` 恢复默认行为（5.1 可执行），不再有门禁错误；
- 提示段、`pwsh7_status` / `pwsh7_install` 一起消失；
- 重新启用后门禁回来。

## 5. 配置卡

`overridePath` 的 hint 应明确写出：它只影响插件的探测与推荐，**不会**给 `pwsh` 接线；接线用状态区给出的 profile patch。

## 6. 回滚与恢复

- 验收前备份：`work-exp/package.json.bak-before-pwsh7-20261027`、`pnpm-lock.yaml.bak-before-pwsh7-20261027`。
- 验收失败时：用备份覆盖 `package.json` / `pnpm-lock.yaml`，在该 profile 执行 `pnpm install --prefer-offline`，并移除 `node_modules/dsh-win-pwsh7`。
- 想恢复 PowerShell 7：在 `work-exp` 里让模型运行 `pwsh7_install`，或从 Microsoft Store 安装。

## 7. 记录

把错误原文、状态页文本（截图或复制）留下；如果文案与上面的期望不一致，直接贴出来。
