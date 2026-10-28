# 设置读取与修改

管理设置类型、合并规则、受控修改以及工具和调度配置。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [agent-environment-settings.ts](./agent-environment-settings.ts) | `parseAgentEnvironmentSettings`、`mergeAgentEnvironmentSettings` |
| [request-configuration.ts](./request-configuration.ts) | `AgentRequestConfiguration`、`AgentRequestConfigurationPatch`、`AgentRequestConfigurationSnapshot` |
| [schedules.ts](./schedules.ts) | `AgentScheduledTaskInput`、`AgentScheduledTask`、`AgentScheduledRun` |
| [settings-mutation.ts](./settings-mutation.ts) | `SettingsConflictError`、`SettingsLockTimeoutError`、`SettingsLockOptions` |
| [settings-types.ts](./settings-types.ts) | `McpStdioServerConfig`、`McpRemoteServerConfig`、`McpServerConfig` |
| [settings.ts](./settings.ts) | `DEFAULT_OUTPUT_TOKEN_MAX`、`OUTPUT_TOKEN_CAP_RATIO`、`resolveOutputTokenCap` |
| [tool-configuration.ts](./tool-configuration.ts) | `assertNoRemovedLifecycleToolNames` |
| [tool-output-policy.ts](./tool-output-policy.ts) | `readToolOutputPolicy`、`readToolExecutionTimeoutMs` |

## 入口与处理步骤

主要入口或定义见 [agent-environment-settings.ts](./agent-environment-settings.ts)。

读取用户与项目设置并合并；配置消费者提取需要的字段，修改入口校验后通过存储模块写入。

`blockOnUnknownToolOutcome` 是宿主全局开关，默认 `false`。只有明确启用才让历史未知工具结果阻止其他写入；操作记录、权限和同一操作的重复执行保护继续生效。Daemon 每次检查读取当前值，在线修改不必重建 Agent。原因与范围见[决策记录](../../../../docs/tool-outcome-blocking-decision.md)。

## 状态放在哪里

配置文件保存在用户或项目配置目录；读取结果和单次修改上下文由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
