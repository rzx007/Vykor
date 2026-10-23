# 组件读取

读取插件声明的 Agent、Skill、Hook、MCP、Tool 和应用资源。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [agents.ts](./agents.ts) | `loadNativeAgents` |
| [app-resources.ts](./app-resources.ts) | `PluginAppResourceMetadata`、`loadPluginAppResource`、`readPluginAppResource` |
| [apps.ts](./apps.ts) | `NativeAppMetadata`、`loadNativeAppMetadata` |
| [hooks.ts](./hooks.ts) | `loadNativeHooks` |
| [mcp.ts](./mcp.ts) | `loadNativeMcpServers` |
| [safe-files.ts](./safe-files.ts) | `PluginFileReadError`、`readPluginFileBytes` |
| [skills.ts](./skills.ts) | `loadNativeSkills` |
| [tools.ts](./tools.ts) | `resolveEffectiveToolPermissions`、`loadNativeToolMetadata` |

## 入口与处理步骤

主要入口或定义见 [agents.ts](./agents.ts)。

加载器按 manifest 的组件声明调用对应读取函数，先检查资源路径和内容，再返回组件或诊断。

## 状态放在哪里

安装文件和安装记录由 installation 管理；加载与激活结果、运行期实例由调用方管理。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
