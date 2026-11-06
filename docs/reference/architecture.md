# 装配契约

> 这个插件贴在 DSH 的内部契约上（没有稳定的第三方 API）。逐项上游证据与版本基线见
> [原生契约](native-contracts.md)；为什么这么设计见 [设计说明](../design.md)。

## 包结构与两半

```
package.json          name / exports / dsh.bundle.patch / dsh.client
cordis.patch.yml      Host 行（单个 insert）
index.js              Host 半：Config、apply、工具、gate、报告、安装作业、Remote 服务
client.js             Web 半：配置卡 + 状态卡（UMD，无构建）
lib/utf8-console-bridge.js 过渡层：包装 ctx.shell.execute
lib/typert.host.js    构建期 typert 契约（status 端点）
locale/*.json         包标题/描述（8 种官方语言各一份）
docs/                 公开文档
docs-private/         私有文档（仅入口 README 入库）
tools/check-*.mjs     校验门
```

两对名字必须分别一致：

- **包名** `dsh-win-pwsh7` = 客户端 `__ModuleLoader__.load({ id })` 的 id = Remote namespace =
  locale 命名空间；
- **行 id** `win-pwsh7` = `configForms` 的命名空间 = 客户端槽位键 `dsh-win-pwsh7#win-pwsh7`
  的后半段。包名和行 id **不同**是正常的，不要为了“同名”去改行 id。

包名是 Remote 与 locale 的命名空间；设置表单的命名空间是行 id。

## Host 半

`apply(ctx, config)` 在非 Windows 直接返回；在 Windows 上按顺序挂：

| 挂载 | 作用 |
| --- | --- |
| `mountUtf8ConsoleBridge`（effect） | 包装 `ctx.shell.execute`，前缀 `chcp.com 65001`；可开关、可整体删除 |
| `activationSweep` | 只检测并写日志，**不安装** |
| `systemPrompt.section` | 注册 `tool:pwsh-runtime`，顺序取 `TOOL_PWSH`，文本由最近一次判定更新 |
| 两个工具 | `pwsh7_status` / `pwsh7_install`，输出契约固定为 `{ report }` |
| `tools.guard` | 同步 gate：`pwsh` 只在判定 allow 时放行 |
| `tools/pre-execute` | 异步刷新 gate（60s TTL），跑在 guard 之前 |
| config reload / plugin change | 重新探测执行器，刷新 gate |
| `Pwsh7Dispatch` | Remote 服务，暴露 `status()` 给插件页 |

### 使用的服务与事件

| 契约 | 用法 |
| --- | --- |
| `ctx.subprocess.spawn` | 版本探针与 Store UI 脚本；探针用 `-EncodedCommand` 避免引号问题 |
| `ctx.shell.pwshPath` | 执行器实际会 spawn 的路径（feature-detect；缺字段时退回 config + resolver） |
| `ctx.shell.declaredPwshPath` / `resolvedPwshPath` | 仅用于安装后的缓存刷新（写 sentinel 让 getter 重解析；字段不存在则退回 pin + reload） |
| `ctx.configEditor.entries()` | 读执行器行与 live 配置；只暴露 `include` 拥有的行 |
| `ctx.systemPrompt.getSectionOrder('TOOL_PWSH')` | 把提示段放在官方 `tool:pwsh` 旁 |
| `ctx.tools.register` / `guard` | 注册工具、安装同步 gate |
| `ctx.get('jobs').start` | 后台安装作业；作业句柄提供 `append` / `updateProgress` |
| `ctx.on('tools/pre-execute')` | gate 的异步保鲜；必须调用 `next()`，拒绝归 guard 所有 |
| `ctx.on('app-boot/config-reload')` / `plugin-manager/changed` | profile 变化后重算 gate |

### 工具与输出契约

两个工具都走 `defineTool`，`output.render` 不是可选的：没有它定义能注册，但每次调用都会
`output.render failed: userRender is not a function`。`reportOutput()` 把整个报告渲染成一个
text block，所以模型看到的就是报告本身。

`pwsh7_status` 只读：检测 + 校验 + 打印补丁。`pwsh7_install` 写：VPN 确认 → 熔断检查 →
启动作业（没有 jobs 服务时内联执行）。

## Web 半

`client.js` 在 `window.__ModuleLoader__.load` 中返回三个贡献：

| 槽位 | 键 / id | 内容 |
| --- | --- | --- |
| `plugins.row.config` | `dsh-win-pwsh7#win-pwsh7` | 配置卡：`overridePath` 输入、Save/Reset |
| `plugins.detail.section` | `dsh-win-pwsh7.diagnostics`，order 50 | 状态卡：状态 / 运行时 / 执行器三条事实、Re-detect、可复制补丁 |
| `plugins.detail.section` | `dsh-win-pwsh7.star`，order 80 | 页面底部求星行；`subject.pkg.name` 不是本包时返回 null |

- 配置读写走 `configForms.get('win-pwsh7')`；`useSyncExternalStore` 的 subscribe/getSnapshot
  必须保持稳定身份，否则 React 会因 `getSnapshot` 每次返回新对象而无限重渲染；
- 求星行是**独立 section**（order 80）：排在市场来源行 `dsh-market-source`（order 90，渲染
  页脚「查看仓库」）之前，因此视觉上是“状态卡 → 求星行 → 查看仓库”；它不新增仓库链接，
  星形是 locale 文案里的 `⭐` 字符；
- 求星行用 `slots.inject('plugins.detail.section', …)` 注册，旧内核没有该槽时回调不触发，
  页面只少一行；`locale: PACKAGE` 让槽位注入 `t`，组件在 `props.t` 缺席时回退到闭包绑定。
  注册本身有独立的 try/catch：宿主拒绝这个额外 section 时，配置卡与状态卡照常注册；
- 状态卡通过 `remote.$mount({ package, descriptors })` 挂载命名空间，调用 `status`，再解开
  `{ ok, value }` 信封；descriptor 用 `src-json` 结果模式，Host 侧 typert 契约用 strict 编解码；
- 所有视觉只用 `--dsw-alias-*` / `--dsw-radius-*` 主题 token，类名 `dw7-` 前缀；卸载即移除；
- 文案只走 `t()`；八本字典（zh / en / ja / de / es / fr / pt / ru）键集必须一致，`en` 不得含 CJK；
  包标题/描述在 `locale/*.json`，每种语言一份，宿主启动时读取（改完要重启 DSH）；客户端门会拦键集与 meta。

## 过渡层的独立删除契约

dsh-ops 共存桥已在 0.2.8（IS#2）整体删除：dsh-ops 0.5.0 的 `pwsh7Link` 原生负责保持 `pwsh`
可见，本插件不再写 profile、也不再隐藏工具。下面的表只剩 UTF-8 过渡层。

| 模块 | 删除方式 | 验收 |
| --- | --- | --- |
| UTF-8 控制台 | 删 `lib/utf8-console-bridge.js`、import/mount、`Config.utf8Console`、`tools/check-utf8-bridge.mjs` 及 check 链、README 的过渡说明 | `grep -rn "utf8-console-bridge\|utf8Console" index.js lib tools` 无结果 |

删除前先确认上游条件（见 [设计说明](../design.md) 与 [项目经验](../experience/README.md)）。

## 失败行为

- 注册失败：`apply` 捕获并 warn，已注册的工具回滚，不抛到宿主；
- UTF-8 桥形状不符：fail-open，原 executor 不动；
- gate 刷新异常：保留上一份判定（fail closed），warn 日志带 `dsh-win-pwsh7:` 前缀；
- Remote 不可用：客户端卡片显示本地化错误，不编造事实。
