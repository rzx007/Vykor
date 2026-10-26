# 共享会话状态与保存

定义打开期间的会话状态、配置和记录辅助函数，并把变更写入数据库。

## 入口与流程

store-state 创建状态并提供记录断言、编码和克隆；`persistSessionChanges()` 按 MutationBuffer 中的变化执行增量写入，调用方提供外层事务。

执行头、工具操作和独立派发尝试同样进入共享状态和变更集合；保存完整 JSON 结果及可查询的身份索引，不另开数据库连接。会话路由先按 sessionId 分流，memory 数据只写内存集合，失败时由同一个回滚日志恢复。

## 状态归属

共享状态由 SessionStore 持有，持久事实位于 SQLite；当前变更集合由事务与修改记录模块管理。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [store-persistence.ts](./store-persistence.ts) | `persistSessionChanges` |
| [store-state.ts](./store-state.ts) | `SessionState`、`SessionStoreOptions`、`DEFAULT_DELTA_FLUSH_INTERVAL_MS` 等 |

## 测试与维护

共享会话状态和表字段保存映射放在这里，数据库连接和提交机制放在 database。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
