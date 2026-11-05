# 04 · 嵌套 pwsh 中文变 `�`：收集器按 UTF-8，控制台却是 936

- 类别: 编码
- 日期: 2026-11-03
- 状态: 过渡层存在（0.2.5）；等上游修复后删除

## 症状

在 DSH 的 `pwsh` 命令里再启动 `pwsh -File` / `powershell -File`，脚本输出的中文在界面上
变成 `�`（U+FFFD）；纯 ASCII 正常。简体中文 Windows 上稳定复现。

## 根因

DSH 的 subprocess 收集器按 **UTF-8** 解码 stdout，但嵌套进程继承的是**控制台代码页**
（中文机器通常是 936 / GBK）。宿主的 `ENCODING_PREAMBLE` 只设置了外层 .NET 进程的
`[Console]::OutputEncoding` 与 `$OutputEncoding`，**没有改控制台代码页**，所以嵌套进程仍按
936 写出 GBK 字节，再被按 UTF-8 解码。

## 证据

- 上游报告：[deepseek-harness discussion #12005](https://github.com/deepseek-ai/deepseek-harness/discussions/12005)；
- 安装的 `@deepseek-ai/dsh-pwsh-local`（0.2.2-rc.1）`ENCODING_PREAMBLE` 只有
  `[Console]::OutputEncoding` / `$OutputEncoding`，没有 `chcp.com 65001` 或
  `SetConsoleOutputCP`；上游 master 的同一常量仍然如此（2026-11-05 复核）；
- `tools/check-native-contracts.mjs` 断言这个 preamble 不含 `chcp` / `SetConsoleOutputCP`；
  上游一旦自带，断言会**故意变红**，提示按删除契约移除过渡层；
- 0.2.5 的 `lib/utf8-console-bridge.js` 在每条 Windows 命令前加
  `chcp.com 65001 > $null;`，`tools/check-utf8-bridge.mjs` 覆盖前缀、关闭、幂等、恢复与
  fail-open。

## 结论

1. 这是宿主收集器与子进程控制台代码页的口径不一致，不是用户脚本的问题；
2. 过渡层只改控制台代码页，不动输出内容；默认开、可关、可整体删除；
3. **删除条件**：上游 `ENCODING_PREAMBLE` 自带 `chcp.com 65001`，或在 CP936 下关掉本桥后
   嵌套脚本已输出 UTF-8。删除清单见 README 的「删除契约」。
