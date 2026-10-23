# 事务、修改记录与回滚

让一次相关修改一起提交，并在失败时恢复原来的记录。

## 入口与流程

`atomicWrite()` 为操作建立事务边界；TransactionCoordinator 组织提交与通知；MutationBuffer 记录待保存的对象，TransactionJournal 记录需要回滚的变化。

## 状态归属

事务和回滚记录保存在进程内，SQLite 事务保证持久修改一起生效；结束后释放当前事务状态。

## 主要文件

| 文件 | 主要接口或用途 |
| --- | --- |
| [atomic-write.ts](./atomic-write.ts) | `atomicWrite` |
| [mutation-buffer.ts](./mutation-buffer.ts) | `MutationBuffer`、`createMutationBuffer`、`cloneMutationBuffer` 等 |
| [transaction-coordinator.ts](./transaction-coordinator.ts) | `TransactionCoordinatorHooks`、`TransactionCoordinatorOptions`、`TransactionCoordinator` |
| [transaction-journal.ts](./transaction-journal.ts) | `TransactionJournal` |

## 测试与维护

通用事务协调、修改集合和回滚日志放在这里，具体领域的多表操作放回对应领域目录。

测试放在所属分类同层的 `__test__/`；覆盖多个子分类的测试放在共同上层的 `__test__/`。迁移时同步导入、公开入口、资源地址、文档和旧引用清单。
