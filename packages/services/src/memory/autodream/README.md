# 后台记忆整理

在宿主提供的任务执行能力下整理记忆，并管理锁、备份和恢复。

## 入口与流程

整理服务检查上次完成时间，申请整理锁并备份目录；通过显式传入的 taskRunner 执行整理任务，再报告变化或处理失败后的恢复。

## 状态归属

记忆、备份和整理锁保存在文件系统，执行任务由宿主的 ExecutionRuntimeOwner 管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [backup.ts](./backup.ts) | `defaultBackupRoot`、`createMemoryBackup`、`diffMemoryDirs` 等 |
| [index.ts](./index.ts) | 汇总本分类的接口 |
| [lock.ts](./lock.ts) | `LOCK_FILE`、`HOLDER_STALE_SECONDS`、`readLastConsolidatedAt` 等 |
| [prompt.ts](./prompt.ts) | `MAX_ENTRYPOINT_LINES`、`ENTRYPOINT_NAME`、`buildConsolidationPrompt` |

## 测试与维护

后台整理策略、提示、备份与锁放在这里，单轮记忆提取放在上层 memory。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
