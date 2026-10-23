# 工具所需宿主接口

定义工具依赖的配置、权限、文件、渠道、Skill、MCP 和工作流接口。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [channel.ts](./channel.ts) | `FeishuChannelPort` |
| [config.ts](./config.ts) | `ConfigToolPort` |
| [host.ts](./host.ts) | `McpAuthConfigureInput`、`McpAuthConfigureResult`、`McpAuthHost` |
| [mcp.ts](./mcp.ts) | `McpResourceDescription`、`McpToolPort` |
| [policy.ts](./policy.ts) | `ToolHostPolicyPort`、`FileToolHost`、`ShellToolHost` |
| [skill.ts](./skill.ts) | `ToolSkillDefinition`、`SkillCatalogSnapshot`、`SkillCatalogPort` |
| [workflow.ts](./workflow.ts) | `WorkflowInvocation`、`WorkflowToolPort` |

## 入口与处理步骤

主要入口或定义见 [channel.ts](./channel.ts)。

上层运行时实现接口并注入工具工厂；工具只通过这些接口请求需要的宿主能力。

## 状态放在哪里

接口实现及其连接、配置和任务状态由注入它们的宿主管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
