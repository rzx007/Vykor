# Agent 角色定义

把调用方提供的 Markdown 角色文件转成统一定义，并与内置角色合并。公开入口是 `@vykor/coordinator/definitions` 的 [index.ts](index.ts)，也由包根入口导出。

| 文件 | 用途 |
| --- | --- |
| [types.ts](types.ts) | `AgentDefinition`，描述角色提示词、工具、模型和权限等配置 |
| [loader.ts](loader.ts) | 解析 Markdown 头部、构造角色、批量解析和合并 |
| [builtin.ts](builtin.ts) | 项目内置角色和提示词 |
| [__test__](__test__) | 定义解析、字段处理和内置角色测试 |

宿主读取文件后交给 `parseAgentFiles()`，解析失败的单个文件会跳过。`buildAgentDefinition()` 整理合法字段，`mergeAgentDefinitions()` 按内置、用户、插件顺序合并，同名角色由后者覆盖。

本目录接收文件内容并返回定义数组，不扫描磁盘、不启动 Agent，也不保存注册状态。文件来源和有效定义集合由宿主保存。新增角色字段、解析规则和内置角色放在本目录，测试放同层 `__test__/`。返回[源码导航](../README.md)。
