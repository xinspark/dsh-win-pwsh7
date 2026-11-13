# 配置

两个键都存在同一行配置里，写入方式是 **volatile row config**：插件页保存即生效；也可以写进
profile 补丁，作为该行的初始值。**只有 `overridePath` 有插件页控件**；
`utf8Console` 目前只通过 profile 补丁配置（它是过渡层，见 [经验 04](../experience/04-嵌套pwsh乱码.md)）。

| 键 | 类型 / 默认 | 作用 |
| --- | --- | --- |
| `overridePath` | string，未设 | 优先级 ① 的显式 `pwsh.exe`。必须能启动并报告 PowerShell 7+；未通过校验就回落到自动探测。**只影响探测与推荐，不给执行器接线。** |
| `utf8Console` | boolean，默认 `true` | 过渡层：Windows 下给 `pwsh` 的每条命令前加 `chcp.com 65001`，避免嵌套 `pwsh -File` 按 936 输出 GBK 后被按 UTF-8 解码成乱码。 |

## 插件页

插件页的配置区只有一项：

- **PowerShell 7 路径**（`overridePath`）：空 = 自动探测；右侧的「选择...」按钮在 Desktop 上打开系统文件对话框，选中的 `pwsh.exe` 由宿主路径桥回填为绝对路径。普通浏览器没有这个桥时，按钮会提示直接填写路径。

共存不在这里配置：从 0.2.8 起，与 dsh-ops 的共存由 **dsh-ops 0.5.0+** 的「dsh-win-pwsh7
联动」管理，开关位于 dsh-ops 插件页的「其他」区。保存后不需要重启；状态区右上角的「重新检测」
会刷新同一份 Host 状态。页面最底部（状态卡下方）有一行求星提示（`⭐` 字符，文案跟随界面语言），
它不新增仓库链接——插件页页脚已经有入口。

## profile 补丁

```yaml
- id: win-pwsh7
  config:
    overridePath: 'D:\tools\pwsh\pwsh.exe'
    utf8Console: true
```

注意：

- `config` 是**整块替换**该行的配置，不是深合并；要保留的键都要写上；
- profile 补丁里的值在**重启 DSH** 后成为该行的初始值，之后插件页的 volatile 写入才是实时值；
- 这里只配置本插件的行为。给 `pwsh` 工具接线是另一个行（`pwsh-sandbox` 的 `pwshPath`），
  用 `pwsh7_status` 打印的补丁，别混在一起。

## 不要做的事

- 不要把版本号目录的 Store 路径写进 `overridePath`：它能跑，但每次 Store 更新都会移动；
  家族别名或普通 `pwsh.exe` 才是稳定目标。
- 不要手动编辑 `cordis.patch.yml` 里带 `# dsh-win-pwsh7:` 标记的块：0.2.8 起本插件不再写
  `dsh-ops-compat`；旧版本残留的 managed 块请手动删除，共存开关在 dsh-ops 页面。
- 不要期待 `overridePath` 会给 `pwsh` 工具接线：它只改变插件探测到什么、推荐什么。
