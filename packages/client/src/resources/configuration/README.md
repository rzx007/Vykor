# 配置与授权资源

访问认证、模型提供方、权限、MCP 和系统配置。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [auth-resource.ts](./auth-resource.ts) | `AuthResource` |
| [mcp-resource.ts](./mcp-resource.ts) | `McpResource` |
| [permission-resource.ts](./permission-resource.ts) | `PermissionResource` |
| [provider-resource.ts](./provider-resource.ts) | `ProviderResource` |
| [system-resource.ts](./system-resource.ts) | `ProjectFactRecord`、`FactReplacementResult`、`DaemonRestartPreview` |

## 入口与处理步骤

主要入口或定义见 [auth-resource.ts](./auth-resource.ts)。

读取或提交配置与授权请求，通过协议客户端送到 daemon，并返回更新后的配置或操作结果。

## 状态放在哪里

远端业务数据由 daemon 保存；连接、订阅和展示状态保存在客户端对象中。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
