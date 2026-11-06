# 安全策略

## 支持范围

| 版本 | 安全更新 |
| --- | --- |
| 0.2.x（最新） | ✅ |

旧的无 `engines.dsh` 版本（0.12.x / 早期 0.1x）不再维护。

## 报告漏洞

请**不要**用公开 Issue 报告安全问题。通过 GitHub 仓库的
**Security → Report a vulnerability**（私有披露）提交，并说明：

- 影响版本（插件版本 + DSH 桌面壳 / Harness 内核版本）；
- 复现步骤；
- 影响面（能否执行未授权的命令、读取不该读的文件、写入 profile 之外的位置、诱导打开外部链接等）。

我们会在 7 天内给出初步确认；修复后记录到 `CHANGELOG.md`。

## 这个插件会做什么、不会做什么

它以**当前用户的权限**运行在 Host 与 Web 两半：

**会**

- 读取执行器（`ctx.shell`）解析到的 `pwshPath`，并 spawn 它执行版本探针；
- 注册两个工具（`pwsh7_status` / `pwsh7_install`）和一个同步 gate；
- 在用户调用 `pwsh7_install` 并确认 VPN 后，打开 Microsoft Store 页面并用 UI Automation
  点击安装按钮；脚本以临时 UTF-8 BOM 文件放在系统临时目录，作业结束/取消后删除；
- 在 Web 半读取 `configForms` 与 Remote `status`，渲染插件页卡片；样式只用主题 token，卸载即移除。

**不会**

- 不联网（Store 页面由用户触发的系统 URI 打开，插件自身没有网络请求）；
- 不读取或上传凭据、会话内容、用户文件；
- 不收集遥测；
- 不写执行器的 `pwshPath`，不替用户接线路；
- 不写任何 profile 补丁，也不隐藏官方工具：共存由 dsh-ops 0.5.0+ 的原生联动负责；
- 不卸载或修改 Microsoft Store 安装的 PowerShell 7；
- 不需要管理员权限。

## 已知边界

- 插件贴在 DSH 的内部契约上（`pwshPath` getter、`tools.guard`、`configEditor`、客户端槽位），
  DSH 升级失配时优先表现为“工具/页面静默消失”，不会破坏宿主数据；
- UI Automation 使用的是与人类相同的 Store 页面与按钮，权限边界由 Windows / Store 决定；
- 与 dsh-ops 的共存由 dsh-ops 0.5.0+ 的「dsh-win-pwsh7 联动」管理；本插件不修改 dsh-ops 本体，
  也不在 agent 作用域隐藏工具；
- UTF-8 控制台桥是过渡层，会在每条 `pwsh` 命令前加 `chcp.com 65001 > $null;`，可用
  `utf8Console: false` 关闭。
