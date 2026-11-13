# 验收记录

> 自动化门 + 发布前实机清单。每次发版把结果补进文末的验收表。

## 自动化门

| 命令 | 覆盖 | 不覆盖 |
| --- | --- | --- |
| `node tools/check-host.mjs` | 桩 Host 上下文下注册两个工具、`output.render`、报告/策略、gate 判定与刷新、安装作业与熔断、`engines.dsh` 形状；静态断言 dsh-ops 兼容桥已删除 | 真实宿主交互、真实 Store |
| `node tools/check-client.mjs` | 桩 React 渲染三份贡献：配置卡、状态卡、独立求星行（id/order 80/locale/按 subject 自过滤）；8 本字典键集/非空、`en` 无 CJK、8 份 `locale/*.json` meta | 外观、真实浏览器 |
| `node tools/check-utf8-bridge.mjs` | 前缀、关闭开关、幂等、卸载恢复、形状不符 fail-open | 真实 CP936 控制台 |
| `node tools/check-native-contracts.mjs` | 读本机 `app.asar`，核对 12 个包的 38 项符号/行为（getter、guard、pipeline、jobs、slots、编码 preamble 等） | 客户端槽位实机名 |
| `node tools/check-docs.mjs` | 公开文档相对链接与锚点 | 文档内容正确性 |

host / client / utf8 / native 四套门需要 Node 22+；native 与 host 还需要本机装有 DSH，
用 `DSH_APP_DIR` 指定安装位置。CI 只跑 client 与 docs 两套（见
[`.github/workflows/ci.yml`](../.github/workflows/ci.yml)）。

```powershell
$env:DSH_APP_DIR = '<install root>'
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-utf8-bridge.mjs
node tools/check-native-contracts.mjs
node tools/check-docs.mjs
```

## 发布前实机清单

| # | 项 | 判据 |
| --- | --- | --- |
| 1 | 干净 profile 安装 | bundle 出现在 profile；重启后插件行 active |
| 2 | 插件页 | 状态卡显示状态 / 运行时 / 执行器；Re-detect 可用；路径输入右侧「选择...」在 Desktop 打开系统文件对话框并回填绝对路径；求星行是独立 section（order 80，市场来源行之前），其他插件页不出现 |
| 3 | 8 种语言切换 | 两张卡与求星行跟随中/英/日/德/西/法/葡/俄；`en` 无中文；包标题/描述需重启后跟随 |
| 4 | gate 放行 | 执行器解析到 PowerShell 7 时，`pwsh` 能执行 `&&` |
| 5 | gate 拒绝 | 执行器解析到 5.1 或 pin 不存在时，调用被拦且不启动进程；文案给出三条路 |
| 6 | 恢复工具 | 被拦时 `pwsh7_status` / `pwsh7_install` 仍可调用 |
| 7 | 安装脚本（可选） | VPN 确认门、Store 说明框、点击安装、作业可读/可取消；失败 3 次熔断 |
| 8 | dsh-ops 共存（原生联动） | dsh-ops ≥ 0.5.0 打开「dsh-win-pwsh7 联动」：`pwsh` + `ops_bash` 并存，官方文件工具不重复；关掉联动后按 dsh-ops 自己的策略隐藏 `pwsh`；本插件不写 profile |
| 9 | UTF-8 | CP936 机器上嵌套 `pwsh -File` 输出中文不再是 `�`；关掉 `utf8Console` 能复现 |
| 10 | 卸载 | 插件行移除；gate 消失；本插件不写 profile 块，无残留；PowerShell 7 不被卸载 |

## 验收表

| 版本 | 内核 | 自动化 | 实机 | 记录 |
| --- | --- | --- | --- | --- |
| 0.2.6 | 2.0.22-next / 0.2.2-rc.1 | 四套门全绿（native 37 项） | 发版前本机复跑 | `CHANGELOG.md` 0.2.6 |
| 0.2.7 | 2.0.22-next / 0.2.2-rc.1 | 五套门全绿（native 38 项；文档 22 篇） | 插件已激活；`pwsh7_status` 可用；实时 Slots: diagnostics(50) → star(80) → market source(90) | [Release v0.2.7](https://github.com/XinSpark/dsh-win-pwsh7/releases/tag/v0.2.7) + `CHANGELOG.md` 0.2.7 |
| 0.2.8 | 2.0.22-next / 0.2.2-rc.1 | 五套门全绿（native 38 项；文档 22 篇） | 插件 0.2.8 已激活（:53418）；工具面 88 项：`pwsh` + `ops_bash` 可见，`read` / `glob` / `grep` / `bash` / `pwsh_persistent` 均不存在；Slots: diagnostics(50) → star(80) → market source(90) | [Release v0.2.8](https://github.com/XinSpark/dsh-win-pwsh7/releases/tag/v0.2.8) + `CHANGELOG.md` 0.2.8 |

## 说明

- `prepublishOnly` 跑 `npm run check`（五套门）；发布工作流在 Linux 上只能跑 client 与
  docs，所以 host 三套门是**打 tag 前**的本机动作，不是 CI 的替代品；
- 端到端 Store 安装是发布证据，不是自动化门的一部分；自动化门里的 Store 脚本由桩数据驱动；
- 任何一项未跑，不要把版本写成“已验证”。
