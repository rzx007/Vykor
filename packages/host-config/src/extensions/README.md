# Hook 与 MCP 配置

定义 Hook、MCP 连接配置和凭据记录格式。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [hooks.ts](./hooks.ts) | `HookType`、`CommandHookDefinition`、`HttpHookDefinition` |
| [mcp-config-validation.ts](./mcp-config-validation.ts) | `McpServerConfigError`、`assertValidMcpServerConfig` |
| [mcp-credentials.ts](./mcp-credentials.ts) | `McpOAuthSettings`、`McpOAuthAuthStatus`、`McpOAuthCredentialRecord` |

## 入口与处理步骤

主要入口或定义见 [hooks.ts](./hooks.ts)。

设置读取后先校验扩展字段，再把连接和授权数据交给 MCP、Auth 或上层编排模块。

## 状态放在哪里

本目录维护配置及记录格式；凭据文件和跨进程凭据锁由 Auth 包管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
