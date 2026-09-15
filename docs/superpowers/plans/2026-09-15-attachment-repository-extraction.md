# Attachment Repository 提取实现计划

> **面向 AI 代理的工作者：** 使用 subagent-driven-development 分任务实现、审查并提交。

**目标：** 完成阶段 2F 的 Attachment 存储边界与 owner fence 收敛。

**架构：** Repository 负责 SQL；Transactions 负责状态机和跨表条件；文件与运行生命周期留在现有服务。

**技术栈：** TypeScript、better-sqlite3、Vitest。

---

## 任务 1：Repository 与 Transactions

- 创建 attachments records/repository/transactions/index。
- 从 Store 移动 asset、representation、lease 方法与转换，构造 `store.attachments`，旧方法转发。
- 所有写入口 `assertWritable`，批量与跨状态使用 atomic。
- 保持引用读模型与现有错误文案。
- 补 Repository/Transactions、owner fence、回滚和 Store 兼容测试。

## 任务 2：调用方窄依赖

- AttachmentApplicationService、IntegrityService、OCR adapter、RunExecutor 按实际使用方法依赖 `store.attachments` 或窄 Pick。
- Daemon composition 更新，业务与文件流程不移动。
- 运行相关 Services/Server 测试。

## 任务 3：审查与阶段 2 收尾

- 独立审查并修复 Critical/Important。
- 更新架构基线与状态，标记阶段 2A–2F 完成。
- 运行 Services 全量、Server Attachment/Run 测试、两包类型、架构、文档、schema/migration 检查。
