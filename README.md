# dsh-win-pwsh7

<p align="center"><sub>简体中文 · <a href="README.en.md">English</a></sub></p>

把**真正的 PowerShell 7** 交给 Windows 上的 Harness `pwsh` 工具，而不是悄悄退回 Windows PowerShell 5.1。

1. **检测**这台机器上的 PowerShell 7（含可选的 `overridePath`）；
2. **校验**显式路径（`pwsh7_status` 的 `path` 参数）；
3. **安装**：脚本安装（`pwsh7_install` 打开 Microsoft Store 页面并点击安装）或手动安装（Win+R 打开同一个 Store 链接）。**没有启动时自动安装。**

启用本插件期间，`pwsh` 工具**只在实际执行器解析到 PowerShell 7+ 时才放行**；否则每次调用在 dispatch 之前被 `ctx.tools.guard` 拒绝，错误文案给用户三条路：**配置已装的 PowerShell 7 / 安装 / 禁用插件**，并且不会启动任何 PowerShell 进程。禁用插件即移除 gate，之后由默认执行器自行选择运行时，插件仍然不写 `pwshPath`。

## 验证环境

- Windows 10/11。
- 已在 DSH **0.2.2-rc.3** 上验证（见 `package.json` 的 `dsh.verifiedAgainst`）。
- 支持范围 `>=0.2.1-rc.3 <0.3.0-0`：收紧到"下一个预发布"会让 loader 在 DSH 每次小版本更新后**静默跳过**本插件
  （不装、不报错、`pwsh` 失去 gate 和 UTF-8 过渡层），所以上界按**次版本**划。
- 脚本安装需要 Microsoft Store 可用；手动安装只需要能打开 Store 页面。
- 不需要管理员权限。

完整文档见 [docs/README.md](docs/README.md)；私有维护材料不随包发布。npm 包页上的相对文档链接可能 404，以 GitHub 仓库为准。

## 它不做什么

- 不在启动时自动安装。
- 不写执行器的 `pwshPath`；与 dsh-ops 的共存由 dsh-ops 0.5.0+ 的原生「dsh-win-pwsh7 联动」负责，本插件不写 profile 补丁，也不隐藏工具。
- 不卸载由 Store 安装的 PowerShell 7。
- 不做 VPN 自动检测，也不做计量连接预检。

## 与 dsh-ops 共存

从 0.2.8 起，共存交给 dsh-ops 自己：**dsh-ops 0.5.0+** 检测到本插件后会自动打开「dsh-win-pwsh7 联动」，保持官方 `pwsh` 可见，`ops_bash` 继续发布；官方 `read` / `glob` / `grep` 由 dsh-ops 的预设开关隐藏。本插件不再写 `cordis.patch.yml`、不写兼容覆盖，也不在 agent 作用域隐藏工具。

需要 dsh-ops 0.5.0 或更高版本。旧版 `dshOpsCompat` 开关和 `dsh-ops-compat` 覆盖已在 0.2.8 移除；如果旧版本在 profile 补丁里留下带 `# dsh-win-pwsh7: ... (managed)` 的块，升级后手动删除。联动开关位于 dsh-ops 插件页的「其他」区；关闭后按 dsh-ops 自己的策略隐藏宿主 `pwsh`。

历史：0.2.1 的桥接层在计算隐藏集合时读取了限制后的可见工具，会在隐藏/恢复之间振荡并卡死宿主；0.2.2 改为读取限制前的 `knownNames` / `restrictableNames`。该桥已在 0.2.8 整体删除，经验留在[项目经验](docs/experience/02-隐藏恢复振荡.md)。

## 安装本插件

```powershell
# 从 GitHub 安装（推荐锁定 tag）
dsh plugin --profile desktop add github:XinSpark/dsh-win-pwsh7#v0.2.10
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
| `utf8Console` | `true` | 过渡层：Windows 下给 `pwsh` 工具的每条命令前加 `chcp.com 65001`，避免嵌套 `pwsh -File` 按 936 输出 GBK 后被按 UTF-8 解码成乱码。宿主修复后可删除。 |

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

插件页的状态区是原生卡片，显示状态、运行时和执行器路径，右上角有「重新检测」；配置区只有 `overridePath` 输入，右侧有「选择...」按钮：Desktop 会打开系统文件对话框，选中的 `pwsh.exe` 由宿主路径桥回填为绝对路径；普通浏览器没有这个桥时提示直接填写（共存开关已随 dsh-ops 桥删除，由 dsh-ops 页面管理）。页面最底部（状态卡下方、页脚「查看仓库」之前）有一行求星提示（`⭐` 字符，文案跟随界面语言；不重复造仓库链接）。

## 多语言

插件自有文案跟随 DSH 的 **8 种官方语言**实时切换：中 / 英 / 日 / 德 / 西 / 法 / 葡 / 俄。
界面字典在 `client.js`（`DICT_ZH` / `DICT_EN` / `DICT_JA` / `DICT_DE` / `DICT_ES` / `DICT_FR` /
`DICT_PT` / `DICT_RU`），包标题与描述在 `locale/*.json`，每种语言一份。

- 中 / 英为人工撰写；**日 / 德 / 西 / 法 / 葡 / 俄为机器翻译**（人工粗校），个别措辞可能不自然——欢迎提 Issue/PR 纠正；
- **只改 `locale/*.json` 的包标题/描述需要重启 DSH**：宿主在启动时读取这份元数据，刷新页面不会变；
  `client.js` 里的界面字典刷新页面即可生效；
- 新增文案必须同时补齐 8 本字典；`npm run check` 的 client 门会强校验键集一致、非空、`en` 无 CJK，以及 8 份 locale meta。

## Windows UTF-8 控制台（过渡层）

DSH 的 `pwsh` 工具按 UTF-8 解码输出，但命令里再启动的 `pwsh -File` / `powershell -File` 会继承**控制台代码页**（简体中文机器通常是 936），输出 GBK，最终显示为 `�`。宿主的前缀只固定了外层进程的 .NET 编码，没有改控制台代码页。

0.2.5 增加一个过渡层：包装 `pwsh` 工具使用的 `ctx.shell.execute`，在 Windows 上给每条命令前加 `chcp.com 65001 > $null;`。它只影响装了本插件的用户；默认开启，可用 `utf8Console: false` 关闭；宿主接口形状不符时 fail-open，不影响 `pwsh` 工具本身。

### 删除契约

宿主发布同样的修复后，按这五步整块删除：

1. 删 `lib/utf8-console-bridge.js`；
2. 删 `index.js` 的 import 和 `mountUtf8ConsoleBridge(ctx, current)` 调用；
3. 删 `Config.utf8Console`；
4. 删 `tools/check-utf8-bridge.mjs`，并从 `package.json` 的 `check` 链里移除；
5. 删本节和 CHANGELOG 里的 0.2.5 过渡说明。

验收：`grep -rn "utf8-console-bridge\|utf8Console" index.js lib tools` 无结果。

### 判定上游已修复

满足任一条件即可开始删除：

- `@deepseek-ai/dsh-pwsh-local` 的 `ENCODING_PREAMBLE` 自己包含 `chcp.com 65001`（可查上游
  `packages/shell/pwsh-local/src/index.ts`，或安装包里的 `lib/index.js`）；
- 在 CP936 控制台下，不装/关闭本插件时，命令里嵌套的 `pwsh -File` 已经输出 UTF-8。

删除前先在真实的 CP936 环境复跑一遍嵌套脚本，确认不再需要这层。

## 禁用或卸载

禁用插件只移除 `pwsh` 的 gate 和插件页，不会卸载 PowerShell 7。只要机器上仍有 `pwsh.exe`，默认执行器仍会优先运行它（通常是 Store 版 PowerShell 7）；只有找不到 `pwsh.exe` 时才回退到 Windows PowerShell 5.1。要真正回到 5.1，需要卸载 Store 版或把执行器 pin 到 `powershell.exe`，不推荐这样做。

## 故障排查

| 现象 | 处理 |
|---|---|
| Store 页面打开但没有「安装」按钮 | 确认 VPN 已关闭，完全退出并重启 Microsoft Store 后重试；或改用手动安装。 |
| `pwsh` 仍运行 5.1 | 运行 `pwsh7_status`，按报告把 `pwshPath` 补丁粘进 profile 并重启；或安装 Store 版。 |
| 插件页看不到 | 确认当前 profile 已启用 `dsh-win-pwsh7`，然后重启 DSH。 |
| 命令里嵌套 `pwsh` 时中文变 `�` | 0.2.5 默认已由 `utf8Console` 过渡层处理；若手动关掉，重新开启，或在命令前加 `chcp.com 65001 > $null;`。 |

## 验证

```powershell
$env:DSH_APP_DIR = 'E:\FXS\APP\DSH NEXT\resources\app.asar'
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-utf8-bridge.mjs
node tools/check-native-contracts.mjs
node tools/check-docs.mjs
```

五套门都可以离线复跑：`host` / `native` 需要 `DSH_APP_DIR` 指向安装根、`resources/app` 或
`resources/app.asar`；`client` / `utf8` / `docs` 不依赖实例。覆盖范围与发布前实机清单见
[验收记录](docs/testing.md)。

## 文档

| 我想… | 看 |
|---|---|
| 配置两个键 | [配置](docs/guide/configuration.md) |
| 处理故障 | [故障排查](docs/guide/troubleshooting.md) |
| 理解判定 / gate / 共存 | [设计说明](docs/design.md) |
| 核对上游契约 | [原生契约](docs/reference/native-contracts.md) |
| DSH 升级对账 | [版本兼容](docs/reference/compatibility.md) |
| 跑门与实机清单 | [验收记录](docs/testing.md) |
| 踩过的坑 | [项目经验](docs/experience/README.md) |
| 维护与发版 | [MAINTAINING.md](MAINTAINING.md) |

## 设计约束

- 判定读执行器自己的 `ctx.shell.pwshPath`，不是扫配置行；`overridePath` 只影响探测与推荐。
- 不做 VPN 自动检测、不做计量连接预检；VPN 由用户在安装前确认，页面加载失败时再提示。
- 不自动重试；连续失败由熔断终止。
- 发布前跑五套门；端到端安装是发布证据，不是自动化门的一部分。

## License

[MIT](LICENSE)
