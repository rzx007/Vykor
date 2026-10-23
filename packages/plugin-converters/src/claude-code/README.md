# Claude Code 格式转换

识别 Claude Code 插件，并转换 Agent、命令、Hook 与 MCP 声明。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [convert-agents.ts](./convert-agents.ts) | `convertClaudeAgentMarkdown` |
| [converter.ts](./converter.ts) | `ClaudeCodePluginConverter` |
| [detector.ts](./detector.ts) | `detectClaudeCodePlugin` |
| [mappings.ts](./mappings.ts) | `CLAUDE_MAPPING_VERSION`、`CLAUDE_HOOK_EVENT_MAP` |
| [parser.ts](./parser.ts) | `inspectClaudeCodePlugin` |

## 入口与处理步骤

主要入口或定义见 [convert-agents.ts](./convert-agents.ts)。

检查来源格式，解析文件和映射规则，再把支持的能力写入原生插件目标目录并生成报告。

## 状态放在哪里

输入放在源目录；转换结果及转换记录放在目标目录，检查与计划对象由调用方持有。

## 新代码与测试

与本目录职责一起修改的代码放在这里；跨分类的公共入口由上层目录组织。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
