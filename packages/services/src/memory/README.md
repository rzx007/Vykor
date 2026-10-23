# 记忆提取与会话记忆

从会话中提取长期记忆，并维护压缩后继续对话所需的会话记忆文件。

## 入口与流程

`extractMemoriesFromTurn()` 生成并解析提取结果，再交给记忆能力保存；会话记忆函数生成摘要文件并提供压缩文本；后台整理见 autodream。

## 状态归属

长期记忆由记忆存储能力保存，会话记忆按工作目录和会话标识写入数据目录；当前提取过程使用调用方提供的模型能力。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [memory-extract.ts](./memory-extract.ts) | `ExtractionRecord`、`ExtractionResult`、`hasMemoryWritesSince` 等 |
| [session-memory.ts](./session-memory.ts) | `MAX_SESSION_MEMORY_CHARS`、`MAX_RECENT_LINES`、`CheckpointMessageLike` 等 |

## 子目录

| 目录 | 用途 |
| --- | --- |
| [autodream/](./autodream/README.md) | 在宿主提供的任务执行能力下整理记忆，并管理锁、备份和恢复。 |

## 测试与维护

提取提示、结果处理与会话记忆文件放在本层，后台整理、锁和备份放在 autodream。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
