# 渠道配置统一到单一文件设计

## 1. 背景与问题

目前渠道配置被拆在两处：

- `~/.vykor/settings.json` 的 `channels` 段：`sendProgress`、`sendToolHints`、
  `channels.feishu.{enabled, appId, domain, allowFrom, replyAtBotNames}`。
- `~/.vykor/channel-credentials.json`：只有 `feishu` 的 `appSecret`（按 appId 存）。

同一件事（一个飞书机器人能不能用、给谁用、怎么表现）被拆到两个文件，读要同时抽两处、
写要保证两处一致，CLI/工具/未来的桌面都得各拼一次。本设计把**整份渠道配置收敛到
`channel-credentials.json`**，并从 `settings.json` **移除** `channels`。

### 1.1 取代上一份 spec 的哪些决策

本设计**取代** `docs/superpowers/specs/2026-09-18-feishu-cli-onboarding-design.md` 中的两条决策：

- 原决策：非敏感项（`enabled/appId/domain/allowFrom/replyAtBotNames`）留在 `settings.json`，
  只有密钥进凭据文件。**现改为**：整份渠道配置（含密钥）都进 `channel-credentials.json`。
- 原决策：`settings` 白名单保留旧键以免旧配置加载崩。**现改为**：`channels` 硬切移除。

其余决策（扫码优先/手填兜底、默认白名单=扫码者、密钥不回显、fail-closed、单机器人）继续有效。

## 2. 目标与非目标

### 2.1 目标

- 渠道的全部配置只存在 `channel-credentials.json` 一处。
- `settings.json` 不再承载 `channels`。
- `sendProgress`/`sendToolHints` **按渠道**配置并生效。
- 复用现有凭据存储的原子写、文件锁、POSIX 0600。
- `vk channels add/allow` 不再依赖 `settings.json`（这样旧 settings 残留 `channels` 也不会挡住接入）。

### 2.2 非目标

- 多机器人（本阶段仍单飞书机器人）。
- 桌面 UI（后续复用同一存储）。
- `apps/mcp-feishu`（独立目录、无 `package.json`、不参与构建；已被本设计废弃，见 §12）。
- Telegram/Slack/Discord/微信/企业微信/钉钉。
- 不把 `settings.channels` 迁移进新文件（用户按 §11 手动处理）。

## 3. 关键决策

| 决策 | 结论 |
|---|---|
| 文件 | 继续用 `~/.vykor/channel-credentials.json`，升级为完整渠道配置文件 |
| 旧 `settings.channels` | **硬切**：`settings.json` 不再接受 `channels`，出现即 `SettingsFileError` |
| 旧 `channel-credentials.json`（v1） | 视为“未配置渠道”（当空，不报错），见 §4.2 |
| 存储实现 | `packages/auth` 的 `ChannelCredentialStore` **重命名/升级**为 `ChannelConfigStore` |
| 过程开关 | 放进每个渠道的配置；`ChannelManager` 新增按渠道策略 |
| 机器人数量 | 单机器人 |
| `add`/`allow` 依赖 | 不再读写 `settings.json` |

## 4. 文件格式

### 4.1 v2（新）

```json
{
  "version": 2,
  "channels": {
    "feishu": {
      "enabled": true,
      "appId": "cli_...",
      "appSecret": "...",
      "domain": "feishu",
      "allowFrom": { "个人": "ou_...", "工作群": "oc_..." },
      "replyAtBotNames": ["Vykor"],
      "sendProgress": true,
      "sendToolHints": true
    }
  }
}
```

字段规则：

- `enabled`: boolean，必填。
- `appId`: 非空 string，必填。
- `appSecret`: 非空 string，必填。
- `domain`: `"feishu" | "lark"`，可选；**由 store 归一化**为缺省 `"feishu"` 后再返回，
  消费方不再各自补默认值。
- `allowFrom`: `Record<string, string>`，必填；key 是用户自取的展示名（如 `"个人"`），
  value 是 `ou_...`（个人）或 `oc_...`（群）。`"*"` 通配仍受支持（ACL 原样透传 value）。
  写入时拒绝不安全 key：`__proto__`/`constructor`/`prototype`、空字符串、非字符串。
- `replyAtBotNames`: string[]，可选。
- `sendProgress`: boolean，可选（缺省 true）。
- `sendToolHints`: boolean，可选（缺省 true）。

结构校验失败抛 `ChannelConfigStoreError`（不回显 `appSecret`）。空对象
`{ "version": 2, "channels": {} }` 合法，`getFeishu()` 返回 `undefined`。

### 4.2 v1（旧）与坏文件

现有文件形状是 `{ "version": 1, "credentials": { "<appId>": { "appSecret": "..." } } }`。

- **v1 → 视为“未配置渠道”**：`read()` 遇到 `version: 1` 返回空配置（`getFeishu()` 得到
  `undefined`），不抛错。用户重新 `vk channels add feishu` 后即写成 v2。
  （v1 里没有 enabled/allowFrom 等，硬要迁移也补不回来；“当空”比报错更可用。）
- 文件不存在（ENOENT）→ 空配置。
- 其它版本 / 结构非法 → 抛 `ChannelConfigStoreError("invalid-channel-config-store")`。

## 5. 类型与存储 API

### 5.1 类型（`packages/auth` 导出）

```ts
export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: "feishu" | "lark";
  allowFrom: Record<string, string>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export interface ChannelConfigFile {
  version: 2;
  channels: { feishu?: FeishuChannelConfig };
}
```

`FeishuChannelConfig` 从 `packages/core` 迁到 `packages/auth`（不再属于 `Settings`）。
`domain` 在 store 返回时已归一化（非可选）。

### 5.2 `ChannelConfigStore`

- 默认路径 `getChannelCredentialsFilePath()`；构造可注入路径与 clock（便于测试）。
- `getFeishu(): Promise<FeishuChannelConfig | undefined>`（归一化 domain；v1/缺文件 → undefined）
- `setFeishu(config: FeishuChannelConfig): Promise<void>`（校验 + 归一化后写入）
- `updateFeishu(mutate): Promise<FeishuChannelConfig | undefined>`
  - 读-改-写在**同一把文件锁内**完成；
  - `mutate(current)` 返回对象 → 写入（`current` 为 undefined 时即创建）；
  - 返回 `undefined` → 删除该渠道配置。
- `deleteFeishu(): Promise<boolean>`
- 错误类：`ChannelConfigStoreError`（`code` + 不含 secret 的 message）。

实现复用现有：ENOENT 当空、非法结构抛错、临时文件 + rename 原子写、POSIX 0600、
`wx` 锁文件 + 陈旧锁回收 + 超时。

## 6. `settings.json` 硬切（`packages/core`）

- `Settings` 删除 `channels` 字段；删除 `ChannelsConfig`、`FeishuChannelSettings` 类型与导出。
- 字段白名单删除 `channels` 整段（含原 `sendProgress/sendToolHints/feishu` 与旧键容忍）。
- 结果：`settings.json` 或**项目级** `.vykor/settings.json` 里一旦出现 `channels`，
  `loadSettings()` 抛 `SettingsFileError`，错误信息含字段名 `settings.channels`，可据此手动删除。
- 这是**有意的不兼容**。

## 7. 按渠道的过程开关（`packages/channels`）

- `ChannelManagerOptions` 新增
  `channelPolicies?: Record<string, { sendProgress?: boolean; sendToolHints?: boolean }>`。
- 分发时按 `msg.channel`（适配器名，如 `"feishu"`）取策略；**该渠道无策略时回退到 manager
  自己的全局 `sendProgress`/`sendToolHints`（默认 true）**，不来自 settings。
- 现有全局选项保留，避免破坏其它调用方与既有测试。
- `assembleChannelAdapters` 改为从 store 读取飞书配置，并返回
  `policies: Record<string, { sendProgress?: boolean; sendToolHints?: boolean }>` 供 CLI 组装 manager。

## 8. 逐文件改动

| 文件 | 改动 |
|---|---|
| `packages/core/src/types/settings.ts` | 删 `channels` 字段与 `ChannelsConfig`/`FeishuChannelSettings` |
| `packages/core/src/config/settings.ts` | 删 `channels` 白名单段（顶层键 + 嵌套段） |
| `packages/core/src/config/settings.test.ts` | 删“接受旧 feishu 键”用例；新增“含 `channels` 即 `SettingsFileError`” |
| `packages/core/src/index.ts` | 删 `ChannelsConfig`/`FeishuChannelSettings` 导出 |
| `packages/auth/src/channel-credential-store.ts` | 重命名为 `channel-config-store.ts`；`ChannelConfigStore` + v2 结构；v1 当空 |
| `packages/auth/src/__test__/channel-credential-store.test.ts` | 重命名为 `channel-config-store.test.ts`；改为 v2 用例 + v1 当空用例 |
| `packages/auth/src/index.ts` | 导出 `ChannelConfigStore`、`ChannelConfigStoreError`、`FeishuChannelConfig`；删除旧 `ChannelCredentialStore*` 导出 |
| `packages/channels/src/core/manager.ts` | 新增 `channelPolicies`，按渠道门控 |
| `packages/channels/src/__test__/manager.test.ts` | 新增“按渠道开关”用例 |
| `apps/cli/src/commands/channels.ts` | `AssembledChannels` 增 `policies`；`assembleChannelAdapters(store)`；`serve`/`status` 读 store；删除 `settings.channels` 读取 |
| `apps/cli/src/commands/channels-onboarding.ts` | 依赖接口改为 store 语义（`getFeishu/setFeishu/updateFeishu`）；删除 `loadSettings/saveSettings` 依赖与跨文件回滚 |
| `apps/cli/src/commands/channels.test.ts` / `channels-onboarding.test.ts` | 改为注入 `ChannelConfigStore`；删跨文件回滚用例 |
| `packages/tools/src/channels/feishu-push.ts` | 删 `loadSettings`/`_settingsCache`；改从 `getFeishu()` 取 `appId/appSecret/domain/allowFrom`；更新工具描述与错误文案 |
| `packages/tools/package.json` | 保持 `@vykor/auth` 依赖（已有） |

## 9. 测试计划

- `ChannelConfigStore`：v2 读写/更新/删除；缺文件当空；**v1 当空**；坏结构报错；非法 `allowFrom`
  key 拒绝；`domain` 缺省归一化为 `feishu`；`updateFeishu` 创建/删除语义；锁与原子写（沿用现有
  断言；0600 仅 POSIX 平台断言，Windows 跳过）。
- `settings`：含 `channels` 的 settings（用户级与项目级各一）→ `SettingsFileError`。
- `manager`：同一 manager 下两个渠道策略不同，`_progress`/`_tool_hint` 按渠道分别放行/丢弃；
  无策略时回退全局默认。
- CLI：`serve`/`status` 从 store 读；`add`/`allow` 只写 store 且**不触碰 settings**；`add` 在
  旧 settings 残留 `channels` 时仍能执行（因为它不再读 settings）。
- `FeishuPush`：从 store 取 `appId/appSecret/domain/allowFrom`；lark domain 用 `open.larksuite.com`；
  缺配置给明确错误。
- 回归：`channels`/`auth`/`core`/`tools`/`cli` 测试与 typecheck、全仓构建、docs 校验。

## 10. 验收标准

- `pnpm --filter @vykor/auth test -- --run`
- `pnpm --filter @vykor/core test -- --run`
- `pnpm --filter @vykor/channels test -- --run`
- `pnpm --filter @vykor/tools test -- --run`
- `pnpm --filter @rzx/ohs test -- --run`
- 相关包 `check-types` 退出码 0。
- `pnpm exec turbo build --output-logs=full` 全绿。
- `pnpm check-docs` 与 `git diff --check` 通过。

## 11. 破坏性与用户操作

- 升级后，只要 `settings.json`（或项目级 `.vykor/settings.json`）里残留 `channels`，
  `loadSettings()` 就抛 `SettingsFileError`，`vk` 各命令、daemon、TUI 都无法启动。
- **恢复顺序（必须按此）**：
  1. 先手动删除 `settings.json` 里的 `channels` 段（错误信息会指出 `settings.channels`）；
  2. 再运行 `vk channels add feishu` 写入新文件。
- 注意：扫码路径是 `createOnly`，会**新建一个飞书应用**；想复用旧应用请用**手填**路径填旧
  `appId/appSecret`。旧的 `channel-credentials.json`（v1）会被当作“未配置”，重新 `add` 即写成 v2。
- `vk channels add/allow` 不再读 settings，所以第 2 步即使 settings 还没删干净也不会被挡住；
  但 `vk channels serve` 依赖 `settings.model`，仍要求 settings 可正常加载。

## 12. 风险

| 风险 | 缓解 |
|---|---|
| 硬切导致误升级后启动失败 | 错误信息含字段名；发布说明与 §11 写清手动顺序 |
| v1 凭据文件被当空，用户以为还有配置 | 文档说明“v1 视为未配置，需重新 add”；测试覆盖 |
| 过程开关改按渠道，行为面变大 | 保留 manager 全局选项作回退；新增按渠道门控测试 |
| `FeishuPush` 与 CLI 读取逻辑重复 | 统一走 `ChannelConfigStore` |
| 单文件同时含密钥与普通配置 | 整文件 0600；错误与日志不回显 appSecret；Windows 无 chmod 保证，依赖用户目录 ACL（已知限制） |
| `apps/mcp-feishu` 读旧 `settings.channels` 必坏 | 该目录无 `package.json`、不构建，本设计将其标注废弃；不改造 |

## 13. 文档

- `docs/channels-flow.md`：配置示例改新文件；删掉示例里已失效的 `_formatVersion`；说明
  `settings.json` 不再含 `channels`、密钥与配置同文件。
- `README.md`：渠道条目与命令说明。
- `docs/security-and-trust-boundaries.md`：渠道配置与密钥同文件、0600、Windows 限制。
- `docs/development-data-reset.md`：`channel-credentials.json` 说明补“含渠道配置”。
- `docs/context-memory-map.md`：条目说明补“含渠道配置”。
- `docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md`：更新“settings 只留
  非敏感项”等过期描述。
- `PLAN-REMAINING.md`：更新仍写 `settings.channels` 的条目。
- 在 §1.1 已声明本 spec 取代 2026-09-18 spec 的两条决策。

## 14. 自检

- 是否聚焦“渠道配置收敛到一处”？是。
- 是否移除 settings 里的 channels 且明确硬切？是，并说明用户级/项目级都受影响。
- 是否处理旧 v1 凭据文件？是，视为未配置，不崩。
- 恢复路径是否可执行？是：先删 settings.channels，再 add（add 不再依赖 settings）。
- 是否复用成熟存储实现？是。
- 是否有明确测试与验收？是，§9、§10。
- 是否声明取代旧 spec 决策？是，§1.1。
