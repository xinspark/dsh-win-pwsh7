# 版本兼容

> 验证基线、`engines.dsh` 规则与 DSH 升级对账流程。逐符号证据见
> [原生契约](native-contracts.md)；门的命令与覆盖见 [验收记录](../testing.md)。

## 当前基线

| 项 | 值 |
| --- | --- |
| 验证过的 DSH | **0.2.2-rc.3**（`package.json` 的 `dsh.verifiedAgainst`） |
| 桌面壳 | 2.0.23-next |
| 插件版本 | 0.2.10（五套门已绿；实例已安装；求星行 order 80 在 market source 90 之前） |
| 支持范围 | `>=0.2.1-rc.3 <0.3.0-0` |
| 平台 | Windows 10/11 |
| 权限 | 不需要管理员权限 |

## engines.dsh 的上下界

- **下界** `>=0.2.1-rc.3`：低于此版本的 `ctx.shell.pwshPath` / `tools.guard` 契约不完整；
- **上界** `<0.3.0-0`：DSH 常常以“下一个补丁的预发布”发布修复（例如 0.2.2-rc.1）。
  把上界写成 `<0.2.2-0` 会让 loader 在每次补丁更新后**静默跳过**本包：不装、不报错，
  工具、gate、页面、UTF-8 桥一起消失。上界因此按**次版本**划。

loader 跳过一个 bundle 时只把它记进 `skippedBundles`，屏幕上没有提示；唯一可见痕迹通常是
`patch: entry "win-pwsh7" not found`。这是 0.2.5 在 0.2.2-rc.1 上失效的原因，见
[经验 01](../experience/01-engines静默跳过.md)。

## DSH 升级对账流程

1. 记录新实例版本（桌面壳 + Harness 内核）与 `app.asar` 大小；
2. 设 `DSH_APP_DIR` 指向安装根 / `resources/app` / `resources/app.asar`；
3. 跑四套门：`check-host`、`check-client`、`check-utf8-bridge`、`check-native-contracts`；
4. native 门变红时，按 `docs/reference/native-contracts.md` 的符号逐项核对上游改动；
   **不要只改断言让它变绿**——先判断契约是否真的还在；
5. 复核客户端槽位仍存在（`plugins.row.config`、`plugins.detail.section`）、
   `TOOL_PWSH` 顺序仍可用、`PwshLocalExecutor.pwshPath` 仍是 getter；
6. 检查上游 `ENCODING_PREAMBLE` 是否已自带 `chcp.com 65001`（决定 UTF-8 桥能否删）；
7. 全绿后再更新 `dsh.verifiedAgainst`、`docs/reference/native-contracts.md` 的基线表与
   `CHANGELOG.md`；未跑过的版本不得写成“已验证”。

## 支持矩阵

| DSH | 结果 |
| --- | --- |
| `< 0.2.1-rc.3` | 不支持；loader 跳过 |
| `0.2.1-rc.3` ~ `0.2.1-rc.4` | 0.2.5 已验证 |
| `0.2.2-rc.1` | 0.2.6 验证加载；0.2.7 / 0.2.8 / 0.2.9 在该基线上发布 |
| `0.2.2-rc.3` | **0.2.10 五套门已验证**（native 38 项；桌面壳 2.0.23-next） |
| `0.2.x` 更高补丁 | 范围内；升级后按上面的流程复核 |
| `>= 0.3.0-0` | 不支持；loader 跳过，等新版本适配 |

## 已知限制

- 客户端槽位名不在 native 门里：它由 client 门用桩上下文覆盖注册行为，真实槽位仍是发布前
  实机检查项；
- Store UI 安装是端到端行为，自动化门只驱动脚本与作业，不点真实 Store；
- 上游内部契约没有兼容承诺：升级失配时优先表现为“工具/页面静默消失”，不会破坏宿主数据。
