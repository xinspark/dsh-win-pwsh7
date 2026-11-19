# 版本兼容

> 验证基线、`engines.dsh` 规则与 DSH 升级对账流程。逐符号证据见
> [原生契约](native-contracts.md)；门的命令与覆盖见 [验收记录](../testing.md)。

## 当前基线

| 项 | 值 |
| --- | --- |
| 验证过的 DSH | **0.2.2-rc.5**（`package.json` 的 `dsh.verifiedAgainst`） |
| 桌面壳 | 2.0.24-next |
| 插件版本 | 0.3.0（四套门已绿；实例已安装并实机复核） |
| 支持范围 | `>=0.2.1-rc.3 <0.3.0-0` |
| 平台 | Windows 10/11 |
| 权限 | 不需要管理员权限 |

## engines.dsh 的上下界

- **下界** `>=0.2.1-rc.3`：低于此版本的 `ctx.shell.pwshPath` / `tools.guard` 契约不完整；
- **上界** `<0.3.0-0`：DSH 常常以“下一个补丁的预发布”发布修复（例如 0.2.2-rc.1）。
  把上界写成 `<0.2.2-0` 会让 loader 在每次补丁更新后**静默跳过**本包：不装、不报错，
  工具、gate、页面一起消失。上界因此按**次版本**划。

loader 跳过一个 bundle 时只把它记进 `skippedBundles`，屏幕上没有提示；唯一可见痕迹通常是
`patch: entry "win-pwsh7" not found`。这是 0.2.5 在 0.2.2-rc.1 上失效的原因，见
[经验 01](../experience/01-engines静默跳过.md)。

## DSH 升级对账流程

1. 记录新实例版本（桌面壳 + Harness 内核）与 `app.asar` 大小；
2. 设 `DSH_APP_DIR` 指向安装根 / `resources/app` / `resources/app.asar`；
3. 跑 **包级对账**：`node tools/reconcile-build.mjs --from <上一个验证过的内核版本>` ——
   它只比**两边都有的文件**的字节；退出码 1 表示真代码变了（先读那几个文件），0 表示
   **零迁移**：抬基线是声明，不是移植；
4. 跑四套门：`check-host`、`check-client`、`check-native-contracts`、`check-docs`；
5. native 门变红时，按 `docs/reference/native-contracts.md` 的符号逐项核对上游改动；
   **不要只改断言让它变绿**——先判断契约是否真的还在；
6. 复核客户端槽位仍存在（`plugins.row.config`、`plugins.detail.section`）、
   `TOOL_PWSH` 顺序仍可用、`PwshLocalExecutor.pwshPath` 仍是 getter；
7. 编码不再由本插件负责（0.3.0 删除了过渡层）：若怀疑宿主改了编码契约，用
   `0.3.0` 之前的 `--cp936` 实验思路重做一次对照（关掉任何前缀、控制台停在 936、看嵌套输出）；
8. 全绿后再更新 `dsh.verifiedAgainst`、`docs/reference/native-contracts.md` 的基线表与
   `CHANGELOG.md`；未跑过的版本不得写成“已验证”。

## 支持矩阵

| DSH | 结果 |
| --- | --- |
| `< 0.2.1-rc.3` | 不支持；loader 跳过 |
| `0.2.1-rc.3` ~ `0.2.1-rc.4` | 0.2.5 已验证 |
| `0.2.2-rc.1` | 0.2.6 验证加载；0.2.7 / 0.2.8 / 0.2.9 在该基线上发布 |
| `0.2.2-rc.3` | 0.2.11 五套门已验证（native 41 项；桌面壳 2.0.23-next） |
| `0.2.2-rc.5` | **0.3.0 四套门已验证**（native 40 项；桌面壳 2.0.24-next）；包级对账 **零迁移**——12 个包在两个版本的 npm tarball 里逐文件字节相同；UTF-8 过渡层在该基线上实机确认可删 |
| `0.2.x` 更高补丁 | 范围内；升级后按上面的流程复核 |
| `>= 0.3.0-0` | 不支持；loader 跳过，等新版本适配 |

## 已知限制

- 客户端槽位的**名字、`kind` 与渲染点**已进 native 门（0.2.11 起读
  `dsh-client-ui-plugin-manager/lib/client.js` 的槽位声明）；门的**外观**与真实浏览器行为仍是发布前
  实机检查项；
- Store UI 安装是端到端行为，自动化门只驱动脚本与作业，不点真实 Store；
- 上游内部契约没有兼容承诺：升级失配时优先表现为“工具/页面静默消失”，不会破坏宿主数据。
