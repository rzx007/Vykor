# Codex 格式转换

读取 Codex 插件声明，转换 Skill、MCP 和相关资源。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [converter.ts](./converter.ts) | `CodexPluginConverter` |
| [mcp.ts](./mcp.ts) | `MappedMcp`、`mapCodexMcp` |
| [source.ts](./source.ts) | `PORTABLE_PLUGIN_SCHEMA`、`CodexSource`、`object` |

## 入口与处理步骤

主要入口或定义见 [converter.ts](./converter.ts)。

定位来源声明与 MCP 配置，检查可转换能力，再复制受支持资源并生成原生 manifest 与报告。

## 状态放在哪里

输入放在源目录；转换结果及转换记录放在目标目录，检查与计划对象由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
