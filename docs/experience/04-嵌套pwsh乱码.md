# 04 · 嵌套 pwsh 中文变 `�`：收集器按 UTF-8，控制台却是 936

- 类别: 编码
- 日期: 2026-11-03（0.2.5 加过渡层）／2026-11-19 复核（0.3.0 删除过渡层）
- 状态: **已删除**（0.3.0）；本文记录"当时的判断"与"后来推翻它的证据"

## 症状

在 DSH 的 `pwsh` 命令里再启动 `pwsh -File` / `powershell -File`，脚本输出的中文在界面上
变成 `�`（U+FFFD）；纯 ASCII 正常。简体中文 Windows 上稳定复现。

## 根因（2026-11-03 的判断）

DSH 的 subprocess 收集器按 **UTF-8** 解码 stdout，但嵌套进程继承的是**控制台代码页**
（中文机器通常是 936 / GBK）。宿主的 `ENCODING_PREAMBLE` 只设置了外层 .NET 进程的
`[Console]::OutputEncoding` 与 `$OutputEncoding`，**没有改控制台代码页**，所以嵌套进程仍按
936 写出 GBK 字节，再被按 UTF-8 解码。

## 证据（当时的）

- 上游报告：[deepseek-harness discussion #12005](https://github.com/deepseek-ai/deepseek-harness/discussions/12005)；
- 安装的 `@deepseek-ai/dsh-pwsh-local`（0.2.2-rc.1）`ENCODING_PREAMBLE` 只有
  `[Console]::OutputEncoding` / `$OutputEncoding`，没有 `chcp.com 65001` 或
  `SetConsoleOutputCP`；
- 0.2.5 的 `lib/utf8-console-bridge.js` 在每条 Windows 命令前加 `chcp.com 65001 > $null;`。

## 后来推翻它的一半（2026-11-19）

上面那段的**前半对、后半不完整**：嵌套进程确实按 936 写出 GBK 字节，但**外层 pwsh 会把它按
`[Console]::OutputEncoding` 解码后重新编码为 UTF-8 再写到自己的 stdout**，收集器拿到的已经不是
坏字节。也就是说，宿主 preamble 里那句 `[Console]::OutputEncoding = UTF8` 本身就是解药。

对照实验（`chcp.com 936` → 按宿主顺序注入 preamble → 嵌套 `powershell` 打印中文 → 原始 stdout
按 UTF-8 解码）：

| 组 | 原始字节 | 结果 |
| --- | --- | --- |
| 无 preamble | `c7b6ccd7d0cec4b2e2cad4`（GBK） | 乱码（复现缺陷，说明实验有效） |
| 有 preamble | `e5b58ce5a597e4b8ade69687e6b58be8af95`（UTF-8） | `嵌套中文测试` |

真机复核（DSH 0.2.2-rc.5，pwsh 7.6.9，系统 ACP/OEMCP 均为 936）：把 `utf8Console` 置 false
并**重启**宿主后，`chcp` 回到 936，四组全对——`powershell -Command`、ASCII 脚本
（`[char]` 拼中文）`-File`、带 BOM 的 UTF-8 脚本 `-File`、以及经嵌套 `pwsh -File`。

⚠️ 同期踩到的**相邻问题**（别混为一谈）：`Set-Content -Encoding UTF8` 在 pwsh 7 下写的是
**无 BOM** 的 UTF-8，5.1 读它时按 936 解码，中文变成 `宓屽涓枃娴嬭瘯` 这类 mojibake。那是
**脚本文件编码**问题，不是输出解码问题——加 BOM 或改用 pwsh 7 即可。

## 结论

1. 缺陷分层要看清楚：**输出解码**（本 issue）与**脚本文件编码**（相邻问题）症状相似，修法完全不同；
2. "上游常量里没有 `chcp`"只证明**那一种修法**没有上路，证明不了"问题还在"——判据必须是
   **能复现缺陷的对照实验**，否则会把"换了一条路修好"读成"没修"；
3. 0.3.0 删除过渡层：`lib/utf8-console-bridge.js`、`Config.utf8Console`、
   `tools/check-utf8-bridge.mjs`、`tools/utf8-removal.mjs` 与 check 链一并移除；
4. 这个判据当时被做成 `node tools/utf8-removal.mjs --cp936`（先跑对照组再判），随过渡层一起删掉；
   下一次若要再判同类问题，照第 2 条重做一次对照实验，别凭印象。
