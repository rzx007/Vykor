# 飞书 CLI 扫码接入实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 新增 `vk channels add feishu`，支持“扫码创建应用（默认）/ 手填 App ID+Secret”，拿到凭据后当场校验、存独立凭据文件、默认只放扫码者、并支持 `vk channels allow` 与群/用户白名单。

**架构：** 在 `packages/channels` 里做一个可复用的“飞书接入核心”（注册状态机 + 凭据校验），在 `packages/auth` 做独立凭据存储，在 `packages/core` 调整配置结构与路径，CLI 只做交互编排。密钥不再进 `settings.json`；白名单 ACL 扩展为“发送者或会话任一命中”。

**技术栈：** TypeScript、Vitest、pnpm workspace、`@larksuiteoapi/node-sdk@^1.73.0`、`node:readline`、`qrcode-terminal`。

## Global Constraints

- 平台语义不泄漏：飞书专属逻辑放 channel adapter / 接入核心，CLI 只编排。
- 不降级、不伪造：校验失败即失败；读不到凭据直接报错；不用别处猜测。
- 密钥只落独立凭据文件；日志、状态、错误信息、`status` 输出都不回显 `appSecret`。
- 扫码一律 `createOnly: true`，只建新应用，绝不覆盖已有应用。
- 旧 `appSecret` 不迁移、运行时忽略；但 settings 白名单**保留**旧键，避免旧配置加载抛错。
- `domain` 取值为 `"feishu" | "lark"`；传给 SDK 时映射为 `lark.Domain.Feishu / lark.Domain.Lark`。
- 地区映射：`feishu` → 扫码 `accounts.feishu.cn`、API `open.feishu.cn`；`lark` → `accounts.larksuite.com`、`open.larksuite.com`。
- 凭据文件：POSIX `0600`，Windows 跳过 chmod（已知限制）。
- 不做任何兼容性 fallback。
- 不修改 `packages/mcp`、`packages/server`、`packages/services`、`packages/protocol`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/channels/package.json` | SDK 版本 | 修改 |
| `packages/channels/src/impl/feishu.ts` | `FeishuConfig.domain` + `connect()` 透传 | 修改 |
| `packages/channels/src/impl/__test__/feishu-connect.test.ts` | 断言 domain 透传 | 新建 |
| `packages/channels/src/impl/feishu-registration.ts` | 扫码注册状态机 | 新建 |
| `packages/channels/src/impl/__test__/feishu-registration.test.ts` | 状态机测试 | 新建 |
| `packages/channels/src/impl/feishu-verify.ts` | 凭据校验（tenant token + bot info） | 新建 |
| `packages/channels/src/impl/__test__/feishu-verify.test.ts` | 校验测试 | 新建 |
| `packages/channels/src/index.ts` | 导出接入核心 | 修改 |
| `packages/core/src/config/paths.ts` | `getChannelCredentialsFilePath` | 修改 |
| `packages/core/src/index.ts` | 导出新路径函数 | 修改 |
| `packages/core/src/types/settings.ts` | `FeishuChannelSettings` 调整 | 修改 |
| `packages/core/src/config/settings.ts` | 白名单调整 | 修改 |
| `packages/core/src/config/settings.test.ts` | 白名单测试 | 修改 |
| `packages/auth/src/channel-credential-store.ts` | 凭据存储 | 新建 |
| `packages/auth/src/__test__/channel-credential-store.test.ts` | 存储测试 | 新建 |
| `packages/auth/src/index.ts` | 导出存储 | 修改 |
| `packages/channels/src/bus/acl.ts` | ACL 支持会话匹配 | 修改 |
| `packages/channels/src/bus/queue.test.ts` | ACL 测试 | 修改 |
| `packages/channels/src/core/manager.ts` | 传 chatId、`onDenied` | 修改 |
| `packages/channels/src/__test__/manager.test.ts` | 拒绝回调测试 | 修改 |
| `apps/cli/src/commands/channels.ts` | `add`/`allow`/`serve` 接线 | 修改 |
| `apps/cli/src/commands/channels-onboarding.ts` | 向导流程（可注入） | 新建 |
| `apps/cli/src/commands/channels-onboarding.test.ts` | 向导测试 | 新建 |
| `apps/cli/src/commands/channels.test.ts` | 组装测试更新 | 修改 |
| `apps/cli/package.json` | `qrcode-terminal` 依赖 | 修改 |
| `packages/tools/src/channels/feishu-push.ts` | 改读凭据文件 | 修改 |
| `packages/tools/package.json` | 加 `@vykor/auth` | 修改 |

---

## 任务 1：升级 SDK 并让 adapter 支持地区

**文件：**
- 修改：`packages/channels/package.json`
- 修改：`packages/channels/src/impl/feishu.ts`
- 测试：`packages/channels/src/impl/__test__/feishu-connect.test.ts`（新建）

**Interfaces：**
- Produces：`FeishuConfig.domain?: "feishu" | "lark"`；`connect()` 把 domain 映射为 `lark.Domain.Feishu / lark.Domain.Lark` 传给 `Client` 与 `WSClient`。

- [ ] **步骤 1：升级依赖**

`packages/channels/package.json` 的 `"@larksuiteoapi/node-sdk": "^1.60.0"` 改为 `"^1.73.0"`，然后运行 `pnpm install`。

- [ ] **步骤 2：编写失败的测试**

新建 `packages/channels/src/impl/__test__/feishu-connect.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

const captured = vi.hoisted(() => ({
  client: [] as unknown[],
  ws: [] as unknown[],
}));

vi.mock("@larksuiteoapi/node-sdk", () => {
  class Client {
    constructor(options: unknown) {
      captured.client.push(options);
    }
  }
  class WSClient {
    constructor(options: unknown) {
      captured.ws.push(options);
    }
    async start(): Promise<void> {}
    async close(): Promise<void> {}
  }
  class EventDispatcher {
    register(): this {
      return this;
    }
  }
  return {
    Client,
    WSClient,
    EventDispatcher,
    LoggerLevel: { info: 2 },
    Domain: { Feishu: 0, Lark: 1 },
  };
});

import { FeishuAdapter } from "../feishu.js";

describe("FeishuAdapter.connect domain", () => {
  it("passes the Lark domain enum to Client and WSClient", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s", domain: "lark" });
    await adapter.connect();
    expect(captured.client[0]).toMatchObject({ domain: 1 });
    expect(captured.ws[0]).toMatchObject({ domain: 1 });
    await adapter.disconnect();
  });

  it("defaults to the Feishu domain enum", async () => {
    const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
    await adapter.connect();
    expect(captured.client[1]).toMatchObject({ domain: 0 });
    expect(captured.ws[1]).toMatchObject({ domain: 0 });
    await adapter.disconnect();
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-connect.test.ts`
预期：FAIL，`domain` 未传给 SDK。

- [ ] **步骤 4：最小实现**

`packages/channels/src/impl/feishu.ts`：

1. `FeishuConfig` 增加：

```ts
  /** "feishu"（国内，默认）或 "lark"（国际）。 */
  domain?: "feishu" | "lark";
```

2. `connect()` 内，动态 import 之后加一行，并把 domain 传给两个构造函数：

```ts
    const sdkDomain =
      this.config.domain === "lark" ? lark.Domain.Lark : lark.Domain.Feishu;
```

`new lark.Client({ ... })` 增加 `domain: sdkDomain,`；`new lark.WSClient({ ... })` 增加 `domain: sdkDomain,`。

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-connect.test.ts`
预期：PASS。再跑 `pnpm --filter @vykor/channels test -- --run` 与 `pnpm --filter @vykor/channels check-types` 确认升级没破坏其它测试。

- [ ] **步骤 6：Commit**

```bash
git add packages/channels/package.json pnpm-lock.yaml packages/channels/src/impl/feishu.ts packages/channels/src/impl/__test__/feishu-connect.test.ts
git commit -m "feat(channels): upgrade lark sdk and support feishu/lark domain"
```

---

## 任务 2：扫码注册状态机

**文件：**
- 新建：`packages/channels/src/impl/feishu-registration.ts`
- 测试：`packages/channels/src/impl/__test__/feishu-registration.test.ts`（新建）

**Interfaces：**
- Produces：
  - `FeishuRegistrationState`、`FeishuRegistrationStatus`
  - `FeishuRegistrationCredentials = { appId; appSecret; userId?; domain }`
  - `class FeishuRegistration`：`constructor({ registerApp?, onCredentials, now?, setTimeout?, clearTimeout? })`，方法 `start(options?)` / `status()` / `cancel()`。
  - `start(options)` 的 options：`{ appName?: string; appDesc?: string; domain?: "feishu" | "lark"; source?: string }`。

- [ ] **步骤 1：编写失败的测试**

新建 `packages/channels/src/impl/__test__/feishu-registration.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { FeishuRegistration } from "../feishu-registration.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("FeishuRegistration", () => {
  it("emits QR ready then succeeds with credentials", async () => {
    const gate = deferred<{ client_id: string; client_secret: string; user_info: { open_id: string; tenant_brand: "lark" } }>();
    const onCredentials = vi.fn(async () => undefined);
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async (options: any) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/page/launcher?x=1", expireIn: 600 });
        options.onStatusChange({ status: "polling" });
        return gate.promise;
      }),
      onCredentials,
      now: () => 1000,
    });

    registration.start({ domain: "feishu" });
    expect(registration.status().state).toBe("qr_ready");
    expect(registration.status().qrUrl).toContain("open.feishu.cn");

    gate.resolve({
      client_id: "cli_x",
      client_secret: "secret_x",
      user_info: { open_id: "ou_me", tenant_brand: "lark" },
    });
    await vi.waitFor(() => expect(registration.status().state).toBe("succeeded"));
    expect(onCredentials).toHaveBeenCalledWith({
      appId: "cli_x",
      appSecret: "secret_x",
      userId: "ou_me",
      domain: "lark",
    });
  });

  it("maps access_denied to error and abort to cancelled", async () => {
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async () => {
        throw Object.assign(new Error("denied"), { code: "access_denied" });
      }),
      onCredentials: vi.fn(async () => undefined),
    });
    registration.start();
    await vi.waitFor(() => expect(registration.status().state).toBe("error"));
    expect(registration.status().error?.code).toBe("access_denied");
  });

  it("cancel aborts an active attempt without credentials", async () => {
    const onCredentials = vi.fn(async () => undefined);
    const registration = new FeishuRegistration({
      registerApp: vi.fn(async (options: any) => {
        options.onQRCodeReady({ url: "https://open.feishu.cn/x", expireIn: 600 });
        return new Promise(() => {});
      }),
      onCredentials,
    });
    registration.start();
    expect(registration.status().state).toBe("qr_ready");
    registration.cancel();
    expect(registration.status().state).toBe("cancelled");
    expect(onCredentials).not.toHaveBeenCalled();
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-registration.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现**

新建 `packages/channels/src/impl/feishu-registration.ts`（移植并简化 `dsh-im` 的 RegistrationManager）：

```ts
type FeishuDomain = "feishu" | "lark";

export type FeishuRegistrationState =
  | "idle"
  | "starting"
  | "qr_ready"
  | "polling"
  | "slow_down"
  | "domain_switched"
  | "succeeded"
  | "expired"
  | "cancelled"
  | "error";

export interface FeishuRegistrationStatus {
  state: FeishuRegistrationState;
  attempt: number;
  domain: FeishuDomain;
  qrUrl?: string;
  expiresAt?: number;
  remainingSeconds?: number;
  pollIntervalMs?: number;
  error?: { code: string; message: string };
}

export interface FeishuRegistrationCredentials {
  appId: string;
  appSecret: string;
  userId?: string;
  domain: FeishuDomain;
}

export interface FeishuRegistrationStartOptions {
  appName?: string;
  appDesc?: string;
  domain?: FeishuDomain;
  source?: string;
}

interface RegisterAppResult {
  client_id: string;
  client_secret: string;
  user_info?: { open_id?: string; tenant_brand?: FeishuDomain };
}

type RegisterAppFn = (options: Record<string, unknown>) => Promise<RegisterAppResult>;

const ACTIVE = new Set<FeishuRegistrationState>([
  "starting",
  "qr_ready",
  "polling",
  "slow_down",
  "domain_switched",
]);

const POLLING_STATES = new Set(["polling", "slow_down", "domain_switched"] as const);

/** 新建应用时预填的租户权限。 */
export const FEISHU_ONBOARDING_TENANT_SCOPES = [
  "im:message.p2p_msg:readonly",
  "im:message.group_at_msg:readonly",
  "im:message:send_as_bot",
  "im:resource",
] as const;

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === "access_denied" || code === "expired_token" || code === "abort") {
    return code;
  }
  return "registration_failed";
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: "扫码授权被拒绝。",
  abort: "已取消扫码。",
  expired_token: "二维码已过期。",
};

export class FeishuRegistration {
  #registerApp: RegisterAppFn;
  #onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>;
  #now: () => number;
  #setTimeout: typeof setTimeout;
  #clearTimeout: typeof clearTimeout;
  #attempt = 0;
  #active: { id: number; controller: AbortController; qrUrl: string | null; expiresAt: number | null; pollIntervalMs: number | null; timer: ReturnType<typeof setTimeout> | null } | null = null;
  #snapshot: FeishuRegistrationStatus;

  constructor(deps: {
    registerApp?: RegisterAppFn;
    onCredentials: (credentials: FeishuRegistrationCredentials) => Promise<void>;
    now?: () => number;
    setTimeout?: typeof setTimeout;
    clearTimeout?: typeof clearTimeout;
  }) {
    this.#onCredentials = deps.onCredentials;
    this.#now = deps.now ?? Date.now;
    this.#setTimeout = deps.setTimeout ?? setTimeout;
    this.#clearTimeout = deps.clearTimeout ?? clearTimeout;
    this.#registerApp =
      deps.registerApp ??
      ((options) => import("@larksuiteoapi/node-sdk").then((lark) => lark.registerApp(options as never) as Promise<RegisterAppResult>));
    this.#snapshot = { state: "idle", attempt: 0, domain: "feishu" };
  }

  start(options: FeishuRegistrationStartOptions = {}): FeishuRegistrationStatus {
    this.#supersede();
    const domain = options.domain ?? "feishu";
    const run = {
      id: ++this.#attempt,
      controller: new AbortController(),
      qrUrl: null as string | null,
      expiresAt: null as number | null,
      pollIntervalMs: null as number | null,
      timer: null as ReturnType<typeof setTimeout> | null,
    };
    this.#active = run;
    this.#snapshot = { state: "starting", attempt: run.id, domain };

    const registerOptions: Record<string, unknown> = {
      source: options.source ?? "vykor",
      domain: domain === "lark" ? "accounts.larksuite.com" : "accounts.feishu.cn",
      createOnly: true,
      appPreset: {
        name: options.appName ?? "{user} 的 Vykor 机器人",
        desc: options.appDesc ?? "把飞书接入 Vykor。",
      },
      addons: {
        preset: true,
        scopes: { tenant: [...FEISHU_ONBOARDING_TENANT_SCOPES] },
        events: { items: { tenant: ["im.message.receive_v1"] } },
        callbacks: { items: ["card.action.trigger"] },
      },
      signal: run.controller.signal,
      onQRCodeReady: (info: { url: string; expireIn: number }) => this.#onQrReady(run, info),
      onStatusChange: (info: { status: string; interval?: number }) => this.#onStatusChange(run, info),
    };

    Promise.resolve()
      .then(() => this.#registerApp(registerOptions))
      .then(
        (result) => this.#onSucceeded(run, result),
        (error) => this.#onFailed(run, error),
      );

    return this.status();
  }

  status(): FeishuRegistrationStatus {
    this.#expireIfNeeded();
    const snapshot = { ...this.#snapshot };
    if (snapshot.error) snapshot.error = { ...snapshot.error };
    const run = this.#active;
    if (run && run.expiresAt !== null && ACTIVE.has(snapshot.state)) {
      snapshot.remainingSeconds = Math.max(0, Math.ceil((run.expiresAt - this.#now()) / 1000));
    }
    return snapshot;
  }

  cancel(): FeishuRegistrationStatus {
    const run = this.#active;
    if (!run) return this.status();
    this.#finish(run, "cancelled", { code: "abort", message: ERROR_MESSAGES.abort! });
    run.controller.abort();
    return this.status();
  }

  #isCurrent(run: NonNullable<FeishuRegistration["#active"]>): boolean {
    return this.#active === run;
  }

  #onQrReady(run: NonNullable<FeishuRegistration["#active"]>, info: { url: string; expireIn: number }): void {
    if (!this.#isCurrent(run)) return;
    if (typeof info?.url !== "string" || !info.url) return;
    const seconds = Number(info.expireIn);
    if (!Number.isFinite(seconds) || seconds <= 0) return;
    run.qrUrl = info.url;
    run.expiresAt = this.#now() + seconds * 1000;
    if (run.timer) this.#clearTimeout(run.timer);
    run.timer = this.#setTimeout(() => this.#expire(run), seconds * 1000);
    (run.timer as { unref?: () => void }).unref?.();
    this.#snapshot = {
      state: "qr_ready",
      attempt: run.id,
      domain: this.#snapshot.domain,
      qrUrl: run.qrUrl,
      expiresAt: run.expiresAt,
    };
  }

  #onStatusChange(run: NonNullable<FeishuRegistration["#active"]>, info: { status: string; interval?: number }): void {
    if (!this.#isCurrent(run) || !POLLING_STATES.has(info?.status as never)) return;
    if (info.status === "slow_down" && Number.isFinite(Number(info.interval))) {
      run.pollIntervalMs = Number(info.interval) * 1000;
    }
    this.#snapshot = {
      state: info.status as FeishuRegistrationState,
      attempt: run.id,
      domain: this.#snapshot.domain,
      ...(run.qrUrl ? { qrUrl: run.qrUrl } : {}),
      ...(run.expiresAt !== null ? { expiresAt: run.expiresAt } : {}),
      ...(run.pollIntervalMs !== null ? { pollIntervalMs: run.pollIntervalMs } : {}),
    };
  }

  async #onSucceeded(run: NonNullable<FeishuRegistration["#active"]>, result: RegisterAppResult): Promise<void> {
    if (!this.#isCurrent(run)) return;
    const appId = result?.client_id;
    const appSecret = result?.client_secret;
    if (typeof appId !== "string" || !appId || typeof appSecret !== "string" || !appSecret) {
      this.#finish(run, "error", { code: "invalid_credentials", message: "扫码返回的凭据不完整。" });
      return;
    }
    const domain = result.user_info?.tenant_brand ?? this.#snapshot.domain;
    this.#clearTimer(run);
    run.qrUrl = null;
    run.expiresAt = null;
    try {
      await this.#onCredentials({
        appId,
        appSecret,
        ...(result.user_info?.open_id ? { userId: result.user_info.open_id } : {}),
        domain,
      });
    } catch {
      if (this.#isCurrent(run)) {
        this.#finish(run, "error", { code: "credentials_callback_failed", message: "保存凭据失败。" });
      }
      return;
    }
    if (this.#isCurrent(run)) this.#finish(run, "succeeded");
  }

  #onFailed(run: NonNullable<FeishuRegistration["#active"]>, error: unknown): void {
    if (!this.#isCurrent(run)) return;
    const code = errorCode(error);
    const state: FeishuRegistrationState =
      code === "expired_token" ? "expired" : code === "abort" ? "cancelled" : "error";
    this.#finish(run, state, {
      code,
      message: ERROR_MESSAGES[code] ?? "飞书应用创建失败。",
    });
  }

  #expireIfNeeded(): void {
    const run = this.#active;
    if (run && run.expiresAt !== null && this.#now() >= run.expiresAt) this.#expire(run);
  }

  #expire(run: NonNullable<FeishuRegistration["#active"]>): void {
    if (!this.#isCurrent(run)) return;
    this.#finish(run, "expired", { code: "expired_token", message: ERROR_MESSAGES.expired_token! });
    run.controller.abort();
  }

  #finish(
    run: NonNullable<FeishuRegistration["#active"]>,
    state: FeishuRegistrationState,
    error?: { code: string; message: string },
  ): void {
    if (!this.#isCurrent(run)) return;
    this.#clearTimer(run);
    this.#snapshot = {
      state,
      attempt: run.id,
      domain: this.#snapshot.domain,
      ...(error ? { error } : {}),
    };
    this.#active = null;
  }

  #clearTimer(run: NonNullable<FeishuRegistration["#active"]>): void {
    if (run.timer) {
      this.#clearTimeout(run.timer);
      run.timer = null;
    }
  }

  #supersede(): void {
    const previous = this.#active;
    if (!previous) return;
    this.#clearTimer(previous);
    this.#active = null;
    previous.controller.abort();
  }
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-registration.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/impl/feishu-registration.ts packages/channels/src/impl/__test__/feishu-registration.test.ts
git commit -m "feat(channels): add feishu QR registration state machine"
```

---

## 任务 3：凭据校验

**文件：**
- 新建：`packages/channels/src/impl/feishu-verify.ts`
- 测试：`packages/channels/src/impl/__test__/feishu-verify.test.ts`（新建）

**Interfaces：**
- Produces：`verifyFeishuCredentials({ appId, appSecret, domain, fetchImpl?, timeoutMs? }): Promise<{ appId; name?; openId?; activated? }>`。
- `type VerifyFetch = typeof fetch`（便于注入）。

- [ ] **步骤 1：编写失败的测试**

新建 `packages/channels/src/impl/__test__/feishu-verify.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import { verifyFeishuCredentials } from "../feishu-verify.js";

function jsonResponse(body: unknown, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 400,
    json: async () => body,
  } as unknown as Response;
}

describe("verifyFeishuCredentials", () => {
  it("returns bot info after a successful tenant token exchange", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t-1" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, bot: { app_name: "机器人", open_id: "ou_bot", activate_status: 2 } }));

    const result = await verifyFeishuCredentials({
      appId: "cli_x",
      appSecret: "sec",
      domain: "feishu",
      fetchImpl,
    });

    expect(result).toEqual({ appId: "cli_x", name: "机器人", openId: "ou_bot", activated: 2 });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    );
  });

  it("throws a credential error when the token exchange fails", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 10003, msg: "invalid app_secret" }, false));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "bad", domain: "feishu", fetchImpl }),
    ).rejects.toThrow(/凭据/);
  });

  it("uses the Lark API base for the lark domain", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ code: 0, bot: {} }));

    await verifyFeishuCredentials({ appId: "cli_x", appSecret: "s", domain: "lark", fetchImpl });
    expect(fetchImpl.mock.calls[0]![0]).toBe(
      "https://open.larksuite.com/open-apis/auth/v3/tenant_access_token/internal",
    );
  });

  it("still succeeds when bot info is unavailable", async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse({ code: 0, tenant_access_token: "t" }))
      .mockResolvedValueOnce(jsonResponse({ code: 1, msg: "nope" }, false));

    await expect(
      verifyFeishuCredentials({ appId: "cli_x", appSecret: "s", domain: "feishu", fetchImpl }),
    ).resolves.toEqual({ appId: "cli_x" });
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-verify.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现**

新建 `packages/channels/src/impl/feishu-verify.ts`：

```ts
type FeishuDomain = "feishu" | "lark";

export interface VerifyFeishuCredentialsInput {
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface VerifiedFeishuBot {
  appId: string;
  name?: string;
  openId?: string;
  activated?: number;
}

function apiBase(domain: FeishuDomain): string {
  return domain === "lark" ? "https://open.larksuite.com" : "https://open.feishu.cn";
}

async function postJson(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "POST",
    headers: { "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as Record<string, unknown>;
}

async function getJson(
  fetchImpl: typeof fetch,
  url: string,
  token: string,
  timeoutMs: number,
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(timeoutMs),
  });
  return (await response.json()) as Record<string, unknown>;
}

export async function verifyFeishuCredentials(
  input: VerifyFeishuCredentialsInput,
): Promise<VerifiedFeishuBot> {
  const fetchImpl = input.fetchImpl ?? fetch;
  const timeoutMs = input.timeoutMs ?? 15000;
  const base = apiBase(input.domain);

  let tokenBody: Record<string, unknown>;
  try {
    tokenBody = await postJson(
      fetchImpl,
      `${base}/open-apis/auth/v3/tenant_access_token/internal`,
      { app_id: input.appId, app_secret: input.appSecret },
      timeoutMs,
    );
  } catch {
    throw new Error("无法连接飞书验证凭据（网络问题）。");
  }
  if (tokenBody.code !== 0 || typeof tokenBody.tenant_access_token !== "string") {
    throw new Error("飞书凭据校验失败：appId 或 appSecret 不正确，或地区选择不对。");
  }

  try {
    const botBody = await getJson(
      fetchImpl,
      `${base}/open-apis/bot/v3/info/`,
      tokenBody.tenant_access_token,
      timeoutMs,
    );
    if (botBody.code === 0 && botBody.bot && typeof botBody.bot === "object") {
      const bot = botBody.bot as Record<string, unknown>;
      return {
        appId: input.appId,
        ...(typeof bot.app_name === "string" ? { name: bot.app_name } : {}),
        ...(typeof bot.open_id === "string" ? { openId: bot.open_id } : {}),
        ...(typeof bot.activate_status === "number" ? { activated: bot.activate_status } : {}),
      };
    }
  } catch {
    // 机器人信息只用于展示，取不到不影响“凭据有效”。
  }
  return { appId: input.appId };
}
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/channels test -- --run src/impl/__test__/feishu-verify.test.ts`
预期：PASS。

- [ ] **步骤 5：导出并 Commit**

在 `packages/channels/src/index.ts` 末尾加：

```ts
export { FeishuRegistration, FEISHU_ONBOARDING_TENANT_SCOPES } from "./impl/feishu-registration";
export type {
  FeishuRegistrationState,
  FeishuRegistrationStatus,
  FeishuRegistrationCredentials,
} from "./impl/feishu-registration";
export { verifyFeishuCredentials } from "./impl/feishu-verify";
export type { VerifiedFeishuBot } from "./impl/feishu-verify";
```

```bash
git add packages/channels/src/impl/feishu-verify.ts packages/channels/src/impl/__test__/feishu-verify.test.ts packages/channels/src/index.ts
git commit -m "feat(channels): verify feishu credentials via tenant token"
```

---

## 任务 4：独立凭据存储

**文件：**
- 修改：`packages/core/src/config/paths.ts`
- 修改：`packages/core/src/index.ts`
- 新建：`packages/auth/src/channel-credential-store.ts`
- 测试：`packages/auth/src/__test__/channel-credential-store.test.ts`（新建）
- 修改：`packages/auth/src/index.ts`

**Interfaces：**
- Produces：
  - `getChannelCredentialsFilePath(): string`（core）
  - `class ChannelCredentialStore`：`constructor(filePath?)`；`get(appId): Promise<string | undefined>`、`set(appId, secret): Promise<void>`、`delete(appId): Promise<boolean>`。
  - `class ChannelCredentialStoreError extends Error { code }`。

- [ ] **步骤 1：加 core 路径函数**

`packages/core/src/config/paths.ts`：在 `ResolvedPaths` 增加 `channelCredentialsFilePath: string;`，赋值处加
`channelCredentialsFilePath: join(configDir, "channel-credentials.json"),`，文件末尾加：

```ts
export function getChannelCredentialsFilePath(): string {
  return resolvePaths().channelCredentialsFilePath;
}
```

`packages/core/src/index.ts` 的 `./config/paths` 导出块里，`getMcpOAuthFilePath,` 之后加 `getChannelCredentialsFilePath,`。

- [ ] **步骤 2：编写失败的测试**

新建 `packages/auth/src/__test__/channel-credential-store.test.ts`：

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { ChannelCredentialStore } from "../channel-credential-store.js";

function tempStore() {
  const directory = mkdtempSync(join(tmpdir(), "vk-channel-cred-"));
  return { path: join(directory, "channel-credentials.json"), directory };
}

describe("ChannelCredentialStore", () => {
  it("returns undefined for a missing file and round-trips secrets", async () => {
    const { path } = tempStore();
    const store = new ChannelCredentialStore(path);
    expect(await store.get("cli_a")).toBeUndefined();
    await store.set("cli_a", "secret-a");
    expect(await store.get("cli_a")).toBe("secret-a");
    await store.set("cli_a", "secret-b");
    expect(await store.get("cli_a")).toBe("secret-b");
    expect(await store.delete("cli_a")).toBe(true);
    expect(await store.get("cli_a")).toBeUndefined();
    expect(await store.delete("cli_a")).toBe(false);
  });

  it("throws a clear error for an invalid file", async () => {
    const { path } = tempStore();
    writeFileSync(path, "{ not json");
    const store = new ChannelCredentialStore(path);
    await expect(store.get("cli_a")).rejects.toMatchObject({
      name: "ChannelCredentialStoreError",
      code: "invalid-channel-credential-store",
    });
  });

  it("serializes concurrent writes without losing entries", async () => {
    const { path } = tempStore();
    const store = new ChannelCredentialStore(path);
    await Promise.all([
      store.set("cli_a", "a"),
      store.set("cli_b", "b"),
      store.set("cli_c", "c"),
    ]);
    expect(await store.get("cli_a")).toBe("a");
    expect(await store.get("cli_b")).toBe("b");
    expect(await store.get("cli_c")).toBe("c");
  });
});
```

- [ ] **步骤 3：运行测试确认失败**

运行：`pnpm --filter @vykor/auth test -- --run src/__test__/channel-credential-store.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 4：实现（照 mcp 存储移植）**

新建 `packages/auth/src/channel-credential-store.ts`：复制 `packages/auth/src/mcp-oauth-credential-store.ts` 的
文件读写/锁/原子写机制（`read` 的 ENOENT 空、`write` 的临时文件 + rename + POSIX chmod、`withLock`），
把结构换成：

```ts
interface ChannelCredentialStoreFile {
  version: 1;
  credentials: Record<string, { appSecret: string }>;
}
```

- 构造：`constructor(private readonly filePath = getChannelCredentialsFilePath(), private readonly clock = () => Date.now())`。
- `get(appId)`：读文件（经 `withLock`），返回 `credentials[appId]?.appSecret`。
- `set(appId, secret)`：`withLock` 内读改写，校验 `appId`/`secret` 非空。
- `delete(appId)`：`withLock` 内删除，返回是否存在过。
- 非法结构/坏 JSON 抛 `ChannelCredentialStoreError("invalid-channel-credential-store", ...)`。
- 错误类型：

```ts
export class ChannelCredentialStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChannelCredentialStoreError";
  }
}
```

`packages/auth/src/index.ts` 追加：

```ts
export { ChannelCredentialStore, ChannelCredentialStoreError } from "./channel-credential-store";
```

- [ ] **步骤 5：运行测试确认通过**

运行：`pnpm --filter @vykor/auth test -- --run src/__test__/channel-credential-store.test.ts` 与
`pnpm --filter @vykor/core check-types`。
预期：PASS / 退出码 0。

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/config/paths.ts packages/core/src/index.ts packages/auth/src/channel-credential-store.ts packages/auth/src/__test__/channel-credential-store.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): add channel credential store"
```

---

## 任务 5：配置结构调整 + 运行侧改读凭据文件

**文件：**
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/core/src/config/settings.test.ts`
- 修改：`apps/cli/src/commands/channels.ts`
- 修改：`apps/cli/src/commands/channels.test.ts`
- 修改：`packages/tools/src/channels/feishu-push.ts`
- 修改：`packages/tools/package.json`

**Interfaces：**
- Consumes：任务 1 的 `FeishuConfig.domain`、任务 4 的 `ChannelCredentialStore`。
- Produces：`FeishuChannelSettings = { enabled; appId; domain?; allowFrom; replyAtBotNames? }`；`assembleChannelAdapters` 从凭据文件取 secret。

- [ ] **步骤 1：调整 settings 类型与白名单**

`packages/core/src/types/settings.ts` 的 `FeishuChannelSettings` 改为：

```ts
export interface FeishuChannelSettings {
  enabled: boolean;
  appId: string;
  /** "feishu"（国内，默认）或 "lark"（国际）。 */
  domain?: "feishu" | "lark";
  /** ACL 白名单：name→id 映射，空 = 全拒（fail-closed），{ "*": "*" } = 全放。 */
  allowFrom: Record<string, string>;
  /** 群聊中只响应 @ 这些名字的消息；空 = 群聊全响应。 */
  replyAtBotNames?: string[];
}
```

`packages/core/src/config/settings.ts` 的 white-list 数组改为（保留旧键以免旧配置抛错，但运行时不再使用）：

```ts
    assertNestedFields(channels, "feishu", [
      "enabled",
      "appId",
      "domain",
      "allowFrom",
      "replyAtBotNames",
      // 旧字段：接受但忽略，避免旧 settings.json 触发 SettingsFileError。
      "appSecret",
      "encryptKey",
      "verificationToken",
    ], configPath, "settings.channels");
```

- [ ] **步骤 2：更新 settings 与 CLI 测试（预期先红）**

`packages/core/src/config/settings.test.ts` 增加一例，断言旧键仍可加载（被忽略）：

```ts
  it("accepts but ignores legacy feishu secret fields", async () => {
    writeFileSync(join(configDir, "settings.json"), JSON.stringify({
      channels: { feishu: { enabled: true, appId: "cli_x", appSecret: "old", allowFrom: {} } },
    }));
    const settings = await loadSettings();
    expect(settings.channels?.feishu?.appId).toBe("cli_x");
    expect((settings.channels?.feishu as Record<string, unknown>).appSecret).toBeUndefined();
  });
```

`apps/cli/src/commands/channels.test.ts` 的 feishu 夹具去掉 `appSecret`，改为 `domain`，并 mock 凭据存储。
示例（顶部 mock 参照现有 `vi.hoisted`/`vi.mock`）：

```ts
const secrets = vi.hoisted(() => new Map<string, string>());
vi.mock("@vykor/auth", () => ({
  ChannelCredentialStore: class {
    async get(appId: string) { return secrets.get(appId); }
    async set() {}
    async delete() { return false; }
  },
}));
```

夹具改为：

```ts
      feishu: { enabled: true, appId: "cli_x", domain: "feishu", allowFrom: { 个人: "ou_1" } },
```

并新增一例：`appSecret` 不在 settings、凭据文件里有 `cli_x` → 组装成功。

- [ ] **步骤 3：运行确认失败**

运行：`pnpm --filter @vykor/core test -- --run src/config/settings.test.ts` 与
`pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts`
预期：FAIL（类型/断言未满足）。

- [ ] **步骤 4：改运行侧**

`apps/cli/src/commands/channels.ts`：

- `assembleChannelAdapters` 改为 async 读取凭据：

```ts
import { ChannelCredentialStore } from "@vykor/auth";

export async function assembleChannelAdapters(
  channels: ChannelsConfig | undefined,
  credentials: ChannelCredentialStore = new ChannelCredentialStore(),
): Promise<AssembledChannels> {
  // ...
  if (feishu?.enabled) {
    const appSecret = await credentials.get(feishu.appId);
    if (!feishu.appId || !appSecret) {
      warnings.push("feishu 已启用但缺凭据，请先运行 vk channels add feishu。");
    } else {
      const { FeishuAdapter } = await import("@vykor/channels");
      adapters.push(new FeishuAdapter({
        appId: feishu.appId,
        appSecret,
        domain: feishu.domain,
        replyAtBotNames: feishu.replyAtBotNames,
      }));
      allowFrom["feishu"] = Object.values(feishu.allowFrom ?? {});
      accountIds["feishu"] = feishu.appId;
    }
  }
```

- `ChannelsConfig` 类型仍从 `@vykor/core` 导入；`pnpm --filter @rzx/ohs check-types` 会指出遗漏。

`packages/tools/src/channels/feishu-push.ts`：

- 把 `if (!feishu?.appId || !feishu?.appSecret)` 改成 `if (!feishu?.appId)` 并统计“未配置 appId”错误文案；
- 发请求前 `const appSecret = await new ChannelCredentialStore().get(feishu.appId);` 为空则返回
  “Error: channels.feishu 缺少凭据，请先运行 vk channels add feishu”；
- `getTenantToken(feishu.appId, appSecret, ...)`。
- `packages/tools/package.json` dependencies 增加 `"@vykor/auth": "workspace:*",`。

- [ ] **步骤 5：运行确认通过**

运行：
```
pnpm --filter @vykor/core test -- --run src/config/settings.test.ts
pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts
pnpm --filter @vykor/tools check-types
pnpm --filter @rzx/ohs check-types
```
预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/types/settings.ts packages/core/src/config/settings.ts packages/core/src/config/settings.test.ts apps/cli/src/commands/channels.ts apps/cli/src/commands/channels.test.ts packages/tools/src/channels/feishu-push.ts packages/tools/package.json
git commit -m "feat(core): move feishu secret out of settings to credential store"
```

---

## 任务 6：ACL 支持会话匹配 + `onDenied`

**文件：**
- 修改：`packages/channels/src/bus/acl.ts`
- 修改：`packages/channels/src/bus/queue.test.ts`
- 修改：`packages/channels/src/core/manager.ts`
- 修改：`packages/channels/src/__test__/manager.test.ts`

**Interfaces：**
- Produces：
  - `isAllowed(input: { sender: string; chatId?: string }, allowFrom: string[] | undefined): boolean`
  - `ChannelManagerOptions.onDenied?: (info: { channel: string; sender: string; chatId: string }) => void`

- [ ] **步骤 1：编写失败的测试**

`packages/channels/src/bus/queue.test.ts` 的 `isAllowed` 用例改为/增加：

```ts
  it("匹配发送者", () => {
    expect(isAllowed({ sender: "ou_1" }, ["ou_1"])).toBe(true);
    expect(isAllowed({ sender: "ou_2" }, ["ou_1"])).toBe(false);
  });

  it("匹配会话（群）", () => {
    expect(isAllowed({ sender: "ou_1", chatId: "oc_g" }, ["oc_g"])).toBe(true);
    expect(isAllowed({ sender: "ou_1", chatId: "oc_other" }, ["oc_g"])).toBe(false);
  });

  it("空名单全拒（fail-closed）", () => {
    expect(isAllowed({ sender: "ou_1" }, [])).toBe(false);
    expect(isAllowed({ sender: "ou_1", chatId: "oc_g" }, undefined)).toBe(false);
  });

  it('"*" 全放', () => {
    expect(isAllowed({ sender: "anyone", chatId: "oc_g" }, ["*"])).toBe(true);
  });

  it("发送者支持复合 id 分段", () => {
    expect(isAllowed({ sender: "open|union" }, ["union"])).toBe(true);
  });
```

`packages/channels/src/__test__/manager.test.ts` 增加：

```ts
  it("ACL 拒绝时调用 onDenied 并带 sender/chatId", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const denied: Array<{ channel: string; sender: string; chatId: string }> = [];
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["ou_allowed"] },
      onDenied: (info) => denied.push(info),
    });
    await mgr.startAll();
    fake.emit({ sender: "ou_intruder", chatId: "oc_g1" });
    await tick();
    expect(denied).toEqual([{ channel: "t", sender: "ou_intruder", chatId: "oc_g1" }]);
    await mgr.stopAll();
  });
```

- [ ] **步骤 2：运行确认失败**

运行：`pnpm --filter @vykor/channels test -- --run src/bus/queue.test.ts src/__test__/manager.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现**

`packages/channels/src/bus/acl.ts`：

```ts
export interface AclSubject {
  sender: string;
  chatId?: string;
}

export function isAllowed(
  subject: AclSubject,
  allowFrom: string[] | undefined,
): boolean {
  if (!allowFrom || allowFrom.length === 0) return false;
  if (allowFrom.includes("*")) return true;
  const candidates = [subject.sender, subject.chatId].filter(
    (value): value is string => typeof value === "string" && value.length > 0,
  );
  return candidates.some((candidate) => {
    if (allowFrom.includes(candidate)) return true;
    return candidate.split("|").some((part) => part !== "" && allowFrom.includes(part));
  });
}
```

`packages/channels/src/core/manager.ts`：

- `ChannelManagerOptions` 增加：

```ts
  /** ACL 拒绝时的结构化回调（用于提示用户加入白名单）。 */
  onDenied?: (info: { channel: string; sender: string; chatId: string }) => void;
```

- `handleInbound` 的 ACL 分支改为：

```ts
    const allowList = this.opts.allowFrom[channelName];
    if (!isAllowed({ sender: msg.sender, ...(msg.chatId ? { chatId: msg.chatId } : {}) }, allowList)) {
      this.opts.onWarning?.(
        `通道 ${channelName} 拒绝来自 ${msg.sender} 的消息（不在 allowFrom）。`,
      );
      if (msg.chatId) {
        this.opts.onDenied?.({ channel: channelName, sender: msg.sender, chatId: msg.chatId });
      }
      return;
    }
```

（`isAllowed` 之前 `sender` 必填且 `chatId` 在更下方校验；把 `chatId` 校验保持在 ACL 之后不变。）

- [ ] **步骤 4：运行确认通过**

运行：`pnpm --filter @vykor/channels test -- --run` 与 `pnpm --filter @vykor/channels check-types`
预期：全部通过（含现有 acl/manager 用例已按新签名更新）。

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/bus/acl.ts packages/channels/src/bus/queue.test.ts packages/channels/src/core/manager.ts packages/channels/src/__test__/manager.test.ts
git commit -m "feat(channels): match ACL by sender or chat and report denials"
```

---

## 任务 7：CLI 向导与 allow

**文件：**
- 修改：`apps/cli/package.json`（`qrcode-terminal` dependencies、`@types/qrcode-terminal` devDependencies）
- 新建：`apps/cli/src/commands/channels-onboarding.ts`
- 测试：`apps/cli/src/commands/channels-onboarding.test.ts`（新建）
- 修改：`apps/cli/src/commands/channels.ts`（注册 `add`/`allow`、`serve` 接 `onDenied`）
- 修改：`apps/cli/src/commands/channels.test.ts`（如新增 allow 测试）

**Interfaces：**
- Consumes：`FeishuRegistration`、`verifyFeishuCredentials`、`ChannelCredentialStore`、`loadSettings`/`saveSettings`。
- Produces：`runChannelsAddFeishu(deps?)`、`runChannelsAllow(id, name?, deps?)`，依赖可注入以便测试。

- [ ] **步骤 1：加依赖**

`apps/cli/package.json`：dependencies 加 `"qrcode-terminal": "^0.12.0"`；devDependencies 加 `"@types/qrcode-terminal": "^0.12.2"`。运行 `pnpm install`。

- [ ] **步骤 2：编写失败的测试**

新建 `apps/cli/src/commands/channels-onboarding.test.ts`（注入假依赖，不真连飞书）：

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { runChannelsAddFeishu } from "./channels-onboarding.js";

function deps() {
  const secrets = new Map<string, string>();
  return {
    secrets,
    verify: vi.fn(async () => ({ appId: "cli_x", name: "机器人" })),
    credentials: {
      get: vi.fn(async (id: string) => secrets.get(id)),
      set: vi.fn(async (id: string, secret: string) => { secrets.set(id, secret); }),
      delete: vi.fn(async (id: string) => secrets.delete(id)),
    },
    loadSettings: vi.fn(async () => ({ model: "m" })),
    saveSettings: vi.fn(async () => undefined),
    renderQr: vi.fn(),
  };
}

describe("runChannelsAddFeishu", () => {
  it("scan path writes credentials, config, and scanner whitelist", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createRegistration: (onCredentials: (c: unknown) => Promise<void>) => {
        void onCredentials({ appId: "cli_x", appSecret: "sec", userId: "ou_me", domain: "feishu" });
        return {
          start: () => ({ state: "qr_ready", attempt: 1, domain: "feishu", qrUrl: "https://open.feishu.cn/x" }),
          status: () => ({ state: "succeeded", attempt: 1, domain: "feishu" }),
          cancel: () => undefined,
        } as never;
      },
      createCredentials: () => d.credentials as never,
      promptSelect: async () => "scan",
      loadSettings: d.loadSettings as never,
      saveSettings: d.saveSettings as never,
      verify: d.verify as never,
      renderQr: d.renderQr,
      log: vi.fn(),
    } as never);

    expect(d.credentials.set).toHaveBeenCalledWith("cli_x", "sec");
    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: expect.objectContaining({
          feishu: expect.objectContaining({
            enabled: true,
            appId: "cli_x",
            domain: "feishu",
            allowFrom: expect.objectContaining({ ou_me: "ou_me" }),
          }),
        }),
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("manual path writes config without a scanner whitelist entry", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as any,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_m" : q.includes("Secret") ? "sec_m" : ""),
      loadSettings: d.loadSettings as any,
      saveSettings: d.saveSettings as any,
      verify: d.verify as any,
      log: vi.fn(),
    } as never);

    expect(d.saveSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        channels: { feishu: expect.objectContaining({ enabled: true, appId: "cli_m" }) },
      }),
    );
    expect(result.ok).toBe(true);
  });

  it("does not write anything when verification fails", async () => {
    const d = deps();
    const result = await runChannelsAddFeishu({
      createCredentials: () => d.credentials as any,
      promptSelect: async () => "manual",
      promptText: async (q: string) => (q.includes("App ID") ? "cli_bad" : "bad"),
      loadSettings: d.loadSettings as any,
      saveSettings: d.saveSettings as any,
      verify: vi.fn(async () => { throw new Error("凭据校验失败"); }) as any,
      log: vi.fn(),
    } as never);

    expect(result.ok).toBe(false);
    expect(d.credentials.set).not.toHaveBeenCalled();
    expect(d.saveSettings).not.toHaveBeenCalled();
  });
});
```

（测试通过注入 `createRegistration` / `promptSelect` / `promptText` / `verify` / `saveSettings` 等依赖，避免真连飞书；实现时把这些依赖做成可选参数。）

- [ ] **步骤 3：运行确认失败**

运行：`pnpm --filter @rzx/ohs test -- --run src/commands/channels-onboarding.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 4：实现向导**

新建 `apps/cli/src/commands/channels-onboarding.ts`，导出 `runChannelsAddFeishu(deps?)`：

- 依赖（都可注入）：`promptSelect`、`promptText`、`promptConfirm`、`createRegistration(onCredentials)`、
  `createCredentials()`、`verify`、`loadSettings`、`saveSettings`、`renderQr`、`log`。
- 流程：
  1. `promptSelect` 选 `scan` / `manual`。
  2. scan：`registration = createRegistration(onCredentials)`；`registration.start({ domain: "feishu" })`；
     循环 `status()`：`qr_ready` 时 `renderQr(url)` 并打印链接；`succeeded` 时跳出（凭据在 `onCredentials` 收到）；
     `expired` 询问刷新或取消；`error`/`cancelled` 退出；Ctrl+C 调 `registration.cancel()`。
  3. manual：`promptText` 收 App ID / App Secret，默认地区 `feishu`（可输入 `lark`）。
  4. 校验 `verify({ appId, appSecret, domain })`；失败打印错误、`ok:false`、不写。
  5. 重复接入（`settings.channels.feishu.enabled` 且有 `appId`）先 `promptConfirm` 确认覆盖。
  6. 写凭据：`credentials.set(appId, appSecret)`；失败直接 `ok:false`。
  7. 写 settings：用 `loadSettings()` 读取、合并
     `channels.feishu = { ...existing, enabled: true, appId, domain, allowFrom: { ...existing.allowFrom, ...(userId ? { [userId]: userId } : {}) } }`；
     `saveSettings` 失败则尽力 `credentials.delete(appId)` 回滚并 `ok:false`。
  8. 返回 `{ ok: true, appId, domain, name? }`。
- `renderQr` 默认实现用 `qrcode-terminal`：`qrcodeTerminal.generate(url, { small: true })`；
  非 TTY 时只打印链接。
- `runChannelsAllow(id, name?, deps?)`：
  - 校验 `/^(ou_|oc_)/`，否则 `ok:false`；
  - `loadSettings()`，若无 `channels.feishu.appId` → `ok:false` 提示先 add；
  - 合并 `allowFrom = { ...existing, [name ?? id]: id }`，`saveSettings`；
  - 返回 `{ ok: true }`。

- [ ] **步骤 5：接线命令与 serve**

`apps/cli/src/commands/channels.ts`：

- `createChannelsCommand()` 增加：
  - `.command("add").argument("<channel>").action(...)`：仅支持 `feishu`；调 `runChannelsAddFeishu()`；
  - `.command("allow").argument("<id>").option("--name <name>")`：调 `runChannelsAllow(id, name)`。
- `runChannelsServe` 的 `ChannelManager` options 增加：

```ts
    onDenied: ({ sender }) => {
      console.warn(
        `[channels] 如需放行 ${sender}：vk channels allow ${sender}（改完重启 channels serve）`,
      );
    },
```

- [ ] **步骤 6：运行确认通过**

运行：
```
pnpm --filter @rzx/ohs test -- --run src/commands/channels-onboarding.test.ts src/commands/channels.test.ts
pnpm --filter @rzx/ohs check-types
```
预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add apps/cli/package.json pnpm-lock.yaml apps/cli/src/commands/channels-onboarding.ts apps/cli/src/commands/channels-onboarding.test.ts apps/cli/src/commands/channels.ts apps/cli/src/commands/channels.test.ts
git commit -m "feat(cli): add feishu scan onboarding and allow command"
```

---

## 任务 8：阶段完整验证

**文件：** 无（仅验证）

- [ ] **步骤 1：相关包全量测试**

```bash
pnpm --filter @vykor/channels test -- --run
pnpm --filter @vykor/auth test -- --run
pnpm --filter @vykor/core test -- --run
pnpm --filter @vykor/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
```

预期：全部通过。

- [ ] **步骤 2：类型检查**

```bash
pnpm --filter @vykor/channels check-types
pnpm --filter @vykor/auth check-types
pnpm --filter @vykor/core check-types
pnpm --filter @vykor/tools check-types
pnpm --filter @rzx/ohs check-types
```

预期：退出码 0。

- [ ] **步骤 3：全仓构建**

```bash
pnpm exec turbo build --output-logs=full
```

预期：全部成功。

- [ ] **步骤 4：严格扫描**

```powershell
rg -n -g '!**/*.test.ts' -g '!**/__test__/**' "appSecret" packages/channels/src packages/core/src packages/tools/src apps/cli/src
```

预期：`settings.channels.feishu.appSecret` 的读取已不存在；出现处只能是凭据存储内部或类型无关的字段名。人工确认无“从 settings 读旧密钥”的路径。

- [ ] **步骤 5：diff 与工作区**

```bash
git diff --check
git status --short
```

预期：无格式错误；工作区只剩本阶段改动。

- [ ] **步骤 6：手工验收（人工执行一次，记录结果）**

`vk channels add feishu` → 扫码/手填 → 校验通过 → 凭据文件与 settings 正确写入 →
`vk channels serve` 能收发一条私聊消息 → `vk channels allow ou_xxx` 写入白名单。

---

## 阶段完成标准

- `vk channels add feishu` 支持扫码（默认）与手填，两者都当场校验。
- 密钥只落 `channel-credentials.json`；`settings.json` 不再承载 `appSecret`，但旧键不会导致加载失败。
- `vk channels serve` 从凭据文件读 secret、透传 domain。
- `vk channels allow` 支持 `ou_`/`oc_`，ACL 按发送者或会话放行；被拒时有 `vk channels allow` 提示。
- `FeishuPush` 改为读凭据文件。
- 相关包测试、类型检查、全仓构建、`git diff --check` 全绿。
- 无任何兼容性 fallback。
