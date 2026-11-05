# 文档导航

> 面向使用者与贡献者的公开文档。维护者的作业手册在 [MAINTAINING.md](../MAINTAINING.md)，
> 私有材料在 [docs-private/README.md](../docs-private/README.md)（只有入口 README 入库，其余内容留在本机）。

## 公开与私有的分工

| 层 | 位置 | 入库 | 读者 |
| --- | --- | --- | --- |
| 公开 | `README.md` / `README.en.md` / `docs/` | ✅ | 使用者、贡献者 |
| 维护者 | `MAINTAINING.md` | ✅ | 维护者（作业流程与发版规则） |
| 私有 | `docs-private/` | 仅入口 README | 维护者（计划、决策过程、本机环境） |

规则：**公开文档只记已发生的事实**；面向未来的计划、未定稿的取舍、本机信息留在私有，
结论稳定后再按 [私有文档说明](../docs-private/README.md) 的升级路径提升为公开文档。

## 我想先用起来

| 文档 | 内容 |
| --- | --- |
| [项目 README](../README.md) | 是什么、装什么、怎么安装 |
| [配置项](guide/configuration.md) | `overridePath` / `dshOpsCompat` / `utf8Console`、存储位置、生效方式 |
| [故障排查](guide/troubleshooting.md) | 常见症状 → 原因 → 处理 |

## 我想理解它怎么工作

| 文档 | 内容 |
| --- | --- |
| [设计说明](design.md) | 目标与取舍：执行器判定、gate、安装路径、共存桥、UTF-8 桥 |
| [装配契约](reference/architecture.md) | 两半结构、槽位、服务与事件、typert、桥的挂载点 |
| [原生契约](reference/native-contracts.md) | 依赖的上游符号、版本基线、逐项证据 |
| [版本兼容](reference/compatibility.md) | 验证基线、`engines.dsh` 规则、DSH 升级对账流程 |

## 我想确认它可靠

| 文档 | 内容 |
| --- | --- |
| [验收记录](testing.md) | 四套主机门 + 文档门、发布前实机清单、验收表 |

## 我想知道踩过哪些坑

| 文档 | 内容 |
| --- | --- |
| [项目经验](experience/README.md) | 症状 → 根因 → 证据，按条目编号 |

## 我想参与

- [贡献指南](../CONTRIBUTING.md)
- [安全策略](../SECURITY.md)
- [更新日志](../CHANGELOG.md)
- [维护者手册](../MAINTAINING.md)
