# 对话附件阶段 7 实施计划

> 完成状态：已实施并通过验收（2026-08-29）。实际提交为 `c8ab5f4`、`a15c5ca`、`b7edaf5`、`966303b`、`e405985` 和审查补强提交 `5dac4e3`。

> **执行要求：** 使用 `executing-plans` 按本计划推进；每个大步骤内部使用 `test-driven-development`，先写失败测试，再写最小实现。完成前使用 `requesting-code-review` 和 `verification-before-completion`。

**目标：** 让附件在对话压缩、活跃运行、物理回收和备份恢复中保持可继续访问、不会误删、能够检查并一致恢复。

**总体方案：** session input attachment 继续作为持久所有权来源；活跃运行用有过期时间的 lease 提供临时保护；GC 在等待期后按 SHA-256 检查全部资产和 lease 再删除物理 Blob；一致性 scanner 同时检查数据库和 Blob Store；备份 manifest v2 把数据库与 attachments 作为一个整体。Core 只接收有界附件目录，不直接依赖存储层。

**技术栈：** TypeScript、SQLite/Drizzle migration、Node.js 文件系统、Vitest、Turbo、现有 HTTP/control contract。

**设计依据：** `docs/superpowers/specs/2026-08-29-conversation-attachments-stage-7-design.md`

---

## 大步骤 1：附件目录进入 Compaction

**修改区域：**

- `packages/core/src/engine/compact-service.ts`
- `packages/core/src/types/runtime.ts`
- `packages/core/src/engine/compact-service-advanced.test.ts`
- `packages/agent-runtime/src/agent.ts`
- `packages/server/src/application/session/session-maintenance-service.ts`
- `packages/server/src/application/session/__test__/session-maintenance-service.test.ts`
- 新增 `packages/server/src/application/attachment-resource/compact-attachment-catalog.ts`
- 新增对应测试 `packages/server/src/application/attachment-resource/__test__/compact-attachment-catalog.test.ts`

### 1.1 先写失败测试

覆盖：

- compact prompt 包含稳定 `assetId`、显示名、类型、intent 和资源 URI；
- 已完成 OCR/text representation 只进入有界预览，并带 processor/version；
- 没有 OCR 的图片只出现 `ImageToText` 建议，不出现虚构内容；
- 大文本和超多附件按单项、总字符、总项数截断，并明确报告省略；
- `SessionMaintenanceService.compact()` 把当前会话目录传给 Agent；
- compact 成功、失败或被阻止都不改变 `session_input_attachment`。

运行：

```powershell
pnpm --filter @vykor/core test -- compact-service-advanced.test.ts
pnpm --filter @vykor/server test -- compact-attachment-catalog.test.ts session-maintenance-service.test.ts
```

预期：新增断言失败，证明当前压缩没有附件目录。

### 1.2 实现最小通路

- 给 `CompactAttachments` 增加结构化 `attachmentCatalog`，由 `buildCompactPrompt()` 统一渲染并限制字符数。
- Agent compact API 接受本次 maintenance 的附件上下文，避免在 warm runtime 上保存过期回调。
- catalog builder 从 `listSessionInputAttachments()`、asset 和 completed representation 构建去重、有序、可审计的目录。
- 图片无 representation 时只生成能力提示；文本资源使用现有 `attachment://` URI。
- 缺失/deleted 资产进入不可用状态，不伪装成可读取资源。

### 1.3 验证并提交

运行上述测试、相关类型检查和 `git diff --check`，然后提交：

```text
feat(attachments): preserve resources through compaction
```

---

## 大步骤 2：持久 lease 和运行接线

**修改区域：**

- 新增 `packages/services/src/session-runtime/migrations/0016_attachment_lifecycle.sql`
- 更新 `packages/services/src/session-runtime/migrations/meta/_journal.json`
- `packages/services/src/session-runtime/schema.ts`
- `packages/services/src/session-runtime/store.ts`
- `packages/services/src/session-runtime/__test__/store.test.ts`
- `packages/server/src/application/session/session-run-executor.ts`
- `packages/server/src/application/session/__test__/session-run-executor.test.ts`

### 2.1 先写 store 失败测试

覆盖：

- 同一 owner/asset 重复 acquire 为幂等更新，不产生重复 lease；
- renew 只更新未释放且对应 owner 正确的 lease；
- release 可重复；
- `expiresAt <= now` 的 lease 不再有效；
- 批量 acquire 在任一 asset 不存在时整体失败；
- 过期 lease 清理只删除过期行；
- schema migration 在旧数据库上可升级。

### 2.2 实现 lease API

新增 `attachment_lease` 表和唯一索引，Store 提供：

- `acquireAttachmentLeases()`；
- `renewAttachmentLeases()`；
- `releaseAttachmentLeases()`；
- `listActiveAttachmentLeases()`；
- `deleteExpiredAttachmentLeases()`。

所有批量写入在 SQLite transaction 中完成。时间由调用方传入或使用 Store 的统一时钟，测试不依赖真实等待。

### 2.3 接入运行生命周期

- `SessionRunExecutor` 在读取/路由附件前，以 `session_run + runId` 批量 acquire。
- 模型运行期间用受控定时器续期；续期间隔小于 TTL，并正确响应 abort。
- 所有成功、失败、interrupt 和 routing blocked 路径都在 `finally` 释放。
- daemon 崩溃没有 finally 时由 expiresAt 收束。
- lease 清理和现有附件资源目录清理互相独立，一个失败不能跳过另一个。

### 2.4 验证并提交

运行 Services/Server 定向测试，使用 fake timers 验证续期，提交：

```text
feat(attachments): protect active resources with leases
```

---

## 大步骤 3：Scanner、Safe Repair 和 GC

**修改区域：**

- `packages/services/src/attachment/attachment-blob-store.ts`
- `packages/services/src/attachment/__test__/attachment-blob-store.test.ts`
- 新增 `packages/services/src/attachment/attachment-integrity-service.ts`
- 新增 `packages/services/src/attachment/__test__/attachment-integrity-service.test.ts`
- `packages/services/src/session-runtime/store.ts`
- `packages/services/src/session-runtime/schema.ts`
- `packages/server/src/application/retention/application-retention-service.ts`
- 新增/更新 retention 测试

### 3.1 先写 Blob Store 和 scanner 失败测试

Blob Store 覆盖：合法 SHA 列举、stat、幂等删除、非法 SHA 拒绝、非普通文件拒绝、按 bucket 清理空目录。

scanner 覆盖：

- ready/被引用资产缺文件得到 `missing_blob`；
- 大小错误得到 `size_mismatch`；
- 无数据库记录的文件得到 `orphan_blob`；
- 过期 lease、悬空 representation、可 GC 墓碑分类正确；
- scan 不修改数据库和文件；
- 不暴露正文和无关绝对路径。

### 3.2 实现只读扫描与统计

- Store 增加 attachment/representation/lease 的批量查询，避免 scanner 使用私有数据库句柄。
- Blob Store 只接受内部生成路径，并返回 SHA、size、mtime。
- scanner 计算资产数、唯一 Blob、物理字节、逻辑字节、去重节省、问题数和预计可回收字节。

### 3.3 先写 Safe Repair 和 GC 失败测试

覆盖：

- `repair-safe` 只删除过期 lease、悬空 representation 和超过等待期的 orphan Blob；
- missing/corrupt 且仍被引用的资产只报告；
- deleted asset 未过 7 天不处理；
- 有引用或有效 lease 时不处理；
- 同 SHA 仍有 ready/引用/lease 时不删 Blob；
- 共享 Blob 保留时允许只清理已删除资产墓碑；
- Blob 删除失败时保留数据库墓碑；
- 文件已经不存在时可完成墓碑清理；
- GC 连续运行两次幂等；
- 并发运行只有一轮实际清理；
- GC audit 记录扫描、跳过、删除、字节和错误。

### 3.4 实现 GC

- RetentionPolicy 增加附件 grace period，默认 7 天。
- `AttachmentIntegrityService` 实现 `scan`、`repairSafe`、`gc`。
- GC 用应用层单实例 gate；每个候选删除前在事务中再次检查引用、lease 和同 SHA 使用者。
- 文件删除成功/不存在后再删除 representation 和 asset 墓碑。
- 扩展 retention audit 或新增 attachment GC audit，保留最近结果供诊断。

### 3.5 验证并提交

运行 Services 完整测试和 Server retention 测试，提交：

```text
feat(attachments): add integrity scan and safe garbage collection
```

---

## 大步骤 4：Backup Manifest v2 与一致恢复

**修改区域：**

- `packages/server/src/application/backup/application-backup.ts`
- `packages/server/src/application/__test__/durability-boundaries.test.ts`
- 必要时新增 `packages/server/src/application/backup/__test__/application-backup.test.ts`
- `packages/server/src/application/daemon-application.ts`

### 4.1 先写失败测试

覆盖：

- v2 manifest 包含 attachments、资产/Blob 数、字节数和一致性摘要；
- Blob checksums 包含在总校验中；
- 创建备份前遇到 missing/size mismatch 立即失败；
- 备份副本缺文件或被修改时失败；
- 恢复先写同卷临时目标，成功后才切换；
- 任一步失败不留下正式数据库、attachments 或临时目录；
- v1 无附件记录可以恢复；
- v1 有附件记录但没有 attachments 明确失败；
- Unicode、去重 Blob 和 Windows 路径通过。

### 4.2 实现 v2

- `BackupSourceDirectories` 增加 attachments，并让 daemon 默认传入实际 attachment root。
- 创建备份前后复用 scanner；不在备份过程中运行破坏性 GC。
- manifest 明确记录 `attachments`，checksums 继续覆盖整个备份树。
- 恢复使用临时路径和最终 rename；预检目标全部为空后才写入。
- 失败清理只针对本次明确创建的临时路径，绝不递归删除用户指定的既有目录。

### 4.3 验证并提交

运行 backup/durability 测试和 Server 类型检查，提交：

```text
feat(attachments): back up blobs with consistency checks
```

---

## 大步骤 5：诊断接口与最小 Desktop Contract

**修改区域：**

- `packages/server/src/application/control/daemon-control-service.ts`
- `packages/server/src/application/control/__test__/daemon-control-service.test.ts`
- 新增或扩展 `packages/server/src/http/routes/system.ts`
- `packages/server/src/http/routes/__test__/routes.test.ts`
- `packages/client/src/transport/http-client.ts`
- `apps/desktop/src/shared/desktop-api-contract.ts`
- `apps/desktop/src/shared/ipc-channels.ts`
- Desktop main/preload 对应 contract 测试

### 5.1 先写 contract 失败测试

覆盖：

- 只读 `scan` 返回稳定统计和问题代码；
- `repair-safe` 与 `gc` 使用明确动作和响应结构；
- 未授权、错误 method、错误 payload 被拒绝；
- 并发 GC 返回 `attachment_gc_busy`；
- 错误响应不包含附件正文和内部私密路径；
- Desktop contract 能调用 scan/repair/gc，但本阶段不构建完整设置页面。

### 5.2 实现最小入口

- Control service 调用同一个 `AttachmentIntegrityService`，不复制删除逻辑。
- HTTP client 和 Desktop IPC 只做类型化转发。
- 对外返回资产/Blob/lease/问题/可回收字节/最近审计。
- 不增加自动 GC 开关、配额编辑器和文件级批量选择 UI。

### 5.3 验证并提交

运行 Server HTTP、Client、Desktop shared/main/preload 测试，提交：

```text
feat(attachments): expose storage integrity diagnostics
```

---

## 大步骤 6：压力测试、全仓验收和文档收口

**修改区域：**

- Services/Server 的附件生命周期集成测试；
- `docs/superpowers/specs/2026-08-29-conversation-attachments-stage-7-design.md`
- `docs/superpowers/specs/2026-08-27-conversation-attachments-roadmap-design.md`
- 本计划的完成记录。

### 6.1 生命周期压力测试

至少覆盖：

- fork 后原会话归档/删除，fork 仍能读取；
- replay 运行期间原引用变化，lease 仍保护；
- compact、fork、replay、GC 的确定性乱序测试；
- 多 asset 共享 SHA 的大量引用增删；
- daemon 重启后过期 lease 收束；
- scan/GC 在缺失、损坏和 orphan 混合数据上的稳定结果；
- backup/restore 后再次 compact 和读取附件。

测试用 fake clock 和可控文件系统故障，不使用真实 7 天等待。

### 6.2 代码审查

使用 `requesting-code-review` 检查：

- 是否存在先删文件后复核引用的竞态；
- 是否把 message part 错当成唯一持久引用；
- 是否遗漏 replay/fork 引用；
- 是否有未清理 interval、lease 或临时恢复目录；
- Windows 删除/rename 语义和路径边界；
- scanner/错误响应是否泄露正文或绝对路径；
- Provider Files API 是否意外混入。

审查问题先复现再修复，新增回归测试。

### 6.3 全量验证

优先运行纯本地、串行命令，避免仓库既有高并发计时波动：

```powershell
pnpm exec turbo test --concurrency=1
pnpm exec turbo check-types --concurrency=1
node scripts/check-docs.mjs
git diff --check
```

如根 `lint` 仍没有 Turbo task，则记录该仓库事实，并对本阶段修改的 Desktop 文件运行其现有 ESLint 配置。

### 6.4 文档和最终提交

- 把阶段 7 design 状态改为“已实现”，写入真实测试数字和已知限制。
- 路线图把阶段 7 标记完成，并明确 Provider Files API/二进制文档仍延期。
- 在本计划附上实际提交和验证结果。

最终提交：

```text
docs: complete attachment lifecycle stage
```

完成后使用 `finishing-a-development-branch` 给出本地合并选项；若用户继续要求本地合并，则在 main 重新运行关键验证后 fast-forward 合并，并安全移除 worktree 和功能分支。

## 实际执行结果

- 大步骤 1—5 已完成；阶段边界按批准后的本地生命周期方案执行，没有引入 Provider Files API 或二进制文档支持。
- 审查阶段补上了上传与 GC 的共享/独占 gate，避免内容去重上传与物理删除竞态。
- GC 结果写入现有 `retention_audit`，诊断报告返回最近一次审计；文件删除失败保留墓碑并允许后续重试。
- 恢复流程先在与目标同目录的临时路径恢复并复检，再 rename 为正式目标；失败只清理本次临时结果，并拒绝重复、嵌套或位于备份源内的目标。
- Client 与 Desktop 已接通 scan、repair-safe、gc 的最小类型化调用链，没有新增完整存储管理页面。
- 最终全仓测试 58/58 个 Turbo 任务成功，类型检查 57/57 个 Turbo 任务成功；合并到 main 后，114 份 Markdown 文档检查通过，`git diff --check` 通过。
