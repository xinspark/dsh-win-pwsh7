# 故障排查

先跑 `pwsh7_status`（或插件页的「重新检测」），它以执行器实际解析到的路径为准；下面的表
按症状给出下一步。

| 症状 | 最可能的原因 | 处理 |
| --- | --- | --- |
| 插件装完，两个工具和插件页都不见了 | `engines.dsh` 与运行中的 DSH 不匹配，loader **静默跳过** bundle | 看 `package.json` 的 `engines.dsh` 与 DSH 版本；升级插件（见 [经验 01](../experience/01-engines静默跳过.md)） |
| 插件页看不到，但工具在 | 当前 profile 没启用 bundle，或装完没重启 | 确认 profile 的 bundles 含 `dsh-win-pwsh7`，重启 DSH |
| `pwsh` 仍运行 Windows PowerShell 5.1 | 执行器没有解析到 PS7，或 profile 里 pin 了 5.1 | 按 `pwsh7_status` 报告贴 `pwshPath` 补丁并重启；或安装 Store 版 |
| `pwsh` 每次调用都报 “cannot start” | 执行器 pin 的 `pwshPath` 不存在，且不回落 | 换掉或删掉那条 `pwshPath`；`pwsh7_status` 会给当前行内容 |
| 装好 Store 版，`pwsh` 还是被拦 | 执行器缓存了旧的 5.1 路径 | 调一次 `pwsh7_status`（会触发受控刷新）；仍不行则按补丁 pin + 重启 |
| Store 页面打开但没有「安装」按钮 | VPN / Store 状态问题；或页面已装显示「打开」 | 关 VPN、完全退出并重启 Microsoft Store 再试；或用手动 Win+R 路径；已装则直接 `pwsh7_status` |
| 连续 3 次脚本安装失败，工具不再启动作业 | 熔断器 | 先确认 VPN / 网络，用户明确说修好后再带 `userConfirmedFixed: true` 重试一次 |
| 命令里嵌套 `pwsh` / `powershell`，中文变 `�` | 控制台代码页 936，宿主按 UTF-8 解码 | 确认 `utf8Console` 没被关掉（默认开）；或命令前手动加 `chcp.com 65001 > $null;` |
| 装了 dsh-ops，`pwsh` 仍不可见 | 联动没开，或 dsh-ops < 0.5.0 | 确认 dsh-ops 版本 ≥ 0.5.0；在 dsh-ops 插件页「其他」区打开「dsh-win-pwsh7 联动」；重启 DSH |
| 升级 0.2.8 后 profile 里还有 `# dsh-win-pwsh7: ... (managed)` 块 | 旧版本写过的兼容覆盖，新版本不再管理 | 手动删除带该标记的整个块（不要动无标记的用户条目），重启 DSH |
| 状态卡一直「检测中」或显示失败 | Remote 端点未挂载 / Host 行未激活 | 确认行是 active；重启 DSH；看 Host 日志里的 `dsh-win-pwsh7:` 前缀 |
| 插件的两个工具本身也被拦 | 不应发生 | gate 明确放行 `pwsh7_status` / `pwsh7_install`；若被拦，附日志开 issue |

## 采集证据

- 插件版本（`package.json`）与 DSH 版本（`dsh.verifiedAgainst` 是验证基线，不是安装版本）；
- `pwsh7_status` 的完整报告；
- Host 日志里 `dsh-win-pwsh7:` 开头的行；
- 若是 silently missing，附 profile 的 `package.json` bundles 与 loader 的 `skippedBundles`。

## 不要做的事

- 不要用「重装插件」当第一反应：先分清是 loader 跳过、profile 未启用、还是执行器 pin 了错路径；
- 不要 pin 版本号 Store 目录；
- 不要在公开 issue 里贴本机用户名下的完整路径或凭据；本机路径可以换成 `<home>`。
