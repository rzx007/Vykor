# 交接：Desktop 渠道接入板块

> 状态：待接手。这是给下一位同事的交接说明，可直接作为新会话的起始 prompt。

## 背景一句话

飞书 CLI 扫码接入（`ohs channels add feishu`）已完成；下一步是在 Desktop 复用它做一个「渠道接入」板块。

## 已完成（全部合并、已推送）

1. IM runtime 阶段二：入站/出站 image、file，thread/topic，mention/bot，capability gate（严格 fail-closed）。
2. durable 出站平台上下文：rootMessageId 一路带到 adapter，线程回复可用。
3. 飞书 CLI 扫码接入：
   - `ohs channels add feishu`（扫码优先、手填兜底）、`ohs channels allow`、`status`、`serve`；
   - 渠道配置与密钥统一到 `~/.openharness-ts/channel-credentials.json`；`settings.json` 不再承载 `channels`（该统一在 `docs/superpowers/specs/2026-09-19-channel-config-unification-design.md` 落地）；
   - ACL 改为“发送者或会话任一命中”；
   - 提交：`12b4d907`..`1323936a`、`642df4bb`、`6f0220f4`；渠道配置统一见 `50298128`..`9d595dc4`。

## 可复用的核心（不要重写）

- `packages/channels/src/impl/feishu-registration.ts`（扫码状态机，`onCredentials` 回调）
- `packages/channels/src/impl/feishu-verify.ts`（凭据校验）
- `packages/auth/src/channel-config-store.ts`（`ChannelConfigStore`：读写 `channel-credentials.json`，现含渠道配置与密钥）
- `packages/core`：`getChannelCredentialsFilePath`
- `packages/channels/src/bus/acl.ts` + `core/manager.ts` 的 `onDenied`
- CLI 编排参考：`apps/cli/src/commands/channels-onboarding.ts`

Desktop 新增设置板块参考 MCP 设置：`apps/desktop/src/renderer/src/components/desktop/settings-page/mcp-settings.tsx` 及 `shared/ipc-channels.ts`、`shared/desktop-api-contract.ts`、`preload/desktop-api.ts`、`main/features/mcp/{ipc.ts,mcp-service.ts}`、`main/features/index.ts`。渠道配置不在 server 的 settings API 里（`system-resource.ts` 只覆盖 settings）；Desktop 主进程直接读写 `channel-credentials.json`（同一台机器）。连接状态用 `channel-resource.ts` 的 `getStatus`。

## 必须先定清楚的决策

渠道“连接进程”归谁？现状是飞书长连接跑在 `ohs channels serve`（CLI 进程），daemon 不管渠道生命周期，Desktop 无法启停。二选一：

- A（小）：Desktop 只做“接入 + 状态展示”，运行仍靠 `ohs channels serve`。
- B（大）：把渠道生命周期搬进 daemon，Desktop 可启停。

选一条写进 spec 并说明理由。

## 硬约束

- 不降级、不伪造；缺字段直接拒绝。
- 密钥只落 `channel-credentials.json`，任何输出都不回显。
- 不引入兼容性 fallback；旧 `settings.channels` 不再容忍（出现即 `SettingsFileError`，需手动删除）；旧 v1 `channel-credentials.json` 视为“未配置渠道”。
- 白名单空 = 全拒（fail-closed）。
- 复用上一阶段核心，桌面与 CLI 共用同一核心。
- 不擅改 `@openharness/protocol` durable 类型。

## 已知遗留 / 非目标

- 真人端到端验收（`add feishu` 扫码 → `serve` 收发一条 → `allow`）是否已通过，接手先确认。
- `apps/mcp-feishu`（独立目录、不构建）仍读磁盘 `appSecret`；非目标。
- 暂不做其他平台与 Feishu media upload / Agent 出站附件。

## 工作方式

superpowers 流程（brainstorm → spec → plan → subagent-driven/TDD）；每个任务一个 commit；严格 TDD（先红后绿）。

验收命令：

```bash
pnpm --filter @openharness/channels test -- --run
pnpm --filter @openharness/auth test -- --run
pnpm --filter @openharness/core test -- --run
pnpm --filter @openharness/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
pnpm exec turbo build --output-logs=full
pnpm check-docs
git diff --check
```

## 本阶段验收标准

- Desktop「渠道接入」板块可用：扫码/手填 → 校验 → 写凭据与配置 → 显示连接状态。
- 默认白名单 = 接入者本人；可加人/加群；被拒有提示。
- 渠道配置（含密钥）只在 `channel-credentials.json`；`settings.json` 不再有 `channels`；密钥不回显。
- 上述测试/类型/构建/docs 校验全部通过。
- 若选 B，额外证明 Desktop 能启停连接且不影响其他 Session。

## 参考文档

- `docs/channels-flow.md`（渠道权威流程 + 会话分类图）
- `docs/superpowers/specs/2026-09-19-channel-config-unification-design.md`
- `docs/superpowers/plans/2026-09-19-channel-config-unification.md`
- `docs/superpowers/specs/2026-09-18-feishu-cli-onboarding-design.md`
- `docs/superpowers/plans/2026-09-18-feishu-cli-onboarding.md`
- `docs/superpowers/specs/2026-09-18-channels-im-runtime-design.md`
- `docs/superpowers/specs/2026-09-18-channel-durable-delivery-platform-context-design.md`
