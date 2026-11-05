# 01 · engines 上界写在“下一个补丁的预发布” → 插件静默消失

- 类别: 兼容
- 日期: 2026-11-04
- 状态: 已修复（0.2.6）

## 症状

DSH 从 0.2.1-rc.4 升到 **0.2.2-rc.1** 后，dsh-win-pwsh7 **整体消失**：`pwsh7_status` /
`pwsh7_install` 两个工具没有注册，`pwsh` 的 gate 不在，插件页不渲染，UTF-8 桥也没挂上。
屏幕上没有报错；唯一可见的痕迹是每次重组合都打印 `patch: entry "win-pwsh7" not found`。

## 根因

0.2.5 的 `package.json` 写的是 `"engines": { "dsh": ">=0.2.1-rc.3 <0.2.2-0" }`。loader 对
**不满足 engines 的 bundle 直接跳过**，不安装、不报错，只把包名记进 `skippedBundles`。
DSH 经常以下一个补丁的预发布发修复（0.2.2-rc.1），所以“上界 = 下一个补丁的预发布”等价于
“DSH 下一次更新就跳过本插件”；bundle 没装上，`cordis.patch.yml` 里插入 `win-pwsh7` 的补丁
自然找不到对应行。

## 证据

- `CHANGELOG.md` 0.2.6 节记录：0.2.5 在 0.2.2-rc.1 上工具、guard、页面、UTF-8 桥全部缺失；
- `tools/check-host.mjs` 的 `engines.dsh ends at the next minor, not at the next prerelease`
  现在按 `verifiedAgainst` 推导上界必须是 `<X.<minor+1>.0-0`；
- 该断言做过变异测试：把范围改回 `<0.2.2-0` 时门变红，恢复 `<0.3.0-0` 后变绿。

## 结论

1. `engines.dsh` 的上界按**次版本**划：`>=0.2.1-rc.3 <0.3.0-0`；
2. “loader 静默跳过”必须当作一类独立故障写进排障表（见
   [故障排查](../guide/troubleshooting.md)）；
3. 升级 DSH 后先跑四套门，不要用“插件页没了”去猜代码 bug。
