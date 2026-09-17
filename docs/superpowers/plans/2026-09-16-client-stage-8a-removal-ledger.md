# Stage 8A：持久删除台账与不可绕过门禁

> **历史计划，已被取代。** 当前依据是 [clean-slate 设计](../specs/2026-09-16-clean-slate-compatibility-removal-design.md) 与 [clean-slate 总计划](./2026-09-16-clean-slate-compatibility-removal.md)。以下正文仅保留决策历史，不再作为发行或删除门禁。

**目标：** 修复首轮审查的 Critical，使 118 个旧名称在删除 contract 条目后仍可审计、仍被永久禁止复活。

## 任务 1：先固定失败用例

- [x] 把 117 个 compatibility 改为 advanced 时必须失败。
- [x] 增加 0 个 compatibility 条目的删除后状态测试。
- [x] 增加虚构 commit、缺失 tag、tag/commit 不一致、历史 commit 不包含 Stage 7 基准的测试。
- [x] 增加 `nightly`、`preview`、同版本、同 tag、时间倒序测试。
- [x] 增加缺失 carrier、错误 `removeIn`、非法 version/timestamp、非法 URL 测试。
- [x] 增加真实 CLI 的 READY/BLOCKED 退出码、`--json`、未知参数、`--contract` 缺值、非法 JSON 测试。
- [x] SemVer 大数字不得因 `Number` 精度误判；比较器改用 `BigInt` 或数字字符串比较。

## 任务 2：建立独立 removal ledger

- [x] 新增 `scripts/client-compat-removal-ledger.json` 与 schema。
- [x] `baseline` 固定 118 个 `{name, replacement}`、Stage 7 基准 commit、数量和规范化 SHA-256。
- [x] `releases.deprecation` 与 `releases.retention` 初始为 `pending`。
- [x] `authorization` 初始为 `{status: "pending", targetVersion: null}`。
- [x] 未删除前，contract compatibility 集合必须与 ledger baseline 完全一致。
- [x] ledger 不在 8E 删除；它是永久 tombstone 和审计记录。

## 任务 3：拆分两种检查

- [x] `check-client-compat-integrity.mjs` 用于普通 CI，pending 时也返回 0，但禁止方法集合减少、改名、改分类或绕开 ledger。
- [x] `client-compat-removal-gate.mjs` 用于显式删除授权，证据未齐时返回非零。
- [x] 删除后 integrity check 要求源码无旧方法、contract 无旧 public surface、ledger authorization 为 consumed。
- [x] gate 输出区分 contract error、evidence error 和 source-state error，不能出现 `BLOCKED / blockedEntries: 0`。

## 任务 4：验证本地 Git 证据

- [x] 用非 shell 拼接参数调用 Git，验证完整 commit 可解析。
- [x] 验证 `v<version>` tag 存在并解析到 evidence commit。
- [x] 验证 Stage 7 基准 commit 是 A/B commit 的祖先。
- [x] 验证 A/B 使用不同版本和 tag，B 的 `publishedAt` 晚于 A。
- [x] channel 只接受 `stable`。
- [x] release URL 必须匹配当前仓库和 tag；在线存在性由 8B workflow 校验。

## 任务 5：永久扫描与 CI 接入

- [x] `client-legacy-calls.mjs` 从 ledger baseline 读取旧名，不再只依赖当前 compatibility entries。
- [x] `check:architecture` 串联 integrity check，但不串联当前预期失败的显式 removal gate。
- [x] 根 `test` 保留 evaluator 和 CLI 测试。
- [x] 证明删掉 contract compatibility 条目后，重新添加 `client.health()` 仍被扫描器捕获。

## 完成门槛

- [x] 分类绕过、空集合、伪 commit、nightly 和超大 SemVer 用例全部通过。
- [x] 普通 CI 在证据 pending 时通过；尝试删除任一 facade 时失败。
- [x] 显式 gate 当前仍输出 118/118 BLOCKED。
- [x] 文档检查和 `git diff --check` 通过。
