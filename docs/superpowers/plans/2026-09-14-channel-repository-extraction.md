# Channel Repository 提取实现计划

> **面向 AI 代理的工作者：** 使用 executing-plans 执行。用户明确要求先实现代码，再统一补测试和验证。

**目标：** 将 External Conversation 与 Channel Delivery 持久化从 SessionStore 移入 ChannelRepository，并让 Server 使用窄存储能力。

**架构：** Repository 直接使用 StorageContext，写操作沿用 assertWritable owner fence；SessionStore 保留八个兼容转发；ChannelApplicationService 继续负责 lane、Session 创建、Run 等待和交付内容。

**技术栈：** TypeScript、better-sqlite3、Vitest。

---

## 任务 1：实现 Channel Repository

- 创建 `packages/services/src/channels/channel-records.ts`、`channel-repository.ts`、`index.ts`。
- 移动 conversation/delivery row conversion 和八个存储方法。
- 保持 conversation 四元组 upsert、inputId 幂等冲突、unknown attemptCount、sentAt、过滤和排序行为。

## 任务 2：收缩 Store 与 Server 接线

- Store 构造 `readonly channels`，八个旧方法只转发。
- ChannelApplicationService context 拆为 `channels`、Session 查询和 Session application service，不再通过完整 Store 访问 Channel SQL。
- DaemonApplication 注入 `store.channels`。

## 任务 3：统一补测试与验证

- Repository：upsert、list、幂等、冲突、状态转换、owner fence、过滤、磁盘重载、对象隔离。
- Store：八个兼容入口。
- Server：lane/Session 业务回归、窄 fake 和真实 composition。
- 更新架构基线与迁移状态。
- 运行 Services 全量、Server Channel 测试、两包类型、架构、文档及 schema/migration 检查。
