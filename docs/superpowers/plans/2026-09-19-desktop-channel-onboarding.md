# Desktop 渠道接入（连接板块）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
> 设计与契约以 `docs/superpowers/specs/2026-09-19-desktop-channel-onboarding-design.md` 为准；本计划只拆任务与顺序，不重复全部理由。

**目标：** 把飞书长连接运行时与渠道配置/接入从 CLI `serve` 进程搬进 daemon；Desktop 新增“连接”板块（接入、状态、白名单、启停、被拒提示）；CLI 改为委托。

**架构：** daemon 内新增 `ChannelRuntimeService`（per-connector lane/generation，持有 bus/manager/bridge）与 `ChannelOnboardingService`（`ChannelConfigStore` 唯一写入者、扫码状态机、白名单）；HTTP `/channels/runtime/*`、`/channels/feishu/*` 暴露；client 扩展 `ChannelResource`；Desktop 主进程经 `desktopSessionService.daemonClient()` 调用并用 `qrcode` 生成二维码图片。

**技术栈：** TypeScript、Vitest、pnpm workspace、Hono、Electron/React、`@larksuiteoapi/node-sdk`（动态 import）、`qrcode`。

## Global Constraints

- 密钥只落默认 `~/.vykor/channel-credentials.json`（`VYKOR_CONFIG_DIR` 可覆盖）；任何响应、IPC、日志、错误消息不回显 `appSecret`。
- `appSecret` 只允许出现在 `connectFeishu` 的 JSON body；不得出现在 query/path/日志/持久化。
- `qrUrl`/data URL 只允许通过注册接口响应与 Desktop IPC 快照传给发起注册的客户端；不写日志、不进错误消息、不落盘；`attempt` 变化即清除。
- 白名单空 = 全拒（fail-closed）；缺字段/非法值直接拒绝，不猜测、不降级、不引入 fallback。
- 不改 `@vykor/protocol` durable 类型；只新增 `channel-runtime.ts`。
- `@vykor/channels` 在 server 内动态 import；Desktop 不新增 `@vykor/*` 依赖（边界脚本只允许 client/server）。
- `@vykor/auth` 保留在 CLI（其他命令仍用）。
- 每个任务一个 commit；严格 TDD（先红后绿）。
- 只改本计划列出的文件。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/protocol/src/channel-runtime.ts` | 渠道运行时 DTO 与 parser | 新建 |
| `packages/protocol/src/index.ts` | 导出新模块 | 修改 |
| `packages/channels/src/core/durable-bridge.ts` | `cwd` 解析函数、`stop({drainTimeoutMs})` | 修改 |
| `packages/channels/src/core/manager.ts` | `stopInbound()` | 修改 |
| `packages/core/src/config/paths.ts` | `getChannelWorkspaceRoot()` | 修改 |
| `packages/core/src/index.ts` | 导出新函数 | 修改 |
| `packages/server/src/daemon/channel-runtime-service.ts` | 运行时状态机与连接持有 | 新建 |
| `packages/server/src/application/channel/channel-onboarding-service.ts` | 配置/接入/白名单 | 新建 |
| `packages/server/src/application/channel/index.ts` | barrel 导出 | 修改 |
| `packages/server/src/http/routes/channel-control.ts` | `/channels/runtime/*`、`/channels/feishu/*` | 新建 |
| `packages/server/src/http/server.ts` | 挂载新路由 | 修改 |
| `packages/server/src/application/daemon-application.ts` | 装配、自动启动、停机顺序、接口暴露 | 修改 |
| `packages/server/src/application/default-node-application.ts` | 默认注入 `ChannelConfigStore` | 修改 |
| `packages/server/package.json` | 新增 `@vykor/channels` | 修改 |
| `packages/client/src/resources/channel-resource.ts` | 新方法 | 修改 |
| `packages/client/src/index.ts` | 导出新 DTO 类型 | 修改 |
| `scripts/client-public-api-contract.json` | 导出清单 | 修改 |
| `tests/client-public-api/consumer.ts` | 代表性调用 | 修改 |
| `apps/cli/src/commands/channels.ts` | serve/status 委托 | 修改 |
| `apps/cli/src/commands/channels-onboarding.ts` | add/allow 委托 | 修改 |
| `apps/desktop/package.json` | `qrcode` 依赖 | 修改 |
| `apps/desktop/src/shared/channel-types.ts` | Desktop DTO | 新建 |
| `apps/desktop/src/shared/ipc-channels.ts` | channels IPC | 修改 |
| `apps/desktop/src/shared/desktop-api-contract.ts` | `connections` 命名空间 | 修改 |
| `apps/desktop/src/preload/desktop-api.ts` | 暴露 connections | 修改 |
| `apps/desktop/src/main/features/channels/channel-service.ts` | daemon 调用 + QR + 高水位 | 新建 |
| `apps/desktop/src/main/features/channels/ipc.ts` | IPC 注册 | 新建 |
| `apps/desktop/src/main/features/index.ts` | 注册贡献 | 修改 |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.tsx` | 页面 | 新建 |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx` | “连接”分支 | 修改 |
| `docs/channels-flow.md`、交接文档 | 文档同步 | 修改 |

---

## 任务 1：protocol 渠道运行时 DTO 与 parser

**文件：**
- 新建：`packages/protocol/src/channel-runtime.ts`
- 测试：`packages/protocol/src/channel-runtime.test.ts`（新建）
- 修改：`packages/protocol/src/index.ts`

**Interfaces：**
- Produces：`ChannelRuntimeState`、`ChannelConnectorRuntimeStatus`、`ChannelDenialNotice`、`ChannelRuntimeStatus`、`FeishuChannelSnapshot`、`FeishuRegistrationSnapshot`、`parseChannelRuntimeControlInput`、`parseFeishuConnectInput`、`parseFeishuAllowInput`、`parseFeishuPatchInput`、`parseFeishuRegistrationStartInput`。

- [x] **步骤 1：编写失败的测试**

覆盖：合法/缺字段/未知键/非法 domain/非法 id（非 `ou_`/`oc_`）/空 `name`；`parseFeishuPatchInput` 至少一个已知键；注册 parser 可选 domain。示例：

```ts
it("parses connect input and defaults nothing", () => {
  expect(parseFeishuConnectInput({ appId: "cli_x", appSecret: "s" })).toEqual({
    appId: "cli_x",
    appSecret: "s",
  });
  expect(() => parseFeishuConnectInput({ appId: "cli_x" })).toThrow(/appSecret/);
  expect(() => parseFeishuConnectInput({ appId: "a", appSecret: "s", domain: "x" })).toThrow(/domain/);
});
it("rejects unknown patch keys and empty patch", () => {
  expect(() => parseFeishuPatchInput({})).toThrow();
  expect(() => parseFeishuPatchInput({ appSecret: "s" })).toThrow();
  expect(parseFeishuPatchInput({ enabled: false })).toEqual({ enabled: false });
});
it("rejects allow ids outside ou_/oc_", () => {
  expect(() => parseFeishuAllowInput({ id: "*" })).toThrow();
  expect(parseFeishuAllowInput({ id: "ou_1", name: "  " })).toEqual({ id: "ou_1" });
});
```

- [x] **步骤 2：运行确认失败**

`pnpm --filter @vykor/protocol test -- --run src/channel-runtime.test.ts`

- [x] **步骤 3：实现**

按 spec §7.1 定义类型（含 `bootId`、`seq`、`attempt`、`domain`、`warning`；`FeishuChannelSnapshot` 不含 `appSecret`），parser 沿用 `packages/protocol/src/channel.ts` 的 `record/required/optional` 风格；`parseFeishuAllowInput` 校验 `ou_`/`oc_` 前缀并把空白 `name` 视为缺省。`packages/protocol/src/index.ts` 增加 `export * from "./channel-runtime.js";`。

- [x] **步骤 4：运行确认通过 + Commit**

```bash
pnpm --filter @vykor/protocol test -- --run
git add packages/protocol/src/channel-runtime.ts packages/protocol/src/channel-runtime.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add channel runtime DTOs and parsers"
```

---

## 任务 2：channels 核心扩展（cwd 解析、有界 stop、stopInbound）

**文件：**
- 修改：`packages/channels/src/core/durable-bridge.ts`、`packages/channels/src/core/manager.ts`
- 测试：`packages/channels/src/__test__/durable-bridge.test.ts`、`packages/channels/src/__test__/manager.test.ts`

**Interfaces：**
- Produces：
  - `DurableChannelBridge` deps `cwd: string | ((message: InboundMessage) => string | Promise<string>)`
  - `DurableChannelBridge.stop(options?: { drainTimeoutMs?: number }): Promise<void>`
  - `ChannelManager.stopInbound(): Promise<void>`

- [x] **步骤 1：编写失败的测试**

```ts
it("resolves cwd per message, including async", async () => {
  const seen: string[] = [];
  const bridge = new DurableChannelBridge({
    application: fakeApp(seen),
    bus,
    cwd: async (msg) => `D:/channels/${msg.chatId}`,
    model: "m",
  });
  bridge.start();
  bus.publishInbound(inbound({ chatId: "chat-1" }));
  await vi.waitFor(() => expect(seen).toEqual(["D:/channels/chat-1"]));
  await bridge.stop();
});

it("stop returns within the drain bound when a handler never settles", async () => {
  const bridge = new DurableChannelBridge({ application: neverSettlingApp(), bus, cwd: ".", model: "m" });
  bridge.start();
  bus.publishInbound(inbound());
  const started = Date.now();
  await bridge.stop({ drainTimeoutMs: 20 });
  expect(Date.now() - started).toBeLessThan(500);
});

it("stopInbound disconnects adapters but still dispatches queued outbound", async () => {
  // manager.startAll → publishOutbound → stopInbound → 再 publishOutbound → 两个都被 send
});
```

- [x] **步骤 2：运行确认失败**

`pnpm --filter @vykor/channels test -- --run src/__test__/durable-bridge.test.ts src/__test__/manager.test.ts`

- [x] **步骤 3：实现**

- `durable-bridge.ts`：`handle()` 里 `const cwd = typeof this.deps.cwd === "function" ? await this.deps.cwd(message) : this.deps.cwd;`；`stop(options)` 先 `abort`，再用 `Promise.race([this.done, timeout])` 有界等待（超时后不阻塞；`done` 仍会在后台自行收尾）。
- `manager.ts`：抽出 `stopInbound()`（只 `adapter.disconnect()`，不动 outbound dispatch loop）；`stopAll()` 改为 `abort` dispatch + `stopInbound()`，保持幂等。
- 更新所有既有调用方/测试的 `stop()`（不传参保持原语义）。

- [x] **步骤 4：运行确认通过 + Commit**

```bash
pnpm --filter @vykor/channels test -- --run
git add packages/channels/src/core/durable-bridge.ts packages/channels/src/core/manager.ts packages/channels/src/__test__/durable-bridge.test.ts packages/channels/src/__test__/manager.test.ts
git commit -m "feat(channels): add per-message cwd, bounded stop and stopInbound"
```

---

## 任务 3：`getChannelWorkspaceRoot`

**文件：**
- 修改：`packages/core/src/config/paths.ts`、`packages/core/src/index.ts`
- 测试：`packages/core/src/config/paths.test.ts`

- [x] **步骤 1：编写失败的测试**：默认 `join(getConfigDir(), "channels")`；`VYKOR_CHANNELS_DIR` 覆盖（测试内设置/还原 env）。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/core test -- --run src/config/paths.test.ts`
- [x] **步骤 3：实现**：新增并导出函数（spec §6.2）。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/core test -- --run
git add packages/core/src/config/paths.ts packages/core/src/config/paths.test.ts packages/core/src/index.ts
git commit -m "feat(core): add channel workspace root path"
```

---

## 任务 4：`ChannelRuntimeService`

**文件：**
- 新建：`packages/server/src/daemon/channel-runtime-service.ts`
- 测试：`packages/server/src/daemon/channel-runtime-service.test.ts`（新建）

**Interfaces：**
- Consumes：任务 2 的 bridge/manager 能力、任务 3 的 workspace root、任务 1 的 DTO。
- Produces：

```ts
export interface ChannelRuntimeApplicationPort {
  handleMessage(input: DurableChannelMessageInput): Promise<DurableChannelMessageResult>;
  pendingDeliveries(options?: { connector?: string; limit?: number }): Promise<ChannelDeliveryRecord[]>;
  recordDelivery(id: string, input: RecordChannelDeliveryInput): Promise<ChannelDeliveryRecord>;
}
export interface ConnectorRuntimeHandle {
  start(): Promise<void>;
  stopInbound(): Promise<void>;
  stopBridge(options?: { drainTimeoutMs?: number }): Promise<void>;
  stop(): Promise<void>;
}
export interface ChannelRuntimeServiceOptions {
  application: ChannelRuntimeApplicationPort;
  config: { getFeishu(): Promise<FeishuChannelConfig | undefined> };
  getSettings(): Settings | undefined;
  createRuntime(input: {
    connector: string;
    config: FeishuChannelConfig;
    application: ChannelRuntimeApplicationPort;
    acl: { allowFrom: string[] };                    // manager 持有同一引用
    policy: { sendProgress?: boolean; sendToolHints?: boolean };
    resolveCwd(message: InboundMessage): Promise<string>;
    onDenied(info: { channel: string; sender: string; chatId: string }): void;
    onDeliveryResult(result: { deliveryId: string; status: "sent" | "failed" | "unknown"; error?: string }): Promise<void> | void;
  }): Promise<ConnectorRuntimeHandle>;
  verify?(input: { appId: string; appSecret: string; domain: "feishu" | "lark" }): Promise<{ name?: string }>;
  workspaceRoot?: string;
  drainTimeoutMs?: number;
  logger?(event: ObservabilityEvent): void;
  now?(): number;
}
export class ChannelRuntimeService {
  constructor(options: ChannelRuntimeServiceOptions);
  startEnabled(): Promise<void>;
  start(connector?: string): Promise<void>;
  stop(connector?: string): Promise<void>;
  restart(connector?: string): Promise<void>;
  applyFeishuConfig(config: FeishuChannelConfig | undefined): Promise<void>;
  status(): ChannelRuntimeStatus;
  hasConnector(name: string): boolean;
  shutdown(): Promise<void>;
}
```

- [x] **步骤 1：编写失败的测试**（用 fake `createRuntime`，不加载 lark SDK）

必测：自动启动 enabled、`enabled=false` 不启动、缺 model/凭据 → `error + lastError`、start 挂起时 stop 收敛、两次 restart 不残留旧 handle、generation 丢弃过期结果、shutdown 后 start 抛 409、ACL 原地生效（`acl.allowFrom` 内容变化后 fake manager 读取到新值）、`applyFeishuConfig` 指纹不变不重启、denial `seq` 单调且有界 50、`bootId` 稳定、cwd 目录按会话键 hash 且可建、目录创建失败写 `lastError`、`botName` 缓存键控。示例：

```ts
it("stops cleanly when start is still hanging", async () => {
  let release!: () => void;
  const handle = fakeHandle({ start: () => new Promise<void>((r) => (release = r)) });
  const service = makeService({ createRuntime: async () => handle });
  const starting = service.start("feishu");
  const stopping = service.stop("feishu");
  release();
  await starting; await stopping;
  expect(service.status().connectors[0]).toMatchObject({ state: "stopped" });
  expect(handle.stopCalls).toBe(1);
});

it("keeps a single runtime across restarts", async () => {
  const handles: FakeHandle[] = [];
  const service = makeService({ createRuntime: async () => { const h = fakeHandle(); handles.push(h); return h; } });
  await service.start("feishu");
  await service.restart("feishu");
  expect(handles).toHaveLength(2);
  expect(handles[0]!.stopCalls).toBe(1);
  expect(service.status().connectors[0]?.state).toBe("running");
});
```

- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/server test -- --run src/daemon/channel-runtime-service.test.ts`
- [x] **步骤 3：实现**（按 spec §8.1）
  - per-connector lane（promise chain）+ `generation`；`closed` 标志；`startEnabled` 逐 connector 捕获、入 lane 前同步置 `starting`。
  - `applyFeishuConfig` 固定优先级：指纹变化 → 重启；指纹不变 → 原地更新 `acl.allowFrom`（splice）与 `policy` 字段。
  - cwd 解析：`sanitize` + `sha1(connector|accountId|chatId|threadId)` 后缀 + `mkdir recursive`；失败写 `lastError` 并跳过该消息（由 resolveCwd 抛错 → bridge 走 onWarning；runtime 在 resolveCwd 内 catch 并记 `lastError` 后重抛）。
  - 默认 `createRuntime`：动态 `import("@vykor/channels")`，组装 `FeishuAdapter` + `MessageBus` + `ChannelManager`（`allowFrom`/`channelPolicies` 传引用）+ `DurableChannelBridge`（`cwd: resolveCwd`）；`onDeliveryResult` 直连 application。
  - `verify` 默认动态 import `verifyFeishuCredentials`，best-effort 取 `botName`，按 `(appId, domain)` 缓存。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/server test -- --run src/daemon/channel-runtime-service.test.ts
git add packages/server/src/daemon/channel-runtime-service.ts packages/server/src/daemon/channel-runtime-service.test.ts
git commit -m "feat(server): add daemon channel runtime service"
```

---

## 任务 5：`ChannelOnboardingService`

**文件：**
- 新建：`packages/server/src/application/channel/channel-onboarding-service.ts`
- 测试：`packages/server/src/application/channel/__test__/channel-onboarding-service.test.ts`（新建）

**Interfaces：**
- Produces：

```ts
export interface ChannelOnboardingServiceOptions {
  config: ChannelConfigStore;
  onConfigChanged(connector: string): Promise<void> | void;
  createRegistration?(onCredentials: (c: FeishuRegistrationCredentials) => Promise<void>): RegistrationLike;
  verify?(input: { appId: string; appSecret: string; domain: "feishu" | "lark" }): Promise<VerifiedFeishuBot>;
  readBotName?(): string | undefined;     // 来自 runtime 的缓存读取器
  now?(): number;
}
export class ChannelOnboardingService {
  snapshot(): Promise<FeishuChannelSnapshot>;
  connectManual(input: { appId: string; appSecret: string; domain?: "feishu" | "lark" }): Promise<FeishuChannelSnapshot>;
  patch(input: { enabled?: boolean; sendProgress?: boolean; sendToolHints?: boolean }): Promise<FeishuChannelSnapshot>;
  remove(): Promise<FeishuChannelSnapshot>;
  allowAdd(input: { id: string; name?: string }): Promise<FeishuChannelSnapshot>;
  allowRemove(key: string): Promise<FeishuChannelSnapshot>;
  startRegistration(input?: { domain?: "feishu" | "lark" }): FeishuRegistrationSnapshot;
  registrationStatus(): FeishuRegistrationSnapshot;
  cancelRegistration(): FeishuRegistrationSnapshot;
}
```

- [x] **步骤 1：编写失败的测试**：手填校验失败不写文件；domain 缺省归一 `feishu`；换 appId 清空 allowFrom、同 appId 保留；`patch` 局部合并；扫码 onCredentials 写配置后 `succeeded`，`onConfigChanged` 抛错仍是 `succeeded` 且文件只写一次；缺 `open_id` → `warning`；扫码路径清空旧 allowFrom；并发 start attempt 递增；`cancel` 幂等；新实例 `status()=idle`；allow 空 name/同名覆盖/含 `/` key。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/server test -- --run src/application/channel/__test__/channel-onboarding-service.test.ts`
- [x] **步骤 3：实现**（按 spec §8.2）
  - 默认 `createRegistration` = `new FeishuRegistration({ onCredentials })`（动态 import）。
  - 扫码路径不做前置 verify；手填必须先 verify。
  - 注册快照 `attempt`/`domain` 来自核心类，附加 `warning`。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/server test -- --run src/application/channel/__test__/channel-onboarding-service.test.ts
git add packages/server/src/application/channel/channel-onboarding-service.ts packages/server/src/application/channel/__test__/channel-onboarding-service.test.ts
git commit -m "feat(server): add channel onboarding service"
```

---

## 任务 6：HTTP 路由与 daemon 装配

**文件：**
- 新建：`packages/server/src/http/routes/channel-control.ts`、`packages/server/src/http/routes/channel-control.test.ts`
- 修改：`packages/server/src/http/server.ts`、`packages/server/src/application/daemon-application.ts`、`packages/server/src/application/default-node-application.ts`、`packages/server/src/application/channel/index.ts`、`packages/server/package.json`

**Interfaces：**
- Consumes：任务 4/5 的服务。
- Produces：`createChannelControlRoutes({ runtime?, onboarding? })`；`DurableAgentApplication.channelRuntime?`、`.channelOnboarding?`。

- [x] **步骤 1：编写失败的测试**
  - 路由：每条路由 200/400/404/409/503；`connect` 的 4xx/5xx 与日志不含 `appSecret`；无 token 实例写路由 503（`runtime`/`onboarding` 为 undefined 时同样 503）。
  - 装配：`DaemonApplication` 在提供 store 时暴露两个服务；`ready()` 触发 `startEnabled`（spy）；`close()` 在 `control.shutdown` 之前调用 `runtime.shutdown`（顺序 spy）。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/server test -- --run src/http/routes/channel-control.test.ts`
- [x] **步骤 3：实现**
  - `channel-control.ts` 按 spec §7.2 表格实现；`server.ts` 追加 `this.app.route("/channels", createChannelControlRoutes({...}))`；写路由校验 `authorization`（server 已有 token 时由中间件统一 401，无 token 实例在此返回 503）。
  - `daemon-application.ts`：`channelConfigStore` 可选；提供时构造两个服务并适配 `application` 端口（`handleMessage`/`pendingDeliveries`/`recordDelivery` → bridge 端口命名），`ready()` 后台 `void startEnabled()`，`closeWork()` 在 `schedules.shutdown()` 后、`control.shutdown()` 前 `await channelRuntime.shutdown()`。
  - `default-node-application.ts` 默认注入 `new ChannelConfigStore()`；`application/channel/index.ts` 导出新服务；`package.json` 加 `@vykor/channels`。
  - 现有 server 测试若因新字段/构造变化失败，注入临时空 store 或断言可选字段，不改产品行为。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/server test -- --run
pnpm --filter @vykor/server check-types
git add packages/server/src/http/routes/channel-control.ts packages/server/src/http/routes/channel-control.test.ts packages/server/src/http/server.ts packages/server/src/application/daemon-application.ts packages/server/src/application/default-node-application.ts packages/server/src/application/channel/index.ts packages/server/package.json
git commit -m "feat(server): expose channel runtime and onboarding over HTTP"
```

---

## 任务 7：client 资源方法

**文件：**
- 修改：`packages/client/src/resources/channel-resource.ts`、`packages/client/src/index.ts`、`scripts/client-public-api-contract.json`、`tests/client-public-api/consumer.ts`、`packages/client/src/__test__/public-api.test.ts`
- 测试：`packages/client/src/resources/channel-resource.test.ts`（若无则新建）

- [x] **步骤 1：编写失败的测试**：每个方法的路径/方法/body/返回解包与 spec §7.3 一致；`removeFeishuAllow` 对 key 做 `encodeURIComponent`。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/client test -- --run src/resources/channel-resource.test.ts`
- [x] **步骤 3：实现**：新增方法；`index.ts` 无条件导出新 DTO 类型；按 public-api 测试报错补 `scripts/client-public-api-contract.json` 条目；`consumer.ts` 增加代表性调用。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/client test -- --run
git add packages/client/src/resources/channel-resource.ts packages/client/src/resources/channel-resource.test.ts packages/client/src/index.ts scripts/client-public-api-contract.json tests/client-public-api/consumer.ts packages/client/src/__test__/public-api.test.ts
git commit -m "feat(client): add channel runtime and onboarding methods"
```

---

## 任务 8：CLI 改为委托

**文件：**
- 修改：`apps/cli/src/commands/channels.ts`、`apps/cli/src/commands/channels-onboarding.ts`
- 测试：`apps/cli/src/commands/channels.test.ts`、`apps/cli/src/commands/channels-onboarding.test.ts`

- [x] **步骤 1：改写测试（先红）**
  - `serve`：mock client，断言调用 `startRuntime`、按 `bootId`+`seq` 高水位打印增量（首轮不打印历史）、SIGINT 调 `stopRuntime`、二次 SIGINT 强退。
  - `status`：daemon 不可用打印“daemon 未运行，无法读取渠道配置”；可用时打印运行时状态与白名单。
  - `add feishu`：扫码调 `startFeishuRegistration` 并轮询、按 `attempt` 丢弃旧二维码；手填调 `connectFeishu`；`allow` 调 `addFeishuAllow`。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts src/commands/channels-onboarding.test.ts`
- [x] **步骤 3：实现**：删除本地 `assembleChannelAdapters`/bus/manager/bridge 与本地 store 读写；保留 readline 交互与终端二维码渲染；`@vykor/auth` 依赖保留。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts src/commands/channels-onboarding.test.ts
pnpm --filter @rzx/ohs check-types
git add apps/cli/src/commands/channels.ts apps/cli/src/commands/channels.test.ts apps/cli/src/commands/channels-onboarding.ts apps/cli/src/commands/channels-onboarding.test.ts
git commit -m "refactor(cli): delegate channel commands to the daemon"
```

---

## 任务 9：Desktop 主进程与 IPC

**文件：**
- 修改：`apps/desktop/package.json`、`apps/desktop/src/shared/ipc-channels.ts`、`apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/preload/desktop-api.ts`、`apps/desktop/src/main/features/index.ts`
- 新建：`apps/desktop/src/shared/channel-types.ts`、`apps/desktop/src/main/features/channels/channel-service.ts`、`apps/desktop/src/main/features/channels/ipc.ts`
- 测试：`apps/desktop/src/main/features/channels/channel-service.test.ts`、`apps/desktop/src/main/features/channels/ipc.test.ts`

**Interfaces：**
- Produces：`IpcChannels.connections*`、`DesktopAPI.connections`、`DesktopChannelService`（`snapshot`、`runtimeStatus` → `{ runtime, newDenials }`、`connect`、`patch`、`remove`、`allowAdd`、`allowRemove`、`registrationStart/Status/Cancel`、`runtimeStart/Stop`）。

- [x] **步骤 1：编写失败的测试**：snapshot 合成；QR data URL 生成与 `attempt` 变化失效；secret 不出现在返回值/日志（spy logger）；`runtimeStatus` 首轮只建基线、`bootId` 变化重基线、只返回新增 `seq`；ipc handler 转发。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/desktop test -- --run src/main/features/channels`
- [x] **步骤 3：实现**
  - `package.json` 加 `qrcode`（devDeps 加 `@types/qrcode`）；`channel-types.ts` 从 `@vykor/client` 复用类型并补 `qrDataUrl`。
  - `ipc-channels.ts` 按 spec §10.1 增加 channels 与 `IpcInvokeMap`；`desktop-api-contract.ts` 增加 `connections`；preload 暴露。
  - `channel-service.ts` 注入 `getClient: () => desktopSessionService.daemonClient()`、`generateQrDataUrl`；main 持有 `bootId`+`seq` 高水位。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/desktop test -- --run src/main/features/channels
pnpm --filter @vykor/desktop typecheck:node
git add apps/desktop/package.json apps/desktop/src/shared/channel-types.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/main/features/channels apps/desktop/src/main/features/index.ts pnpm-lock.yaml
git commit -m "feat(desktop): add channel connections IPC and service"
```

---

## 任务 10：Desktop「连接」页面

**文件：**
- 新建：`apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.tsx`、`.../connections-settings.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx`

- [x] **步骤 1：编写失败的测试**（参考 `mcp-settings.test.tsx` 的挂载方式）：状态徽章（含“停止中”/“已停止（临时）”/“已停用”）、主开关调 `patch`、扫码显示二维码与取消、白名单增删、`patch` 开关、denial 增量提示与“加入白名单”、重试连接与移除接入确认。
- [x] **步骤 2：运行确认失败**：`pnpm --filter @vykor/desktop test -- --run connections-settings`
- [x] **步骤 3：实现**：页面按 spec §10.2；轮询由渲染层每 3s 串行执行（in-flight 跳过），失败保留上次快照并退避，卸载停止；`settings-content.tsx` 为“连接”补描述与分支。
- [x] **步骤 4：通过 + Commit**

```bash
pnpm --filter @vykor/desktop test -- --run connections-settings
pnpm --filter @vykor/desktop typecheck
git add apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/connections-settings.test.tsx apps/desktop/src/renderer/src/components/desktop/settings-page/settings-content.tsx
git commit -m "feat(desktop): add channel connections settings page"
```

---

## 任务 11：文档同步

**文件：** `docs/channels-flow.md`、`docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md`

- [x] **步骤 1：更新**
  - `docs/channels-flow.md`：运行时归属改为 daemon；`serve` 为委托；补 `/channels/runtime/*`、`/channels/feishu/*` 与 Desktop“连接”说明；使用完整文件路径（`check-docs` 会校验顶层文档中的源码路径）。
  - 交接文档：标注已完成/被取代的决策（Desktop 主进程不再直接写 `channel-credentials.json`）。
- [x] **步骤 2：校验 + Commit**

```bash
pnpm check-docs
git diff --check
git add docs/channels-flow.md docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md
git commit -m "docs: document daemon-owned channel runtime"
```

---

## 任务 12：阶段完整验证与人工验收

- [x] **步骤 1：相关包全量测试**

```bash
pnpm --filter @vykor/protocol test -- --run
pnpm --filter @vykor/channels test -- --run
pnpm --filter @vykor/auth test -- --run
pnpm --filter @vykor/core test -- --run
pnpm --filter @vykor/client test -- --run
pnpm --filter @vykor/server test -- --run
pnpm --filter @vykor/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
pnpm --filter @vykor/desktop test
pnpm --filter @vykor/desktop typecheck
```

- [x] **步骤 2：构建与校验**

```bash
pnpm exec turbo build --output-logs=full
pnpm check-docs
git diff --check
```

- [x] **步骤 3：打包体积测量（决定是否外置 lark SDK）**

检查 `apps/desktop/out/main` 是否出现含 lark SDK 的 chunk；若不可接受，按 spec §14 把 `@larksuiteoapi/node-sdk` 加入 `apps/desktop/package.json` dependencies 与 `electron.vite.config.ts` 的 `externalizeDeps.include`，重跑构建与 `pnpm --filter @vykor/desktop build`。

- [x] **步骤 4：人工验收**
  1. Desktop → 设置 → 连接：扫码接入（二维码显示、成功后白名单含本人 open_id）；
  2. 发消息收到回复；发一条被拒消息，Desktop 出现提示并可“加入白名单”，加入后无需重启即可对话；
  3. 主开关停用 → 飞书不再响应；重启 daemon 仍不连接；启用后恢复；
  4. `vk channels serve` 委托可用，Ctrl+C 有界停止；
  5. 启停期间 TUI/Desktop 既有会话不受影响。

---

## 阶段完成标准

- daemon 是唯一长连接所有者与唯一配置写入者；Desktop/CLI 全部走 API。
- Desktop“连接”板块满足 spec §13 全部验收项。
- 相关包测试、类型检查、全仓构建、`check-docs`、`git diff --check` 全绿。
- 无兼容 fallback；`@vykor/protocol` durable 类型未变。
