# Stage 8E：物理删除 118 个平铺 facade

> **历史计划，已被取代。** 当前依据是 [clean-slate 设计](../specs/2026-09-16-clean-slate-compatibility-removal-design.md) 与 [clean-slate 总计划](./2026-09-16-clean-slate-compatibility-removal.md)。以下正文仅保留决策历史，不再作为发行或删除门禁。

**目标：** 消费 8D 的删除授权，一次删除兼容门面，并保留永久 tombstone。

## 任务 1：删除前断言

- [ ] gate 对指定 major target 返回 READY。
- [ ] ledger baseline digest 与授权一致。
- [ ] production legacy calls/references 为 0。
- [ ] 建立删除前 Client 类型与行为测试快照。

## 任务 2：删除实现

- [ ] 从 `packages/client/src/transport/http-client.ts` 删除 118 个 deprecated 转发方法。
- [ ] 不删除命名 Resource，也不顺带删除五个高级入口。
- [ ] 删除只验证旧转发行为的兼容测试，保留 Resource 行为测试。
- [ ] 旧方法专用类型 alias/re-export 只有确认无其他用途才删除。

## 任务 3：更新事实源

- [ ] public contract 移除 118 个当前 public surface 条目并更新 version/summary。
- [ ] ledger 永久保留 118 个 tombstone、replacement 和 A/B 证据。
- [ ] authorization 从 ready 改为 consumed，记录删除 commit 与 targetVersion。
- [ ] scanner 继续从 ledger 读取旧名；源码或消费者重新出现旧名都失败。
- [ ] integrity check 验证删除后状态，不要求 contract 仍有 compatibility entries。

## 任务 4：迁移与编译错误体验

- [ ] 迁移指南改为“已移除”，保留 118 项映射。
- [ ] README 明确最低 breaking version。
- [ ] representative consumer fixture 只使用命名 Resource。
- [ ] 常见旧调用产生清楚的 TypeScript 不存在成员错误。

## 任务 5：统一验证

- [ ] gate 对 consumed 状态通过；Client API 和架构检查通过。
- [ ] Client、CLI、Desktop、Frontend、Server 类型检查与测试通过。
- [ ] 动态属性、解构、Pick、索引访问和别名扫描无旧名残留。
- [ ] 文档、格式和 `git diff --check` 通过。
- [ ] 子代理审查 Critical/Important 全部关闭。

## 完成门槛

- [ ] 118 个方法全部删除，不允许部分删除。
- [ ] ledger/tombstone 保持完整。
- [ ] 尚未宣称阶段 8 完成；等待 8F 真实发布 C。
