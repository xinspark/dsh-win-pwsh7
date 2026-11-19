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
- **发布前四套门全绿**，且 `dsh.verifiedAgainst` 只写实际跑过 native 门的版本。

## 3. 验证门

```powershell
$env:DSH_APP_DIR = '<install root>'      # 安装根 / resources/app / resources/app.asar
node tools/check-host.mjs
node tools/check-client.mjs
node tools/check-native-contracts.mjs
node tools/check-docs.mjs
node tools/reconcile-build.mjs --from <上一个验证过的内核版本>   # 不在门链里：需要联网
```

- CI（`.github/workflows/ci.yml`）只跑 client + docs：其余两套需要真实 Windows DSH 安装；
- `prepublishOnly` 跑 `npm run check`（四套）；
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
2. **先做包级对账**：`node tools/reconcile-build.mjs --from <上一个验证过的内核版本>` ——
   它比两个**发布构建**的 tarball（同渠道才可比），退出码 0 = 零迁移、1 = 有代码变化。
   同版本自检必须全绿，否则它量的是渠道差异（见 [经验 08](docs/experience/08-渠道不可比.md)）；
3. 跑四套门；
4. 逐项核对：`PwshLocalExecutor.pwshPath` getter、`tools.guard` / `tools/pre-execute`、
   `configEditor.entries()`、`systemPrompt.getSectionOrder('TOOL_PWSH')`、两个客户端槽位；
5. 编码由宿主负责（0.3.0 起本插件不再介入）：若怀疑编码契约变了，用「控制台停在 936、无任何前缀、
   看嵌套输出」的对照实验重判，别凭印象改代码；
6. 全绿后更新 `dsh.verifiedAgainst`、`docs/reference/native-contracts.md` 基线表、`CHANGELOG.md`；
7. `engines.dsh` 的上界按次版本（`<X.<minor+1>.0-0`），不要绑到下一个补丁的预发布。

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

- **0.3.0 已发布（2026-11-19）**：npm `dist-tags.latest = 0.3.0`，`gitHead = f9a4384`，25 个文件，
  `shasum = e7db8b2b1ab0ac7526acb7b1c518f454b4c4fec5`，`integrity = sha512-zTv1t6YEt…`，带 SLSA
  provenance（Trusted Publishing）；Actions `ci` run `44441084461`、`publish` run `44441090815` 均 success；
  Release <https://github.com/XinSpark/dsh-win-pwsh7/releases/tag/v0.3.0>；issue #1 已关闭并留下复核记录。
  ⚠️ npm 发布后有一段**异步处理期**：工作流最后一行是 "Your package is being processed and may take a
  few minutes"，约 20 秒后 registry 才可见；期间的 404 / 旧 `dist-tags` **不是失败信号**。
- 0.3.0 的两个变化合并在一版——
  ① 基线抬到 DSH `0.2.2-rc.5`（桌面壳 2.0.24-next），包级对账**零迁移**（12 个包在 rc.3 / rc.5
  的发布构建之间逐文件字节相同），新增 `tools/reconcile-build.mjs`（不进 `npm run check`）；
  ② **删除 UTF-8 过渡层**（`lib/utf8-console-bridge.js`、`Config.utf8Console`、
  `tools/check-utf8-bridge.mjs`、`tools/utf8-removal.mjs` 与 check 链），依据是关掉它之后在
  真实实例上的实测：`chcp` 回到 936，`powershell -Command` / ASCII 脚本 `-File` / 带 BOM 脚本
  `-File` / 嵌套 `pwsh -File` 四组中文全正常。四套门全绿（native 40 项、文档 24 篇）；
- 本机 profile 已装 `file:…/main/dsh-win-pwsh7-0.3.0.tgz` 并重启实测（宿主进程 09:45:38 晚于安装）：
  `chcp` 936、四组编码正常、`pwsh7_status` 正常、插件页配置卡只剩「PowerShell 7 路径」一项、
  旁路工具 `ops_bash` 中文正常；回滚材料：`node_modules/dsh-win-pwsh7.bak-0.2.11`、
  `package.json.bak-20261119-0945`、`pnpm-lock.yaml.bak-20261119-0945`；
- 0.2.11（回看）：npm `0.2.11`（2026-11-15），`gitHead = 3664bfd`，27 个文件，
  `shasum = 20f0692adc60d5eedee933598a760005e85eaba5`，带 SLSA provenance（Trusted Publishing）；
- GitHub：tag `v0.2.11` → `3664bfd`；Release <https://github.com/XinSpark/dsh-win-pwsh7/releases/tag/v0.2.11>；
  Actions：`ci` run `43647156761` success、`publish` run `43647161190` success（24s）；
- 0.2.11 内容：探针按读取周期去重（一次状态调用 3 → 1 次探针）、native 门 38 → 41 项
  （客户端槽位 `kind` + 渲染点 + 行 key 形状）、新增 `tools/utf8-removal.mjs` 判定工具；
  五套门全绿（host 2 tools / 1 prompt section、client 3 contributions / 8 dictionaries、
  UTF-8 bridge paths、native **41** checks、23 documents）；
- 本机 profile 已换成 `file:…/main/dsh-win-pwsh7-0.2.11.tgz`（hoisted 布局手工替换，保留
  `node_modules/dsh-win-pwsh7.bak-0.2.10` 与 `package.json.bak-20261115-0618`）；
  安装副本与 npm tarball **逐文件一致**；**重启 DSH 后生效**；
- 0.2.10 基线（回看）：DSH `0.2.2-rc.3`（桌面壳 2.0.23-next），native 当时 38 项；`dsh-pwsh-local`
  hash 未变，UTF-8 控制台桥仍需要；实例已安装 0.2.10，工具面保持 88 项（`pwsh` + `ops_bash`，
  无重复官方文件/shell 工具）；
- 本机 profile 使用 `file:E:/FXS/Data/DSH-Dev/plugins/dsh-win-pwsh7/main/dsh-win-pwsh7-0.2.10.tgz`
  的真实目录安装（不是 link），安装目录与 npm tarball 逐文件一致；
- 过渡层的上游跟踪 issue：UTF-8 控制台桥（#1）；dsh-ops 兼容桥（#2）已在 0.2.8 删除并关闭，
  触发条件是 dsh-ops 0.5.0 的「dsh-win-pwsh7 联动」。
