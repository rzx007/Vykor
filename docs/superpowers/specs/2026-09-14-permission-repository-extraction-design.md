# Permission Repository 与事务边界提取设计

> 状态：当前。阶段 2E 实施规格。

## 目标与边界

Permission 持久状态迁入 `packages/services/src/permissions`，live resolver、AbortSignal、session 授权复用、parent/child 上溯、日志与 SSE 通知继续由 Server `StorePermissionBroker` 管理。

```text
permissions/
├─ permission-records.ts
├─ permission-repository.ts
└─ index.ts
```

`PermissionRepository` 作为一个内聚边界，负责 create/reply/expirePending/get/list；写操作通过注入的 Session/Run 校验和 durable event 能力使用 `storage.atomic()`，不增加额外 Transactions、UnitOfWork 或事件总线。

## API

```ts
PermissionRepository.create(input)
PermissionRepository.reply(input)
PermissionRepository.expirePending(reason?)
PermissionRepository.get(id)
PermissionRepository.list(options?)
```

Store 构造 `readonly permissions`，原有五个方法仅转发。创建必须验证 Session 和可选 Run；reply 只允许 pending；expirePending 只处理 pending，逐条生成与当前一致的 replied event。

## Server

`StorePermissionBroker` 改为依赖 Permission 五操作、Session lineage 查询和 event cursor 三类窄能力。`PermissionController` 继续持有 resolver。Goal service、control 和 inspector 的查询改用 `store.permissions`，不复制过滤规则。Daemon composition 注入 `store.permissions`。

## 不变量与测试

- create/reply 的 read model、mutation 与 durable event 同一事务提交，事件失败时全部回滚。
- pending 只能结算一次；approved/denied/expired 不能反转。
-启动恢复只过期 pending，并保留终态。
- session 级批准继续沿 parent/child lineage 复用。
- AbortSignal 过期后 resolver 和数据库状态一致。
- owner fence 在每个写入口显式检查，并由 Store transaction/save 的现有写屏障再次保证。
- Store 五个兼容入口、真实 broker composition 和磁盘重载有测试。
- schema、migration、协议和事件类型不变。

## 非目标

- 不改变 PermissionController。
- 不修改权限策略或 UI。
- 不将 Permission 拆成独立数据库。
- 不处理 Attachment。

## 已识别但不夹带修复的问题

当前 create 只验证 Run 存在，没有验证 Run 与 Session 归属一致；child 权限存到根 Session 后，Goal/inspector 的部分查询依赖 payload，存在可见性缺口。这两项属于业务语义与数据模型修复，需要独立规格和迁移策略，本次只保持现有行为并记录，不在纯边界重构中静默改变。
