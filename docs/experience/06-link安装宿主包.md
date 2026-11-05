# 06 · link 安装后插件静默 inactive：宿主包从真实路径解析不到

- 类别: 安装 / 模块解析
- 日期: 2026-11-05
- 状态: 已定位；开发机回退到 tarball 安装

## 症状

把 profile 里的 `dsh-win-pwsh7` 从 `file:vendor/...tgz` 改成
`link:E:/FXS/Data/DSH-Dev/plugins/dsh-win-pwsh7/main` 后重启 DSH，插件整体消失：
`pwsh7_status` 报 `unknown tool "pwsh7_status"`，插件页无行，Host 诊断只有一行
`win-pwsh7 (dsh-win-pwsh7): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package
'@deepseek-ai/cordis' imported from E:\FXS\Data\DSH-Dev\plugins\dsh-win-pwsh7\main\index.js`。

## 根因

link 安装让 Host 直接 import **真实路径**下的 `main/index.js`。Node 的 ESM 解析从真实路径向上
找 `node_modules`，而本机开发树的父目录 `plugins/node_modules/@deepseek-ai` 只有
`cosmokit` / `schemastery`，没有 `cordis` / `dsh-tools` / `dsh-pwsh-local`。这三个包是 DSH
宿主内部包，tarball 安装进 profile 后由宿主的解析链提供，link 路径拿不到。

参考插件「更好的会话顶栏」能 link，是因为它的 Host 半只需要 `@deepseek-ai/schemastery`
（父目录正好有），且没有 `cordis` / `dsh-tools` / `dsh-pwsh-local` 这类直接 import。
本插件四个裸导入都依赖宿主包，所以不能照搬它的 link 开发方式。

## 证据

- 从工作区真实路径分别 import：
  - `@deepseek-ai/schemastery` → ok（父目录提供）；
  - `@deepseek-ai/dsh-tools` / `@deepseek-ai/cordis` / `@deepseek-ai/dsh-pwsh-local` → `ERR_MODULE_NOT_FOUND`；
- Host 诊断里的导入路径就是工作区 `main/index.js`，不是 profile 的
  `node_modules/dsh-win-pwsh7`；
- 回退为 `file:...tgz` 安装后，profile 的 `node_modules/dsh-win-pwsh7` 是真实目录，诊断不再
  指向工作区；运行中的 loader 仍缓存旧 link 路径，需要重启一次重新解析。

## 结论

1. **本插件用 tarball 安装**，不要用 `link:`；除非能保证工作区或其父目录可解析
   `@deepseek-ai/cordis` / `dsh-tools` / `dsh-pwsh-local` / `schemastery`；
2. 排障先看 Host 诊断的 **imported from** 路径：指向工作区就是 link 解析问题，指向 profile
   才是包内容问题；
3. link 失败不会破坏宿主，插件只是 inactive；回退 tarball + 重启即可恢复。
