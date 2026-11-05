# 贡献指南

感谢你愿意参与。这是一个 **Windows 上的 DSH 插件**：Host 半 `index.js` 负责检测、gate、
安装作业与 Remote，Web 半 `client.js` 负责插件页的两张卡；没有构建步骤，写进文件的就是
实际执行的代码。

## 环境要求

| 依赖 | 版本 | 说明 |
| --- | --- | --- |
| Node.js | ≥ 22 | 跑 `tools/` 下的校验门，不需要安装依赖 |
| DSH | 见 [版本兼容](docs/reference/compatibility.md) | 验证基线 0.2.2-rc.1 |
| Windows | 10/11 | Host 半在非 Windows 直接返回；gate 与安装只对 Windows 有意义 |
| PowerShell 7 | 可选 | 本机有 PS7 也能跑门：host 门把探测路径指到临时 fixture |

## 本地开发

```powershell
git clone https://github.com/XinSpark/dsh-win-pwsh7.git
cd dsh-win-pwsh7
$env:DSH_APP_DIR = '<install root>'   # 安装根 / resources/app / resources/app.asar
npm run check                         # 五套门
```

装进 profile 有两种方式：

- **tarball（推荐，也是本插件最可靠的方式）**：`npm pack` → 更新 profile 的
  `vendor/dsh-win-pwsh7-<version>.tgz` → `dsh plugin ... add file:...`。换包会回收当前会话上下文，
  重启后不要在同一个回合继续跑工具。
- **link（仅限能解析宿主包的环境）**：`dsh plugin --profile <profile> add <path-to-repo>/current`。
  本插件的 Host 半在真实路径下 import `@deepseek-ai/cordis`、`@deepseek-ai/dsh-tools`、
  `@deepseek-ai/dsh-pwsh-local`、`@deepseek-ai/schemastery`；如果工作区或父目录没有这些包，
  link 安装会让插件 **静默 inactive**（`ERR_MODULE_NOT_FOUND`）。开发机默认只用 tarball。

## 常用命令

```powershell
npm run check            # host + client + utf8 + native + docs
npm run check:docs       # 只跑文档链接与锚点
npm run check:contracts  # 只跑 native contracts
npm pack --dry-run       # 看发布包内容
```

`check-host` / `check-native-contracts` 需要本机安装 DSH；CI 上没有实例，所以只跑 client 与 docs。

## 目录约定

| 目录 | 用途 |
| --- | --- |
| `index.js` | Host 半：Config、apply、工具、gate、报告、安装作业、Remote |
| `client.js` | Web 半：配置卡、状态卡、求星行（UMD，无构建） |
| `lib/` | dsh-ops 桥、UTF-8 桥、typert 契约 |
| `locale/*.json` | 包标题/描述（8 种官方语言各一份） |
| `docs/` | 公开文档，入口 [docs/README.md](docs/README.md) |
| `docs-private/` | 私有文档；只有 README 入库 |
| `tools/` | 校验门（host / client / utf8 / native / docs） |
| `MAINTAINING.md` | 维护者手册（发版、审批、升级） |

## 代码风格

- **没有构建**：不引入运行时依赖，不写只在打包器里成立的语法；
- **注释解释「为什么」**：阈值、TTL、缓存刷新、拒绝文案这类决定要写依据与证据；
- **八本字典同一套键**：新增文案同时补 `DICT_ZH` / `DICT_EN` / `DICT_JA` / `DICT_DE` / `DICT_ES` / `DICT_FR` / `DICT_PT` / `DICT_RU`；任意一本都不得空值，`en` 不得含 CJK，`locale/*.json` 每种语言一份 meta（client 门会拦）；
- **界面文案只走 `t()`**：不要写裸字面量，也不要在标签里放 `{占位符}`；
- **只用主题 token**：颜色/圆角/字体走 `--dsw-*`，类名 `dw7-` 前缀；
- **不破坏不变量**：不写执行器 `pwshPath`、只写带标记的 profile 块、只 pin 家族别名或普通
  `pwsh.exe`（见 [设计说明](docs/design.md)）。

## 提交与 PR

- 第一行写“做了什么”，正文写“为什么”；一个 PR 只做一件事；
- 行为改动补测试；UI 改动附截图；文档改动跑 `npm run check:docs`；
- 变更用户可见行为时更新 `CHANGELOG.md` 与 README；
- 不要在公开 Issue/PR 里贴本机用户名、完整路径或凭据；用 `<home>` / `<profile>` 代替。

## 报告问题

请在 issue 中附：

1. 插件版本与 DSH 版本（桌面壳 + Harness 内核）；
2. `pwsh7_status` 的完整报告；
3. Host 日志里 `dsh-win-pwsh7:` 开头的行；
4. 安装方式（npm / GitHub tag / 本地目录）与 profile 名。

安全问题的报告方式见 [SECURITY.md](SECURITY.md)。
