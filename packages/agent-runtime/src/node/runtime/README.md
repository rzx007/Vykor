# 运行资源组装

| 文件 | 用途 |
| --- | --- |
| `default-runtime.ts` | `createVykorRuntime()`，应用配置和能力限制，组装查询引擎与工具 |
| `node-runtime-builder.ts` | `NodeRuntimeBuilder`，记录组装结果和资源归属 |
| `node-runtime-resources.ts` | `NodeRuntimeResources`，保存引擎、注册表、连接、运行能力和关闭入口 |
| `runtime-integrations.ts` | 接入 MCP、插件、技能等能力，处理连接来源与执行环境 |
| `cleanup-stack.ts` | 登记清理动作，在初始化失败或关闭时按顺序释放资源 |
| `__test__/` | 默认运行资源、接入、所有权、清理和运行事件适配测试 |

agent 组装层调用 `createVykorRuntime()`，构造器收集各项能力，返回带有查询引擎的资源对象。每次运行从这些资源中准备自己的能力范围，关闭时只释放当前对象拥有的资源。

状态集中保存在 `NodeRuntimeResources` 和清理栈中。新增资源组装与释放规则放在这里；agent 操作、子管理、模型配置、工具和记忆分别放在相邻分类。测试辅助的运行适配器留在同层 `__test__/`。
