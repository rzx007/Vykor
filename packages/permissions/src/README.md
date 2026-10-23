# 工具权限检查

公开入口为 `@vykor/permissions` 的 [index.ts](index.ts)。本包给出调用决策，宿主据此执行工具或询问用户。

| 文件 | 用途 |
| --- | --- |
| [index.ts](index.ts) | `PermissionChecker`、只读工具集合、路径与命令匹配，并转导出配置解析和决策类型 |
| [effective-permission-mode.ts](effective-permission-mode.ts) | `effectivePermissionMode()`，将审批和工作模式映射为底层模式 |
| [__test__](__test__) | 模式、拒绝优先级、路径规范化和冲突输入测试 |

`checkTool()` 先统一工具名并检查路径别名冲突，再检查工具拒绝名单、计划模式限制、命令与路径拒绝规则，随后计算显式规则和允许条件，最后返回 `allow`、`deny` 或 `ask`。路径按指定的 `pathStyle` 和 `cwd` 处理。

模式、规则、工具集合和工作目录由 `PermissionChecker` 实例保存在内存中，可通过 `setMode()`、`addRule()` 等操作调整。配置持久化和用户确认结果由宿主保存。

新增权限判断和模式转换放在本目录，测试放同层 `__test__/`，保持小包结构紧凑。返回[包说明](../README.md)。
