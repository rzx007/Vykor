# Attachment Repository 与事务边界提取设计

> 状态：当前。阶段 2F 实施规格。

## 目标

将 attachment asset、representation 和 lease 的 SQL/row conversion 从 SessionStore 迁入 `packages/services/src/attachments`，保留 Store 兼容 API，并把 Services/Server 调用收敛到窄接口。所有附件写入口补齐 owner fence；schema、migration、HTTP 与文件存储协议不变。

## 结构

```text
attachments/
├─ attachment-records.ts
├─ attachment-repository.ts
├─ attachment-transactions.ts
└─ index.ts
```

- Repository：单表 SQL、查询、CAS 状态更新、row mapping。
- Transactions（公开为 `store.attachments`）：状态机、批量 lease 原子性、soft delete/引用检查、purge 条件；使用 `storage.atomic()` 和 `assertWritable()`。
- 引用计数继续读取 Session read model，保证嵌套事务内未 flush 的 input/message part 引用可见。
- BlobStore、导入补偿、OCR、GC 文件删除、Run lease 周期继续由现有 application/runtime service 拥有。

## 兼容与接线

- SessionStore 原附件方法保留薄转发。
- AttachmentApplicationService、AttachmentIntegrityService、OCR representation adapter、SessionRunExecutor 改用按实际方法定义的窄能力。
- owner fence 覆盖 asset create/transition/delete/purge、representation begin/settle、lease acquire/renew/release/expire。
- 现有 importing→ready|failed、ready→deleted 与 running representation→completed|failed CAS 行为不变。

## 测试

- row roundtrip、排序、includeDeleted、hash lookup。
- 非法/重复状态迁移不改数据。
- 每类写操作 owner fence。
- lease 批量含非法 asset 全回滚、去重、expiry 边界、幂等 release。
- soft delete/purge 受 input、message part、active lease、共享 hash 保护。
-现有 import recovery、OCR cache、GC、Run lease 和 HTTP 回归。
- Store 兼容入口、磁盘重载、schema/migration 不变。

## 后续安全阶段

以下需要 migration 或业务协议变化，不夹带进 2F：lease acquisition token；representation claim token/过期恢复；GC durable claim/saga；child/root Attachment 并发协议。这些进入阶段 3 之后的独立安全计划。

## 验收

- SessionStore 不再包含 asset/representation/lease SQL 与转换。
- `store.attachments` 是附件持久化与状态事务的唯一入口。
-调用方不再依赖完整 SessionStore 获取附件能力。
- Services/Server 相关测试、类型、架构、文档检查通过；schema/migration 无变化。
