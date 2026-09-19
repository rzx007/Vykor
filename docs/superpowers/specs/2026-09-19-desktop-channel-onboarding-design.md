# Desktop 渠道接入（连接板块）设计

## 1. 背景与现状

飞书 CLI 扫码接入（`ohs channels add feishu`）与 IM runtime 阶段二已完成。现在的情况是：

- **daemon** 拥有 durable 侧：会话、Run、权限、对话记录，以及 `/channels/*` 路由下的 `ChannelApplicationService`（建会话映射、幂等准入、保存待发送回复）。
- **`ohs channels serve`** 是另一个长驻进程，拥有传输运行时：`FeishuAdapter` + `MessageBus` + `ChannelManager` + `DurableChannelBridge`，通过 HTTP 把消息交给 daemon。
- 渠道配置与密钥统一在默认 `~/.openharness-ts/channel-credentials.json`（受 `OPENHARNESS_CONFIG_DIR` 覆盖，v2）；`settings.json` 不再承载 `channels`。
- Desktop 设置里已有“连接”导航项（slug `connections`），但内容是空白占位；Desktop 主进程没有任何渠道能力。
- Desktop 在没有外部 daemon 时会在 Electron 主进程里启动**内置 daemon**（`apps/desktop/src/main/features/session/daemon-connection-service.ts`），外部 daemon 也可通过注册表接管。

由此产生六个实际短板：

1. Desktop 看不到也管不了渠道：长连接只存在于 `serve` 那个终端窗口。
2. “连接状态”没有真实来源：daemon 里只有会话/回复记录，不知道长连接是否在线。
3. 白名单拒绝只打印在 `serve` 控制台，Desktop 用户看不到。
4. 关掉 `serve` 机器人就掉线；没有进程级监督与首次连接失败的重试（已建立的连接由 lark SDK 自身 `autoReconnect` 重连）。
5. 同一个人跑两个 `serve`，同一个飞书应用会有两条长连接，消息被重复消费。
6. 接入必须开终端，Desktop 用户无法完成扫码/手填。

## 2. 目标与非目标

### 2.1 目标

- 渠道长连接的生命周期搬进 daemon：daemon 是唯一的连接所有者，支持启停、进程级监督、状态查询。
- 配置与接入（扫码状态机、凭据校验、写配置、白名单）也搬进 daemon：`channel-credentials.json` 只有 daemon 一个写入者。
- Desktop 新增“连接”板块：扫码/手填 → 校验 → 写配置 → 显示真实连接状态 → 白名单增删即时生效 → 被拒提示 → 启停。
- CLI `channels add/allow/status/serve` 改为委托 daemon，行为兼容，不再本地装配 adapter、不再本地写配置。
- 桌面与 CLI 共用同一套核心（`@openharness/channels`、`@openharness/auth`），不重写。
- 启用（`enabled=true`）的渠道随 daemon 启动自动连接；失败只影响该渠道，不阻塞 daemon。

### 2.2 非目标

- 除飞书外的其他平台（Telegram/Slack/Discord/微信等）。
- 飞书 media 上传与 Agent 出站附件。
- 渠道运行时状态的 SSE 实时推送（本阶段 Desktop 轮询，见 §10.2）。
- Desktop 编辑 `replyAtBotNames`（本阶段只读展示）。
- `apps/mcp-feishu`（独立目录、不构建），维持现状。
- 多机器人（仍为单飞书应用）。
- 修改 `@openharness/protocol` 里的 durable 类型（只新增 runtime DTO）。

## 3. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 长连接归属 | **搬进 daemon**（`ChannelRuntimeService`） | daemon 已在管会话与 durable 回复；只有同一进程持有连接，Desktop/CLI 才能统一启停和看到真实状态；也消除双连接风险 |
| 配置与接入归属 | **daemon 全权**（`ChannelOnboardingService`） | 运行时与配置同进程，配置变更立即生效；文件只有一个写入者 |
| 取代交接文档的哪条 | 交接文档写“Desktop 主进程直接读写 `channel-credentials.json`”，本设计**取代**为“daemon 读写，客户端走 API” | 与“daemon 全权”一致；避免 Desktop 写文件后 daemon 运行时不同步 |
| Desktop 板块位置 | 复用设置导航现有“连接”（slug `connections`） | 已存在入口与占位，语义合适 |
| 二维码 | 主进程生成 data URL（新增 `qrcode` 依赖），渲染进程显示 | Desktop 无 QR 依赖；主进程只传二维码图片与授权链接，不传密钥 |
| 渠道会话 cwd | `~/.openharness-ts/channels/<connector>/<sanitize+hash(会话键)>/`，自动建目录 | CLI 原先用 `process.cwd()`，在 daemon 里没有意义；专用工作区不污染用户项目，且按会话隔离 |
| daemon 启动行为 | `enabled=true` 的渠道在 `ready()` 后**后台**自动连接；每渠道独立失败 | 重启 daemon 不掉线；单个渠道失败不影响 daemon ready 与其他渠道 |
| `ohs channels serve` | 改为委托：确保 daemon → 启动运行时 → 跟随状态/拒绝 → Ctrl+C 有界停止本次连接 | 保证同一 appId 只有一条长连接 |
| 拒绝提示 | `status()` 返回有界 `recentDenials`（带单调 `seq`），Desktop 轮询展示 | 不新增事件通道即可满足“被拒有提示”；SSE 留后续 |
| ACL/策略变更 | 运行中**原地生效**，不重启连接 | `ChannelManager` 每条消息读取 `allowFrom`/`channelPolicies`；只有连接指纹变化才重启（见 §8.1） |

## 4. 目标架构与归属

```
飞书 ⇄ FeishuAdapter（daemon 内）
     → MessageBus(inbound) → DurableChannelBridge → ChannelApplicationService（daemon 内直调，不走 HTTP）
     → Session / Run / 权限（复用现有）
     → delivery（store）
     → MessageBus(outbound) → ChannelManager → FeishuAdapter 发送
```

- `ChannelRuntimeService`：持有每个 connector 的 `MessageBus + ChannelManager + DurableChannelBridge`，负责启停、重连监督、状态、拒绝上报、cwd 解析。
- `ChannelOnboardingService`：持有 `ChannelConfigStore`，负责扫码注册、手填校验、写配置、白名单增删、启停持久化。
- 两者挂在 `DaemonApplication` 上，通过 HTTP 路由 `/channels/runtime/*` 与 `/channels/feishu/*` 暴露；`DurableAgentApplication` 接口新增这两个只读字段。
- Desktop 通过 `OpenHarnessClient.channels`（扩展后的 `ChannelResource`）访问；CLI 同理。
- `@openharness/channels` 在 server 内**动态 import**：渠道未启用时 server 启动路径不加载 lark SDK。注意这**不保证** SDK 不随 Desktop 安装包分发——它仍可能作为懒加载 chunk 被打进 `out/main`。取舍与验证见 §14 风险表。

依赖方向：`packages/server` 已依赖 `@openharness/auth`；新增依赖 `@openharness/channels`（后者只依赖 `@openharness/protocol` 与 lark SDK，无环）。Desktop 的主进程边界脚本只允许 `@openharness/client` 与 `@openharness/server`，因此 Desktop **不新增** workspace 依赖，只走 HTTP。

## 5. 消息与生命周期

### 5.1 入站/出站（与今天一致的部分）

入站：适配器 → `ChannelManager.handleInbound`（ACL fail-closed，按 sender 或 chatId 任一命中）→ `MessageBus` → `DurableChannelBridge` → daemon application（直接调用，不再 HTTP）。

出站：application 保存 delivery → bridge 发布到 `MessageBus` → `ChannelManager.dispatchOutbound` → 适配器发送 → `recordDelivery` 回写状态。

差异只有一处：`DurableChannelBridge` 的 `cwd` 由固定字符串改为**按消息解析**（见 §6.2）。

### 5.2 生命周期与停机契约

```
daemon ready()
  → void channelRuntime.startEnabled()      // 后台；每个 connector 进入独立 lane
      → 读 ChannelConfigStore
      → 对每个 enabled connector（在 lane 内串行）：
          - 同步置 state=starting（在第一个 await 之前）
          - 缺 appId/appSecret → state=error，lastError 明确
          - 缺 settings.model → state=error，lastError="未配置模型"
          - 装配 adapter + bus + manager + bridge；manager.startAll()；bridge.start()
          - 校验凭据取 botName（best-effort，失败只记 lastError，不改变 running）
          → state=running
  → 任一 connector 失败不影响其他 connector，也不影响 daemon ready

daemon close()
  → channelRuntime.shutdown()：标记 closed
    → 先停止接收入站（manager.stopInbound() 只丢弃新事件、不关闭传输，
      这样在途 Run 的回复仍能在排空窗口发出）
    → bridge.stop({drainTimeoutMs}) 有界等待在途消息 → manager.stopAll()（真正断开）
  → control.shutdown()：再中断/排空 Run（在此之前的渠道排空不被 Run 中断打断）
  → 释放 owner / 关 store
```

明确语义：

- **在途消息**：`handleChannelMessage` 可能等待整条 Agent Run。停机时先断入站，避免新消息进入内存队列；随后最多等 `drainTimeoutMs`（默认 5000ms）。超时不等，未发送回复保持 durable pending，下次 `start` 由 `recoverPending` 恢复。daemon 停机可能中断在途 Run，平台可能收不到这次回复——这是显式接受的语义，写进文档。
- **两阶段停止**：`ChannelManager` 新增 `stopInbound()`（只断开适配器、不再收新消息，保留出站分发循环），与 `stopAll()`（abort 出站循环 + disconnect）区分；`stopAll()` 保持幂等。
- **`bridge.stop(options?: { drainTimeoutMs?: number })`**：停止消费新入站，最多等在途 handle 指定时间。
- **daemon 重启后**：`enabled=true` 的渠道自动恢复连接；`stop(connector)` 是运行期临时停止，不修改 `enabled`，重启后仍会恢复。UI/CLI 必须区分“已停用（持久，重启不连）”与“已停止（临时，重启恢复）”。
- **进程级监督**：start 失败（首次连接失败、凭据失效）只记录 `state=error + lastError`，不自动无限重试；已建立的连接断开由 lark SDK `autoReconnect` 重连。用户可通过 Desktop 主开关或 `runtime/start` 手动重试。

## 6. 配置与工作目录

### 6.1 配置（沿用现有文件，不改格式）

`ChannelConfigStore`（`packages/auth`）继续读写默认 `~/.openharness-ts/channel-credentials.json`（`OPENHARNESS_CONFIG_DIR` 可覆盖）v2，字段不变：`enabled/appId/appSecret/domain/allowFrom/replyAtBotNames/sendProgress/sendToolHints`。daemon 是唯一写入者。

`FeishuChannelConfig` **不新增字段**；`botName` 是运行时内存缓存，按 `(appId, domain)` 键控：配置变化或 verify 失败即清除，快照只在缓存键与当前配置一致时返回。

### 6.2 工作目录

`packages/core/src/config/paths.ts` 新增：

```ts
/** 渠道会话专用工作区根目录；可用 OPENHARNESS_CHANNELS_DIR 覆盖（daemon 启动时读取）。 */
export function getChannelWorkspaceRoot(): string {
  return process.env.OPENHARNESS_CHANNELS_DIR ?? join(getConfigDir(), "channels");
}
```

运行时按**会话键**（与 Session 分类键一致：`connector + accountId + chatId + threadId`）解析目录：

```
<root>/<connector>/<sanitize(chatId)>-<sha1(connector|accountId|chatId|threadId).slice(0,12)>/
```

- `sanitize`：把 `[^A-Za-z0-9._-]` 替换为 `_`，截断到 80 字符；`win32` 下统一小写；结果为空、为 `.`/`..`、或以点/空格结尾时改用 `"session"` 前缀；hash 后缀保证不同会话键不会撞同一目录。
- 同一会话键永远映射到同一目录（hash 稳定），`threadId` 参与 hash（同群不同话题是不同 Session，也是不同工作区）。
- 每条消息处理前 `mkdir(..., { recursive: true })`（目录被用户删除可自愈）。
- **建目录失败**（EACCES/ENOSPC 等）：该消息按失败处理，不换目录、不重试；运行时把原因（含 chatId、不含密钥）写入该 connector 的 `lastError` 并记录告警。连接状态不因此改变。
- `DurableChannelBridge` 的 `cwd` 参数扩展为 `string | ((message: InboundMessage) => string | Promise<string>)`；现有测试与调用方同步更新。

## 7. 协议与 API 契约

新增 `packages/protocol/src/channel-runtime.ts`（不动 `channel.ts` 里的 durable 类型），手写 parser（沿用 `record/required/optional` 风格），并在 `packages/protocol/src/index.ts` 增加一行 `export * from "./channel-runtime.js"`。

### 7.1 DTO

```ts
export type ChannelRuntimeState = "stopped" | "starting" | "running" | "stopping" | "error";

export interface ChannelConnectorRuntimeStatus {
  connector: string;            // "feishu"
  enabled: boolean;
  state: ChannelRuntimeState;
  accountId?: string;           // appId
  domain?: "feishu" | "lark";
  botName?: string;             // 仅当缓存键与当前配置一致
  startedAt?: number;
  lastError?: string;
}

export interface ChannelDenialNotice {
  connector: string;
  sender: string;
  chatId: string;
  at: number;                   // epoch ms
  seq: number;                  // 服务内单调递增；客户端高水位去重用
}

export interface ChannelRuntimeStatus {
  bootId: string;               // 运行时服务实例 id；daemon 重启后变化
  connectors: ChannelConnectorRuntimeStatus[];
  recentDenials: ChannelDenialNotice[];   // 有界，最多 50 条，按 seq 升序
}

export interface FeishuChannelSnapshot {
  configured: boolean;
  enabled: boolean;
  appId?: string;
  domain?: "feishu" | "lark";
  botName?: string;             // 运行时缓存，未连接时缺省
  allowFrom: Array<{ name: string; id: string }>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}                               // 永不包含 appSecret

export interface FeishuRegistrationSnapshot {
  state: "idle" | "starting" | "qr_ready" | "polling" | "slow_down"
       | "domain_switched" | "succeeded" | "expired" | "cancelled" | "error";
  attempt: number;              // 单调递增；客户端据此丢弃过期二维码
  domain: "feishu" | "lark";
  qrUrl?: string;
  expiresAt?: number;
  remainingSeconds?: number;
  pollIntervalMs?: number;
  error?: { code: string; message: string };
  warning?: string;             // 例如扫码返回缺少 open_id："白名单为空，所有消息都会被拒绝"
}
```

输入 parser：`parseChannelRuntimeControlInput`（可选 `connector`）、`parseFeishuConnectInput`（必填 `appId/appSecret`，可选 `domain`，非法 domain 拒绝；**appSecret 只允许出现在请求体**）、`parseFeishuAllowInput`（`id` 必须 `ou_`/`oc_` 开头——`*` 与复合 id 不允许新建，可选 `name`）、`parseFeishuPatchInput`（至少一个已知键 `enabled`/`sendProgress`/`sendToolHints`，未知键拒绝）、`parseFeishuRegistrationStartInput`（可选 `domain`）。

### 7.2 路由（新增 `packages/server/src/http/routes/channel-control.ts`，挂 `/channels`）

| 方法 | 路径 | 成功 | 错误语义 |
|---|---|---|---|
| GET | `/channels/runtime/status` | 200 `ChannelRuntimeStatus` | — |
| POST | `/channels/runtime/start` | 200 `ChannelRuntimeStatus`（后台启动；凭据/模型问题体现在 `state=error`） | 未配置/未启用/未知 connector → 409；service 已关闭 → 503 |
| POST | `/channels/runtime/stop` | 200 `ChannelRuntimeStatus`，幂等 | 未知 connector → 404；已关闭 → 503 |
| GET | `/channels/feishu` | 200 `FeishuChannelSnapshot` | — |
| PATCH | `/channels/feishu` | 200 `{ feishu, runtime }`；`enabled=true` 时持久化优先，连接失败体现在 runtime | 无配置 → 409；无已知键 → 400 |
| POST | `/channels/feishu/connect` | 200 `{ feishu, runtime }` | 校验失败 → 400（不写文件）；非法输入 → 400 |
| DELETE | `/channels/feishu` | 200 `{ feishu, runtime }`，幂等 | — |
| POST | `/channels/feishu/allow` | 200 `FeishuChannelSnapshot` | 非法 id → 400；无配置 → 409 |
| DELETE | `/channels/feishu/allow/:key` | 200 `FeishuChannelSnapshot`，幂等 | 无配置 → 409 |
| POST | `/channels/feishu/registration` | 200 `FeishuRegistrationSnapshot`（active 时 supersede 并返回新 attempt） | — |
| GET | `/channels/feishu/registration` | 200 `FeishuRegistrationSnapshot` | — |
| DELETE | `/channels/feishu/registration` | 200 `FeishuRegistrationSnapshot`，幂等 | — |

补充规则：

- **响应形状约定**：只读单个资源返回该资源本身；一次操作同时改变配置与运行时（`patch`/`connect`/`remove`）返回 `{ feishu, runtime }`。client 与路由逐一相同（§7.3）。
- `allow` 的 key = `name ?? id`：`name` 为空白串按缺省处理（key=id）；同名 key 覆盖既有条目（显式语义）；`DELETE .../allow/:key` 删除 key 对应条目（既有配置里的 `*`/复合 id 允许删除，不允许新建）；client 对 `:key` 做 `encodeURIComponent`。
- 所有写路由要求 `authorization` 头；服务未配置 token 的实例对 `/channels/feishu/*`、`/channels/runtime/start|stop` 返回 503（渠道写接口涉及密钥与 ACL，不沿用“无 token 全放行”）。
- 错误沿用 `applicationErrorResponse` / `protocolValidationErrorResponse`；存储/校验/运行时内部异常 → 500；service 已关闭 → 503。
- **响应与错误消息不含 `appSecret`**；`qrUrl` 只允许出现在注册接口的响应体中（见 §11 的 QR 不变量），不得进入日志、错误消息或持久化。

### 7.3 client

`packages/client/src/resources/channel-resource.ts` 新增方法，**每个方法的返回类型与对应路由的响应体完全相同**：

```ts
runtimeStatus(): Promise<ChannelRuntimeStatus>
startRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>
stopRuntime(input?: { connector?: string }): Promise<ChannelRuntimeStatus>
getFeishu(): Promise<FeishuChannelSnapshot>
patchFeishu(input: { enabled?; sendProgress?; sendToolHints? }): Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
connectFeishu(input: { appId; appSecret; domain? }): Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
removeFeishu(): Promise<{ feishu: FeishuChannelSnapshot; runtime: ChannelRuntimeStatus }>
addFeishuAllow(input: { id; name? }): Promise<FeishuChannelSnapshot>
removeFeishuAllow(key: string): Promise<FeishuChannelSnapshot>
startFeishuRegistration(input?: { domain? }): Promise<FeishuRegistrationSnapshot>
feishuRegistrationStatus(): Promise<FeishuRegistrationSnapshot>
cancelFeishuRegistration(): Promise<FeishuRegistrationSnapshot>
```

- 组合状态（配置 + 运行时）由调用方（Desktop main 的 `snapshot()`）自行合成，client 不做隐式组合。
- `packages/client/src/index.ts` **必须**导出本设计新增的全部 DTO 类型（无条件），并同步 `scripts/client-public-api-contract.json`；Desktop 的 `shared/channel-types.ts` 从 `@openharness/client` 复用这些类型（边界脚本只允许 Desktop 依赖 client/server）。
- 同步 `tests/client-public-api/consumer.ts`（代表性调用）与 `packages/client/src/__test__/public-api.test.ts`。

## 8. daemon 服务设计

### 8.1 `ChannelRuntimeService`（`packages/server/src/daemon/channel-runtime-service.ts`）

```ts
export interface ChannelRuntimeApplicationPort {
  handleMessage(input: DurableChannelMessageInput): Promise<DurableChannelMessageResult>;
  pendingDeliveries(options?: { connector?: string; limit?: number }): Promise<ChannelDeliveryRecord[]>;
  recordDelivery(id: string, input: RecordChannelDeliveryInput): Promise<ChannelDeliveryRecord>;
}

export interface ChannelRuntimeServiceOptions {
  application: ChannelRuntimeApplicationPort;   // 由 ChannelApplicationService 适配并改名到 DurableChannelPort
  config: { getFeishu(): Promise<FeishuChannelConfig | undefined> };
  getSettings(): Settings | undefined;
  workspaceRoot?: string;                        // 默认 getChannelWorkspaceRoot()
  onDenied?(notice: ChannelDenialNotice): void;
  logger?(event: ObservabilityEvent): void;
  now?(): number;                                // 测试注入
  drainTimeoutMs?: number;                       // 默认 5000
}
```

**并发模型（强制）**：

- 每个 connector 一条 promise-chain **lane**；`start/stop/restart/shutdown` 全部入 lane 串行执行，不允许并发操作同一 connector。
- 每个 connector 维护单调 `generation`；操作开始时捕获 generation，完成或失败时若 generation 已变化，则丢弃结果并补偿（断开自己刚建立的 adapter、清掉 bus/bridge，不写 status）。
- `state` 按 `stopped | starting | running | stopping | error` 流转；除 `startEnabled()` 在入 lane 前**同步**置 `starting`（避免与 Desktop 首轮 status 抢跑道）这一处例外，其余状态变更都在 lane 内进行。
- `shutdown()` 先把服务标 `closed`：之后 `start/restart` 返回 409；已在 lane 中的 start 完成后立即被停掉。
- `startEnabled()` **不得 reject**：任何错误（含配置读取失败）都只落 `state=error + lastError`，绝不 reject。
- 显式 `start` 只对「未配置/未启用/未知 connector/已关闭」抛类型化错误；模型缺失、凭据失效、连接失败等运行期问题只落 `state=error + lastError`，HTTP 返回 200。
- `shutdown()` 对每个 connector 的 lane 等待有硬上限（默认 15s），超时不再等待，避免 daemon 关不掉。
- `restart(connector)` = 同一 lane 内先 stop 后 start，绝不并发。
- `stop()` 幂等；若 lane 内已有 start 排队，stop 排在其后，最终状态必须停。

**配置应用（ACL 即时生效）**：

- `applyFeishuConfig(config)`：**先算连接指纹** `(enabled, appId, appSecret, domain, replyAtBotNames)`，按固定优先级处理：
  1. 指纹变化 → 入 lane 重启：`enabled=false` 停；`enabled=true` 起。
  2. 指纹不变 → 只**原地更新** `allowFrom`/`channelPolicies` 同一份可变对象（`manager` 每条消息读取 `opts.allowFrom` / `channelPolicies`），**绝不重启**；即使当前是临时停止，也保持停止。
- `stop(connector)` 是临时停止；`enabled=false` 持久化后不得再自动连接。

**其他**：

- `getSettings()?.model` 缺失 → `state=error`，`lastError="未配置模型"`，不连接。model 在连接建立时取一次，运行期固定；改全局模型需停止/启动渠道才生效（非目标自动跟随）。
- 连接前 `verifyFeishuCredentials` 取 `botName`：失败只记 `lastError`，不阻止 `running`；成功写入按 `(appId, domain)` 键控的缓存。
- `onDenied` 来自 `ChannelManager`（仅当 `chatId` 存在），转换为 `ChannelDenialNotice`（分配单调 `seq`）入有界队列（≤50），同时 `logger` 记录。
- `bootId` 在服务构造时生成（`randomUUID()`）。

### 8.2 `ChannelOnboardingService`（`packages/server/src/application/channel/channel-onboarding-service.ts`）

```ts
export interface ChannelOnboardingServiceOptions {
  config: ChannelConfigStore;
  onConfigChanged(connector: string): Promise<void> | void;   // 通知运行时 applyFeishuConfig
  createRegistration?(onCredentials): RegistrationLike;       // 默认 new FeishuRegistration({ onCredentials })
  verify?(input): Promise<VerifiedFeishuBot>;                 // 默认 verifyFeishuCredentials
  now?(): number;
}
```

- `snapshot()` → `FeishuChannelSnapshot`（无密钥；`botName` 由运行时读取器提供）。
- `connectManual({appId, appSecret, domain})`：
  - `domain` 缺省归一为 `"feishu"` 后再 `verify`（`verifyFeishuCredentials` 的 `domain` 是必填）；
  - **校验失败不写文件**；
  - 写入时 `enabled=true`；**appId 变化（含首次配置）时清空 `allowFrom`**（旧 open_id 属于旧应用），同 appId 才保留既有白名单；写后 `onConfigChanged("feishu")`。
- `patch({enabled?, sendProgress?, sendToolHints?})`：`updateFeishu` 局部合并 → `onConfigChanged`；无配置 → 409。
- `remove()`：`deleteFeishu()` → `onConfigChanged`（停止）。
- `allowAdd({id, name})` / `allowRemove(key)`：`updateFeishu` 增删（key = `name ?? id`；`name` 为空白串按缺省；同名 key 覆盖既有条目）；`id` 前缀校验；**不重启连接**（原地生效）。
- 注册：单实例 `RegistrationLike`（`start/status/cancel`）。
  - `startRegistration({domain})`：active 时 **supersede**（与核心类一致），返回带新 `attempt` 的快照；多个客户端共享同一注册，后发起者生效；`cancel` 是全局的（幂等，返回 `idle`）。
  - `onCredentials` 边界（关键）：
    1. 写配置（`enabled=true`；扫码路径是 `createOnly` 新应用，appId 必然变化 → **清空 `allowFrom`** 后只加入扫码者 `open_id`；不得把旧应用的 open_id 带过来）；
    2. 若 `user_info.open_id` 缺失 → 文件仍写入，但 `warning="未获取到扫码者 open_id，白名单为空，所有消息都会被拒绝"`；
    3. **写配置成功即注册成功**（`succeeded`）；`onConfigChanged`/运行时启动失败**不改变注册状态**，只体现在 `runtime.state=error + lastError`；UI 文案“已接入，但连接失败：<lastError>”；
    4. 扫码路径**不做前置 verify**（`registerApp` 返回的凭据已证明有效），botName 由运行时连接时 best-effort 获取；手动路径仍必须先 verify。
  - daemon 重启丢失注册态：`status()` 返回 `idle`；客户端把“active → idle”解释为 `registration_lost`，清二维码并提示重新开始。

### 8.3 装配与生命周期接线

- `DaemonApplicationOptions` 新增可选 `channelConfigStore?`。**未提供时不构造渠道服务**（`channelRuntime`/`channelOnboarding` 为 `undefined`，路由返回 503）——这样现有 server 测试不会去读真实用户配置，也不存在隐藏 fallback。生产入口 `createDefaultNodeApplication` 默认注入 `new ChannelConfigStore()`。
- `DaemonApplication` 在提供了 store 时构造 `channelRuntime` 与 `channelOnboarding`，暴露到 `DurableAgentApplication`（新字段 `channelRuntime?`、`channelOnboarding?`）。
- `packages/server/src/application/channel/index.ts` 增加新服务导出（`application/index.ts` 是 barrel）。
- `ready()` 完成 startup recovery 后 `void this.channelRuntime.startEnabled()`（后台、不阻塞、不 reject）。
- `closeWork()`：`await this.channelRuntime.shutdown()` 放在 `schedules.shutdown()` 之后、`control.shutdown()` **之前**；随后才释放 owner / 关 store。
- `packages/server/package.json` 新增 `@openharness/channels` 依赖（动态 import）。

## 9. CLI 委托

`apps/cli/src/commands/channels.ts`：

- 删除 `assembleChannelAdapters`、`AssembledChannels` 与本地 bus/manager/bridge。
- `serve`：`ensureLocalDaemon()` → `client.channels.startRuntime()` → 每秒 `runtimeStatus()`，按 `bootId` + `seq` 高水位打印状态变化与新增拒绝（**首次成功轮询只建基线、不打印历史拒绝；`bootId` 变化重新基线**）→ SIGINT 调有界 `stopRuntime()`（HTTP 超时/失败也退出并打印），第二次 Ctrl+C 立即退出。退出时打印“已停止（临时）；重启 daemon 后 enabled 渠道会自动恢复”。
- `status`：daemon 不可用时明确打印“daemon 未运行，无法读取渠道配置”，不输出错误栈；可用时 `getFeishu()` + `runtimeStatus()`（在线/连接中/已停止/错误、appId、botName、白名单）+ 原 durable 最近投递。

`apps/cli/src/commands/channels-onboarding.ts`：

- `add feishu`：扫码 → `startFeishuRegistration` + 轮询（按 `attempt` 丢弃过期二维码）+ 终端二维码渲染；成功/警告/错误文案来自 daemon。手填 → `connectFeishu`。
- `allow`：`addFeishuAllow`。
- 保留终端交互与二维码渲染；删除本地写 store 与本地 verify 编排。
- `@openharness/auth` 仍被 CLI 其他命令使用（`doctor.ts`、`commands/auth.ts`、`commands/mcp.ts`、`commands/provider.ts`、`commands/setup.ts`），**保留依赖**。

## 10. Desktop「连接」板块

### 10.1 主进程

- `apps/desktop/package.json` 新增 `qrcode`（`@types/qrcode` 进 devDependencies）。Desktop 不新增 `@openharness/*` 依赖（边界脚本限制）。
- `shared/channel-types.ts`：Desktop DTO（复用 protocol 类型；注册快照补 `qrDataUrl?: string`）。
- `shared/ipc-channels.ts` 新增 `IpcChannels` 与 `IpcInvokeMap`：

```
connectionsSnapshot / connectionsRuntimeStatus
connectionsFeishuConnect / connectionsFeishuPatch / connectionsFeishuRemove
connectionsFeishuAllowAdd / connectionsFeishuAllowRemove
connectionsFeishuRegistrationStart / ...Status / ...Cancel
connectionsRuntimeStart / connectionsRuntimeStop
```

- `shared/desktop-api-contract.ts` 新增 `connections` 命名空间；`preload/desktop-api.ts` 同步。`preload/index.d.ts` 只挂 `DesktopAPI` 到 `Window`，**无需修改**。
- `main/features/channels/channel-service.ts`：注入 `getClient: () => desktopSessionService.daemonClient()` 与 `generateQrDataUrl`（默认 `qrcode.toDataURL`）；DTO 类型从 `@openharness/client` 复用。
  - `snapshot()` = `getFeishu()` + `runtimeStatus()` 合成；注册状态出现 `qrUrl` 时在**主进程**生成 data URL 再返回；QR `attempt` 变化时丢弃旧 data URL。
  - `runtimeStatus()` 返回 `{ runtime, newDenials }`：main 持有 per-connector `seq` 高水位与 `bootId`；首次成功调用只建基线（`newDenials=[]`）；`bootId` 变化重新基线；之后只返回 `seq` 大于高水位的 denial。main 是长驻进程，高水位跨渲染层挂载保持，页面重挂载不会重放旧拒绝。
  - 渲染层负责定时轮询（见 §10.2）；main 不订阅、不持有定时器，因此 IPC 列表不需要额外的订阅/取消通道。
  - `appSecret` 只作为 `connectFeishu` 入参转发，不写日志、不落返回值、不做任何持久化。
- `main/features/channels/ipc.ts`：`IpcContribution`；注册进 `main/features/index.ts`。

### 10.2 渲染层

- 新增 `apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.tsx`，在 `settings-content.tsx` 为“连接”补描述与分支（导航已存在，无需改 `settings-navigation.ts`）。
- 页面内容：
  - 状态卡：徽章（在线/连接中/停止中/已停止（临时）/已停用（持久）/失败），失败显示 `lastError`；appId、domain、botName；操作区提供“重试连接”（`runtimeStart`）与“移除接入”（`feishuRemove`，带确认对话框）。
  - 主开关：启用/停用（持久化 `enabled`）。
  - 接入：扫码（按 `attempt` 显示二维码图片 + 授权链接 + 取消）或手填（App ID / App Secret / 地区；提交后立即清空表单明文，不写 localStorage）。
  - 白名单：列表增删（`ou_`/`oc_` + 备注名）；空列表提示“已配置但不放行任何人”；增删后无需重启即生效。
  - 行为开关：`sendProgress` / `sendToolHints`（走 `patch`）；`replyAtBotNames` 只读展示。
  - 被拒提示：渲染层每 3s 串行轮询 `connectionsRuntimeStatus`（in-flight 时跳过本轮），只展示 main 返回的增量 `newDenials`；展示 sender/chatId 与“加入白名单”动作（denial 只在内存展示，不持久化）。请求失败保留上次快照并指数退避（3s→30s），组件卸载停止轮询。
- 加载/错误态沿用现有组件与 `settings-error-message`。

## 11. 安全与硬约束

- 密钥只落 `channel-credentials.json`；所有 HTTP 响应、IPC、日志、错误消息都不回显 `appSecret`。
- **请求侧不变量**：`appSecret` 只允许出现在 `connectFeishu` 的 JSON body；不得出现在 query/path；HTTP 中间件（现有日志只记 method/path/status）、client transport、main `channel-service`、renderer 均不得记录或持久化请求体；测试用 spy logger 断言整个 connect 流程日志不含 secret。
- **QR 不变量**：`qrUrl` 与生成的 data URL 只允许通过注册接口响应与 Desktop IPC 快照传给发起注册的客户端；不写日志、不进错误消息、不落盘；`attempt` 变化或注册终止立即从内存与 IPC 快照清除；`qrcode` 生成失败返回通用错误，错误里不带 URL。
- 白名单空 = 全拒（fail-closed），UI/CLI 必须显式提示。
- 缺字段/非法 domain/非法 id 直接拒绝，不猜测、不降级、不引入 fallback。
- 旧 `settings.channels`、旧 v1 凭据文件行为不变（分别为 `SettingsFileError`、视为未配置）。
- 不改 `@openharness/protocol` durable 类型；`DurableChannelBridge` 只做 `cwd`/`stop` 扩展，`ChannelManager` 只新增 `stopInbound`。
- 渠道运行时不修改其他 Session/Run；启停只影响渠道连接。
- 写路由要求 bearer token；无 token 实例对渠道写路由返回 503（见 §7.2）。
- 信任模型：daemon 监听 loopback + bearer；denial 里的 sender/chatId 仅用于展示与加白名单，renderer 不持久化。

## 12. 测试计划

| 范围 | 用例 |
|---|---|
| `packages/protocol` | 新 parser：必填/可选/未知键/非法 domain/非法 id；DTO 无 `appSecret` 字段；`seq` 单调 |
| `packages/channels` | `DurableChannelBridge`：字符串与函数 cwd（异步）；`stop({drainTimeoutMs})` 超时不阻塞；`ChannelManager.stopInbound()` 后仍能发出已入队出站，`stopAll()` 幂等；原有 bridge/thread/manager 回归 |
| `packages/core` | `getChannelWorkspaceRoot()` 默认值与 env 覆盖 |
| `packages/server` | 并发：start 挂起（deferred connect）时 stop → 最终无 running/无连接/无泄漏；两次 restart 只存在一条连接、旧 bus/bridge 不残留；`enabled=true` 与 `stop` 并发按 lane 顺序收敛；`startEnabled` 进行中 `enabled=false` → 永不 running；shutdown 后再 start → 409；drain 超时路径 |
| `packages/server` | 配置：缺 model/凭据进 error；ACL/策略原地生效（拒绝 → allowAdd → 同一 sender 放行，不重启；allowRemove 立即恢复拒绝）；连接指纹变化才重启；`botName` 缓存键控与失效 |
| `packages/server` | cwd：不同会话键（含 threadId）落不同目录；碰撞用例（相似 chatId）；EACCES/ENOSPC；目录被删后自愈；win32 非法名/尾点 |
| `packages/server` | 注册：`onConfigChanged` 抛错时注册仍 `succeeded` 且配置只写一次；扫码缺 `open_id` → `warning`；扫码路径清空旧 app 的 `allowFrom`；并发两次 start → attempt 递增；新实例模拟 daemon 重启 → `idle`；cancel 幂等 |
| `packages/server` | 白名单：手填换 appId 清空、同 appId 保留；空 `name` 按 id 作为 key；同名覆盖；key 含 `/` 经 `encodeURIComponent` 可增删 |
| `packages/server` | 路由：状态/启停/配置/注册的 200/400/404/409/503；connect 的 4xx/5xx 与日志不含 secret；无 token 实例写路由 503 |
| `packages/client` | 新资源方法与路径/方法/返回映射；`client-public-api-contract.json` 更新 |
| `apps/cli` | `serve` 委托（start + 跟随 + SIGINT 有界 stop + 二次强退）；`status` 在 daemon 不可用时的提示；`add/allow` 调对应 API；`@openharness/auth` 依赖保留且其他命令不受影响 |
| `apps/desktop` | `channel-service`：QR data URL 生成与 attempt 失效、secret 不外泄、snapshot 合成、`runtimeStatus` 基线/高水位/`bootId` 重基线/只返回增量；ipc 单测 |
| `apps/desktop` | 渲染层轮询：串行（in-flight 跳过）、失败退避并保留上次快照、卸载停止；重试连接与移除接入的确认流程 |
| `apps/desktop` | `connections-settings` 组件：状态渲染（含临时停止 vs 持久停用）、启停、白名单增删、`patch` 开关、denial 提示与“加入白名单”、扫码流程、错误态 |
| 回归（可判定） | **启停不影响已有会话**：先建会话 A 并记录 run 状态/消息数/事件 seq/agent 是否在池；调用 runtime start/stop/restart；断言 A 的 run 状态、消息数、事件 seq 不变，A 的 agent 未被关闭，未触发 `interruptActiveRuns`/`closeExecutionRuntimes`/`stopAndDrain`；渠道消息落在独立 Session（分类键不同） |
| 构建边界 | 不 import 渠道时启动路径不加载 lark SDK；如决定外置，断言 `out/main` 中 SDK 不在 bundle（见 §14） |

## 13. 验收标准

- Desktop“连接”板块可用：扫码或手填 → 校验 → 写配置 → 显示真实在线状态；可启停；可加人/加群；被拒有提示；密钥不回显。
- 扫码成功后 `snapshot.allowFrom` 含扫码者 `open_id`（拿不到时显示 `warning` 且不宣称白名单已生效）。
- 白名单增删**无需重启**立即生效（自动化用例 + 人工验证）。
- `enabled=false` 持久化后，重启 daemon 该渠道不自动连接；`enabled=true` 重启后自动恢复。
- `ohs channels add/allow/status/serve` 全部委托 daemon 且行为可用；同一 appId 不会出现两条长连接。
- `channel-credentials.json` 仅由 daemon 写入；Desktop/CLI 不直接写。
- 启停渠道不影响其他 Session（§12 回归用例通过）。
- 命令全部通过：

```bash
pnpm --filter @openharness/protocol test -- --run
pnpm --filter @openharness/channels test -- --run
pnpm --filter @openharness/auth test -- --run
pnpm --filter @openharness/core test -- --run
pnpm --filter @openharness/client test -- --run
pnpm --filter @openharness/server test -- --run
pnpm --filter @openharness/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
pnpm --filter @openharness/desktop test
pnpm --filter @openharness/desktop typecheck
pnpm exec turbo build --output-logs=full
pnpm check-docs
git diff --check
```

- 人工端到端：Desktop 接入 → 在线 → 发消息收到回复 → 加白名单/被拒提示 → 停用后飞书不再响应 → 重新启用恢复 → 重启 daemon 后 enabled 渠道自动恢复。

## 14. 风险

| 风险 | 缓解 |
|---|---|
| 旧 `serve` 未同步改委托，出现双连接 | Stage 1 与 CLI 委托同批交付；`serve` 委托后由 daemon 单点持有；lane/generation 保证进程内唯一 |
| Desktop 打包仍可能包含 lark SDK（动态 import 只是懒加载 chunk） | 先测量：构建后检查 `out/main` chunk；若体积不可接受，把 `@larksuiteoapi/node-sdk` 加入 `apps/desktop/package.json` dependencies 与 `electron.vite.config.ts` 的 `externalizeDeps.include`（边界脚本只限制 `@openharness/*`，允许第三方包）并随包分发。spec 明确“不打包”不是本设计的承诺 |
| daemon 停机中断在途 Run / 回复可能未发出 | 有界 drain + durable pending；文档明说该语义；`recoverPending` 在下次 start 恢复 |
| 注册中途 daemon 重启丢注册态 | `status()=idle`；客户端识别 `registration_lost` 并提示重开；注册是短流程 |
| cwd 路径碰撞或非法字符 | hash 后缀 + win32 归一 + 保留名前缀；每会话键稳定映射；专项测试 |
| 看门狗缺失：首次连接失败不会自动重试 | 状态显式 `error + lastError`；Desktop/CLI 提供手动重试；不伪装在线 |
| 轮询延迟导致拒绝提示不及时 | 约 3s 轮询 + `seq` 高水位，不重放旧提示；SSE 留后续 |
| external daemon 场景下配置仍在同机文件 | daemon 与 Desktop 同机；若未来远程 daemon，另行设计凭据传递 |
| 无 token 的 daemon 被本机任意进程改白名单/写配置 | 渠道写路由无 token 时 503（§7.2） |
| `FeishuPush` 工具也直接读 `channel-credentials.json`（daemon 进程内，合法读者） | 维持只读；远程 daemon 场景需另行设计，已在非目标/风险记录 |

## 15. 逐文件改动

| 文件 | 动作 |
|---|---|
| `docs/superpowers/specs/2026-09-19-desktop-channel-onboarding-design.md` | 新建（本文件） |
| `packages/protocol/src/channel-runtime.ts` + `packages/protocol/src/channel-runtime.test.ts` | 新建 |
| `packages/protocol/src/index.ts` | 导出新类型与 parser |
| `packages/channels/src/core/durable-bridge.ts` + `packages/channels/src/__test__/durable-bridge.test.ts` | `cwd` 支持函数；`stop({drainTimeoutMs})` |
| `packages/channels/src/core/manager.ts` + `packages/channels/src/__test__/manager.test.ts` | 新增 `stopInbound()` |
| `packages/core/src/config/paths.ts` + `packages/core/src/config/paths.test.ts`、`packages/core/src/index.ts` | 新增 `getChannelWorkspaceRoot` |
| `packages/server/src/daemon/channel-runtime-service.ts` + `packages/server/src/daemon/channel-runtime-service.test.ts` | 新建 |
| `packages/server/src/application/channel/channel-onboarding-service.ts` + `packages/server/src/application/channel/__test__/channel-onboarding-service.test.ts` | 新建 |
| `packages/server/src/application/channel/index.ts` | 导出新服务 |
| `packages/server/src/http/routes/channel-control.ts` + 测试 | 新建 |
| `packages/server/src/http/server.ts` | 挂载新路由并传入 runtime/onboarding |
| `packages/server/src/application/daemon-application.ts` | 装配、自动启动、停机顺序、接口暴露 |
| `packages/server/package.json` | 新增 `@openharness/channels` 依赖 |
| `packages/client/src/resources/channel-resource.ts` + 测试 | 新增方法 |
| `scripts/client-public-api-contract.json` | 新增 DTO 类型与资源方法（无条件同步） |
| `tests/client-public-api/consumer.ts`、`packages/client/src/__test__/public-api.test.ts` | 同步 |
| `apps/cli/src/commands/channels.ts` + `apps/cli/src/commands/channels.test.ts` | 改为委托，删本地装配 |
| `apps/cli/src/commands/channels-onboarding.ts` + `apps/cli/src/commands/channels-onboarding.test.ts` | 改为委托 |
| `apps/desktop/package.json` | 新增 `qrcode`（+ `@types/qrcode`） |
| `apps/desktop/src/shared/channel-types.ts` | 新建 |
| `apps/desktop/src/shared/ipc-channels.ts` | 新增 channels IPC |
| `apps/desktop/src/shared/desktop-api-contract.ts` | 新增 `connections` |
| `apps/desktop/src/preload/desktop-api.ts` | 同步（`preload/index.d.ts` 无需改） |
| `apps/desktop/src/main/features/channels/channel-service.ts` + 测试 | 新建 |
| `apps/desktop/src/main/features/channels/ipc.ts` + 测试 | 新建 |
| `apps/desktop/src/main/features/index.ts` | 注册 |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.tsx` + 测试 | 新建 |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx` | “连接”分支与描述 |
| `apps/desktop/electron.vite.config.ts` | 视 §14 决定是否外置 lark SDK |
| `docs/channels-flow.md` | 运行时归属改为 daemon；命令说明更新（用完整路径） |
| `docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md` | 更新状态与已被取代的决策 |

## 16. 自检

- 是否明确长连接归属与进程内唯一性？是：daemon 单点 + per-connector lane/generation（§5.2/§8.1）。
- 是否定义停机与在途消息语义？是：两阶段停止 + 有界 drain + control 顺序（§5.2/§8.3）。
- 是否回应六个现状短板？是，§1 对应 §2 目标与 §13 验收。
- 是否复用既有核心而非重写？是，仅在 bridge 加 `cwd`/`stop` 扩展、manager 加 `stopInbound`。
- 是否守住硬约束（密钥、fail-closed、无 fallback、durable 类型不变）？是，§11。
- 是否有可执行、可判定的测试与验收？是，§12/§13（含“不影响其他 Session”的具体断言）。
- 是否声明取代交接文档的决策与准确的能力边界？是，§3/§4/§14。
- 是否有未决问题？无阻塞项；“打包体积”是否外置 lark SDK 留待实现时按 §14 测量决定。
