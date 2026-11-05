# 03 · Store UI 脚本被 5.1 按 ANSI 解码 → 打开页面前就解析失败

- 类别: 编码
- 日期: 2026-10-29
- 状态: 已修复（0.15.1）

## 症状

0.15.0 的脚本安装在打开 Microsoft Store 之前就失败，报的是 PowerShell **解析错误**，而不是
VPN / 页面加载问题。中文说明文案里的字符被当成非法 token。

## 根因

Store UI 脚本最初作为内联文本传给 Windows PowerShell 5.1。5.1 在中文机器上按系统 ANSI
代码页（936）解码命令行文本，脚本里的中文说明与「安装」等字符串被拆成乱码 token，脚本
还没执行到 `Start-Process` 就解析失败。改成 `-EncodedCommand` 也不可靠：同样的 ANSI
解码问题会落在 base64 解码后的文本上。

## 证据

- `CHANGELOG.md` 0.15.1 节：改为把脚本写成 **UTF-8 BOM** 的临时 `.ps1`，再
  `powershell.exe -File` 启动；5.1 对带 BOM 的文件按 UTF-8 读取，与控制台代码页无关；
- 同一改动把弯引号换成 `「」`：PowerShell 7 会把弯引号当字符串分隔符；
- `index.js` 的 `spawnStoreUi()` 明确写入 `\uFEFF` 前缀，并在作业结束后删除临时目录；
- host 门的 Store 作业用桩 stdout 驱动点击/失败路径，临时脚本自身的编码不再依赖机器代码页。

## 结论

1. 交给旧 PowerShell 的非 ASCII 脚本，用**带 BOM 的文件**，不要用内联文本或
   `-EncodedCommand`；
2. 脚本内容要同时在 5.1 与 7 下可解析（避免弯引号等“看起来只是文案”的字符）；
3. 临时文件要有明确的清理点（作业 settle / 取消 / spawn 失败）。
