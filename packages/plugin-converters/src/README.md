# 外部插件格式转换源码导航

识别 Claude Code 与 Codex 插件，将其转换为项目接受的原生插件格式。

## 主要文件

| 文件 | 主要导出 |
| --- | --- |
| [index.ts](./index.ts) | `createBuiltinConverterRegistry` |

## 分类目录

| 目录 | 用途 |
| --- | --- |
| [claude-code/](./claude-code/README.md) | 识别 Claude Code 插件，并转换 Agent、命令、Hook 与 MCP 声明。 |
| [codex/](./codex/README.md) | 读取 Codex 插件声明，转换 Skill、MCP 和相关资源。 |
| [core/](./core/README.md) | 组织转换器注册、计划、报告、内容摘要和再次转换。 |

## 入口与处理步骤

主要入口或定义见 [index.ts](./index.ts)。

识别来源格式，检查可转换能力，生成转换计划；执行转换后写入目标目录，并记录报告与来源摘要。

## 状态放在哪里

输入放在源目录；转换结果及转换记录放在目标目录，检查与计划对象由调用方持有。

## 新代码与测试

根目录保留包入口和分类导航；具体实现放入对应分类。

测试位于 [`__test__/`](./__test__)；只覆盖下级分类的测试放在对应分类的 `__test__/`。
