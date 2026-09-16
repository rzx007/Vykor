# Stage 8：Client 平铺兼容门面移除总计划

> 状态：已完成首轮审查，等待执行 8A。执行人：Codex。8A 完成前禁止登记发行证据或删除兼容方法。

## 1. 最终目标

在外部使用者经历完整迁移窗口后，物理删除 `OpenHarnessClient` 顶层 118 个平铺兼容方法，只保留命名领域 Resource。删除必须进入明确的 major breaking release。

本阶段不自动删除 `transport`、`sse`、`baseUrl`、`token`、`fetchImpl`。这些是高级入口，不属于 118 个平铺 facade。

## 2. 审查结论与计划修订

首轮子代理审查发现，原型门禁只读取当前 contract 中仍标记为 `compatibility` 的条目。若删除时同步移除 contract 条目，门禁会失去审计对象，AST 扫描器也会失去永久禁止名单。这是 Critical，必须先处理。

修订后的方案使用独立、持久的 removal ledger（删除台账）：

- 固定 Stage 7 的 118 个旧名称、replacement、基准 commit 和规范化摘要；
- 两次发行证据只在台账中登记一次，不再依赖会随公共 surface 变化的 contract 条目；
- 删除完成后台账继续存在，扫描器永久使用其旧名称集合阻止旧 API 复活；
- 常规 CI 运行 integrity check：证据 pending 时允许正常开发，但禁止兼容方法数量或名称减少；
- 显式 removal gate 只有在两次真实稳定发行证据与 breaking target 全部通过时才返回 READY；
- 删除后 gate 验证“授权已消费 + tombstone 完整 + 源码中旧方法不存在”，不再因为 0 个 compatibility 条目而自相矛盾。

原型 `scripts/client-compat-removal-gate.mjs` 当前只能证明“现在是 BLOCKED”，不能视为最终删除授权。8A 会重构它。

## 3. 阶段拆分与顺序

| 子阶段 | 结果 | 硬前置 |
| --- | --- | --- |
| 8A | 持久 removal ledger、不可绕过的 integrity/gate、永久旧名扫描 | 无 |
| 8B | A/B/C 发布工作流、preflight、release notes、机器可验凭证 | 8A |
| 8C | 发行 A：首次正式弃用发行并登记真实证据 | 8A、8B |
| 8D | 发行 B：完整保留发行并生成删除授权 | 8C |
| 8E | 物理删除 118 个 facade、更新契约与消费者验证 | 8D gate READY |
| 8F | 发行 C：major breaking release、发布验证和阶段收口 | 8E |

详细任务：

- `2026-09-16-client-stage-8a-removal-ledger.md`
- `2026-09-16-client-stage-8b-release-pipeline.md`
- `2026-09-16-client-stage-8c-deprecation-release.md`
- `2026-09-16-client-stage-8d-retention-authorization.md`
- `2026-09-16-client-stage-8e-facade-removal.md`
- `2026-09-16-client-stage-8f-breaking-release-closeout.md`

## 4. 当前基线

- 生产旧调用与成员引用：0。
- 兼容方法：118 个，仍保留薄转发和 `@deprecated`。
- 首次弃用发行：未发生。
- 后续完整保留发行：未发生。
- 历史 tag：早于 Stage 7，不能作为证据。
- 原型 gate：118/118 BLOCKED。

## 5. 发行证据规则

每次证据至少包含：carrier、version、tag、完整 commit、ISO 发布时间、`stable` channel、仓库 release URL、workflow run URL、npm 包名及 npm 发布校验结果。

本地可验证部分：

- commit 在 Git 中存在；
- `v<version>` tag 解析到同一 commit；
- Stage 7 基准 commit 是发行 commit 的祖先；
- A/B 为不同 tag、不同版本，B 的发布时间晚于 A；
- release URL 指向本仓库对应 tag；
- channel 必须为 `stable`。

发布工作流在线验证 npm 中确有 `@rzx/ohs@<version>`，并把 workflow run 与 npm 结果写入可审计产物。不得使用虚构 hash、历史 tag、nightly、preview 或只创建了 GitHub Release 但 npm 发布失败的版本。

## 6. Breaking 版本规则

发行 C 的目标版本必须高于 B 且提升 major，minor 与 patch 为 0。若 B 属于 1.x，删除版本应为 2.0.0；不得在 patch/minor 版本静默删除公共 API。

## 7. 回滚边界

- 删除 PR 尚未发布：整体 revert 删除提交。
- npm breaking 版本已经发布：npm 版本不可覆盖；立即标记坏版本，恢复兼容层并发布更高 hotfix，或用更高版本前滚修复。
- tag/Release 与 npm 状态不一致：不得登记证据，先修复或发布新版本。
- 不允许只恢复部分 facade，也不允许重新引入仓库内部旧调用。

## 8. 完成定义

阶段 8 只有在以下条件全部成立时完成：

- removal ledger 和永久 tombstone 生效；
- 发行 A、B 证据真实且 gate READY；
- 118 个 facade 已物理删除；
- 发行 C 为 major breaking release，并已验证 npm、tag、Release 一致；
- 全仓类型、测试、架构、文档检查通过；
- 状态文档标记阶段 8 完成。
