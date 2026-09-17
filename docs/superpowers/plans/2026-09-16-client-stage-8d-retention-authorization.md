# Stage 8D：发行 B——完整保留周期与删除授权

> **历史计划，已被取代。** 当前依据是 [clean-slate 设计](../specs/2026-09-16-clean-slate-compatibility-removal-design.md) 与 [clean-slate 总计划](./2026-09-16-clean-slate-compatibility-removal.md)。以下正文仅保留决策历史，不再作为发行或删除门禁。

**目标：** 在 A 之后发布一个仍完整保留兼容层的稳定版本，并生成 major 删除授权。

## 发布前

- [ ] deprecation 证据已经合并，retention 仍为 pending。
- [ ] 118 个 facade 的名称、签名、转发目标和行为未改变。
- [ ] 生产旧调用与引用仍为 0；全量回归通过。
- [ ] B 候选版本高于 A，候选 commit 不等于 A commit。

## 发布与登记

- [ ] 以 `client-retention` 阶段触发发布。
- [ ] 验证 npm、tag、Release notes 和 workflow evidence artifact。
- [ ] 用 helper 写入 `releases.retention`。
- [ ] 以 ISO 时间戳验证 B 晚于 A；允许同一自然日的不同时刻。
- [ ] removal gate 首次达到 release-evidence READY。

## 生成删除授权

- [ ] 选择 C 的 major target；1.x 后固定为 2.0.0。
- [ ] authorization 写入 baseline digest、A/B evidence digest、targetVersion、authorizedAt 和 status=ready。
- [ ] 摘要变化时 gate 必须失败。
- [ ] 单独提交并审查授权，不与 8E 删除代码混在同一提交。

## 完成门槛

- [ ] A/B 是两个真实 stable carrier release。
- [ ] gate 对指定 C target 返回 READY。
- [ ] 118 个 facade 仍完整存在；8E 尚未开始。
