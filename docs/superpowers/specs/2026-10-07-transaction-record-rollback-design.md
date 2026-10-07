# 事务按记录恢复设计

目标：可靠写入不再复制全部会话、历史事件和临时聊天。普通事务只备份第一次修改的记录；消息、事件顺序、流式刷新、临时聊天和失败恢复保持完整。

## 入口和职责

- `TransactionCoordinator` 仍负责同步 SQLite 事务、嵌套深度、提交后通知、失败恢复和小型游标/dirty 状态。每个外层事务拥有一个 `TransactionJournal`。
- 所有可靠事务入口都先调用既有 `assertWritable`，所有权校验不得拖到提交后。
- `TransactionJournal` 位于 `packages/services/src/database`。只认识对象键、Map 键和追加事件数组，不知道消息、权限、目标等业务含义。
- Repository 在写入、删除、原地改字段之前显式捕获记录。可靠独立写入口通过 `atomicWrite` 先进入事务；它在事务结束后沿用现有 save 回调，保留提交后新产生文本的刷新与所有权检查。
- `IncrementalOutput` 不为每个增量开启事务；已有事务时才捕获被修改的 part/message/session/run。
- 内存持久层和临时控制容器捕获自己的实际改动。业务仓库仍执行原有的赋值、set、delete。

## 核心接口

```ts
class TransactionJournal {
  capture<T extends object, K extends keyof T>(target: T, key: K): void;
  captureMap<K, V>(target: Map<K, V>, key: K): void;
  captureEvents<T>(owner: { events: T[] }): void;
  previous<T extends object, K extends keyof T>(target: T, key: K): T[K] | undefined;
  rollback(): void;
  clear(): void;
}
function atomicWrite<T>(storage: StorageContext, work: () => T, save?: () => void): T;
// StorageContext.rollback?: TransactionJournal，只在未提交的外层事务中存在。
```

同一目标/键首次捕获时深复制旧值或记录原本不存在；重复捕获不再次复制。失败逆序恢复，新增键移除，删除或替换键恢复旧值。

事件内容入队时隔离，返回值也不得暴露保留事件的可变引用。事件查询不原地排序。事务只记原事件数组引用和长度，回滚恢复引用并移除新增事件；删除树的 filter 换数组也能恢复。内存持久层的事件数组采用相同方式。

删除后辨别临时/正式会话时，当前记录不存在就通过 journal.previous 读取已捕获旧 session/run/attempt；停止依赖整份 transactionState。

## 必须保留的行为

1. 保存失败恢复输入、消息、文本、运行、任务、权限、附件引用与临时控制行；不发送成功通知。
2. 保留事务前已经接受的文本、运行进度、事件游标、dirty 标记；撤销失败事务追加的数据。
3. 同一事务改同一记录多次、删后重建和父子会话批量删除，均恢复最初状态。
4. 嵌套事务继续共用外层边界；内层校验异常被业务捕获时不引入独立回滚。
5. 成功提交后先解除并清空 journal，将事务深度归零，再执行提交回调。外层回调按登记顺序执行，异常仍中断后续回调且不撤销已提交数据。回调新接收的数据不进入已结束的备份；回调中的可靠写建立独立事务，其提交回调随独立提交执行。达到阈值的文本可立即 checkpoint，未达到阈值沿用既有定时策略。
6. `snapshot/load/restore` 仍可作为显式读取或故障重载 API，停止被每次事务调用。
7. 不减少历史、截断输出、更改刷新间隔或修改 UI；不增加依赖、数据库迁移、Proxy 或公开客户端/HTTP API。
8. 可靠入口均先进入事务、修改前捕获后，`save` 在协调器失败恢复之后不再重载整库，避免清掉已接受但尚未落盘的正式文本；保留待写 checkpoint 供重试。

## 实施和验证

先增加未启用的 journal/helper 并单测；再接入业务、流式、内存和控制写入口；全部覆盖后切换协调器。验证现有存储和投影测试，补独立写失败、历史事件不可变、无关大记录不访问、临时数据和提交回调等回归。最后用同进程对照量化普通标题更新，并独立审查所有写入口。

本次只改变 services 内部存储边界。主目录其它未提交改动保留；在隔离工作区执行，完成后仅带回本次文件，不自动提交或发布。
