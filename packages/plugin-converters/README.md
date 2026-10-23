# @vykor/plugin-converters

识别 Claude Code 与 Codex 插件，将其转换为项目接受的原生插件格式。

## 目录与维护

| 目录 | 用途 |
| --- | --- |
| [src/](./src/README.md) | 识别 Claude Code 与 Codex 插件，将其转换为项目接受的原生插件格式。 |
| [src/claude-code/](./src/claude-code/README.md) | 识别 Claude Code 插件，并转换 Agent、命令、Hook 与 MCP 声明。 |
| [src/codex/](./src/codex/README.md) | 读取 Codex 插件声明，转换 Skill、MCP 和相关资源。 |
| [src/core/](./src/core/README.md) | 组织转换器注册、计划、报告、内容摘要和再次转换。 |
| [fixtures/](./fixtures/README.md) | 保存 Claude Code 与 Codex 格式的转换输入。 |

入口与流程：识别来源格式，检查可转换能力，生成转换计划；执行转换后写入目标目录，并记录报告与来源摘要。

状态归属：输入放在源目录；转换结果及转换记录放在目标目录，检查与计划对象由调用方持有。

新增实现优先放入职责对应的分类；测试放在被测目录的 `__test__/`。迁移时同步公开导出目标、调用方导入、文档和旧引用清单。

```powershell
pnpm --filter @vykor/plugin-converters test
pnpm --filter @vykor/plugin-converters check-types
```
