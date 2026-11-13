# 维护规范（MAINTAINING）

> 维护者作业手册。规则由仓库所有者制定，维护者按此执行；公开文档只写已发生的事实。

## 1. 角色与范围

维护者负责 `dsh-win-pwsh7`（包名与仓库名相同）的四件事：

1. **GitHub 运维**：`xinspark/dsh-win-pwsh7` 的 Issues / PR 分诊、复现、回复草稿，按批准执行回复/关闭/合并；
2. **跟随 DSH 版本**：实例升级后判断插件是否需要适配，按 [版本兼容](docs/reference/compatibility.md) 复核；
3. **发版与 npm**：版本号、CHANGELOG、tag、GitHub Release、Trusted Publishing；
4. **文档分层**：公开文档（`docs/`）只记已发生的事实；计划、决策过程、本机信息放 `docs-private/`。

## 2. 硬规则

- **所有对外部有影响的动作先获得所有者逐项批准**，批准前只准备草稿。包括：
  - `git push`、打 tag、创建 GitHub Release、改仓库设置；
  - 创建/回复/关闭 Issue，创建/合并/评论 PR；
  - `npm publish`（走 CI 也要先批准推 tag）、插件市场条目变更；
  - 任何第三方仓库上的写操作。
- **不需要批准的本地动作**：读代码/远端资料、跑门、改代码、本地 commit、本地 tag、写草稿/报告。
- **不写密钥**：token、密码、账号 2FA 细节只留在系统凭据或 `docs-private/env/accounts.md`（该文件不入库）。
- **公开文档不写本机路径 / 用户名 / 凭据**；需要举例时用 `<home>`、`<profile>` 占位。
- **发布前五套门全绿**，且 `dsh.verifiedAgainst` 只写实际跑过 native 门的版本。

## 3. 验证门

```powershell
$env:DSH_APP_DIR = '<install root>'      # 安装根 / resources/app / resources/app.asar
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-utf8-bridge.mjs
node tools/check-native-contracts.mjs
node tools/check-docs.mjs
```

- CI（`.github/workflows/ci.yml`）只跑 client + docs：其余三套需要真实 Windows DSH 安装；
- `prepublishOnly` 跑 `npm run check`（五套）；
- native 门变红时，先按 `docs/reference/native-contracts.md` 判断上游契约是否真的变了，**不要只改断言让它变绿**。

## 4. 发版流程

1. 改代码/文档：`CHANGELOG.md` 新开一节、README 的功能/安装说明同步；
2. `package.json` 版本号 + 本地 commit + 本地 annotated tag（如 `v0.2.8`）；
3. **请求批准**后推 `main` 与 tag；
4. tag 触发 `.github/workflows/publish.yml`：校验 tag 与版本一致 → 跑 client / docs 门 →
   `npm pack --dry-run` → `npm publish --provenance --tag latest`（Trusted Publishing，无需 npm token）；
5. 复核 `registry.npmjs.org` 的 `dist-tags.latest` 与 provenance（镜像有延迟，不用镜像 404 判失败）；
6. 建 GitHub Release（正文取 CHANGELOG 对应节）；市场条目只在功能描述/仓库地址变化时更新；
7. 本机 profile 若要吃到新版本：重新 `npm pack` → 更新 profile 的 vendor tarball 或切到 `link:` → 重启 DSH。**换包会回收当前会话上下文，不在同一回合继续跑工具。**
   **不要默认切 `link:`**：本插件 Host 半会从真实路径解析 `@deepseek-ai/cordis` / `dsh-tools` / `dsh-pwsh-local` / `schemastery`；父目录只有 `schemastery` 时 link 会让插件静默 inactive。用 tarball 安装。

### 已知历史

- npm 上曾有 0.12.x 线，npm 认为它高于 0.2.x，因此发布命令显式带 `--tag latest`；
- 0.2.6 修复了 0.2.5 在 DSH 0.2.2-rc.1 上被 loader 静默跳过的问题（见
  [经验 01](docs/experience/01-engines静默跳过.md)）。

## 5. DSH 升级对账

1. 记录新实例版本（桌面壳 + Harness 内核）；
2. 跑五套门；
3. 逐项核对：`PwshLocalExecutor.pwshPath` getter、`tools.guard` / `tools/pre-execute`、
   `configEditor.entries()`、`systemPrompt.getSectionOrder('TOOL_PWSH')`、两个客户端槽位；
4. 检查 `@deepseek-ai/dsh-pwsh-local` 的 `ENCODING_PREAMBLE` 是否已自带 `chcp.com 65001`；
5. 全绿后更新 `dsh.verifiedAgainst`、`docs/reference/native-contracts.md` 基线表、`CHANGELOG.md`；
6. `engines.dsh` 的上界按次版本（`<X.<minor+1>.0-0`），不要绑到下一个补丁的预发布。

## 6. 文档分层

| 层 | 位置 | 入库 | 规则 |
| --- | --- | --- | --- |
| 公开 | `README.md` / `README.en.md` / `docs/` | ✅ | 只写已发生的事实；相对链接必须过 `check-docs` |
| 维护者 | 本文件 | ✅ | 作业流程、发版规则、升级清单 |
| 私有 | `docs-private/` | 仅 `README.md` | 路线图、待办、ADR、调研、本机环境、发版清单；其余被 `.gitignore` 排除 |

结论稳定后按 [私有文档说明](docs-private/README.md) 的升级路径提升为公开文档；公开文档不得链接
未入库的私有文件。

**多语言**：插件自有文案覆盖 8 种官方语言（zh / en / ja / de / es / fr / pt / ru），八本字典
键集必须一致，新增文案要同时补齐；`locale/*.json` 是宿主**启动时**读取的包元数据，改完要重启
DSH 验证，`client.js` 里的界面字典刷新页面即可。

## 7. 当前状态（事实）

- 最新发布：npm `0.2.9`（2026-11-14），`dist-tags.latest = 0.2.9`，`gitHead = 078357d`，26 个文件，
  带 SLSA provenance；
- GitHub：tag `v0.2.9` → `078357d`；Release <https://github.com/XinSpark/dsh-win-pwsh7/releases/tag/v0.2.9>；
  Actions run `43468029849` success（tag 校验、client/docs 门、`npm pack --dry-run`、`npm publish --provenance`）；
- 工作区版本 `0.2.9`（已发布）：配置卡 `overridePath` 右侧新增「选择...」按钮，Desktop 经
  `__DSH_HOST_PATHS__.pathFor(file)` 回填绝对路径；五套门全绿（native 38 项、文档 22 篇）；
  实例已安装 0.2.9，工具面保持 88 项（`pwsh` + `ops_bash`，无重复官方文件/shell 工具）；
- 本机 profile 使用 `file:E:/FXS/Data/DSH-Dev/plugins/dsh-win-pwsh7/main/dsh-win-pwsh7-0.2.9.tgz`
  的真实目录安装（不是 link），安装目录与 npm tarball 逐文件一致；
- 过渡层的上游跟踪 issue：UTF-8 控制台桥（#1）；dsh-ops 兼容桥（#2）已在 0.2.8 删除并关闭，
  触发条件是 dsh-ops 0.5.0 的「dsh-win-pwsh7 联动」。
