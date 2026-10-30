# 上下文与记忆默认服务

接入上下文查看、记忆读写和后台记忆整理。

## 入口与流程

默认工厂组装上下文、Memory 和 Dream 服务，读取会话及扩展信息，调用记忆能力并把操作结果返回应用。

上下文预览和无会话的用量统计使用全局 `replyStyle` 组装提示词，来源报告展示这项默认偏好。带会话的实时统计由 context-usage 读取会话覆盖，并优先采用活跃 Agent 的真实提示词。

## 状态归属

记忆内容由记忆与个性化服务保存，活跃整理任务由传入的执行能力持有。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [context-service.ts](./context-service.ts) | `createDefaultContextService`；个人提示词文件诊断复用 [配置目录的格式化函数](../configuration/profile-service.ts) |
| [dream-service.ts](./dream-service.ts) | `createDefaultDreamService` |
| [memory-service.ts](./memory-service.ts) | `createDefaultMemoryService`、`openMemoryManager` |

## 测试与维护

记忆与上下文的默认服务适配放在这里；会话统计缓存放在 application/context-usage。

测试放在本分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移文件时同步导入、公开入口、文档链接与旧引用清单。
