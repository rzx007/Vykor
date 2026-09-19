# 渠道配置统一到单一文件实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把渠道的全部配置（含密钥）收敛到 `~/.openharness-ts/channel-credentials.json`，从 `settings.json` 硬切移除 `channels`，并让 `sendProgress/sendToolHints` 按渠道生效。

**架构：** `packages/auth` 新增 `ChannelConfigStore`（v2 文件结构，复用原子写/锁/0600）。CLI、`FeishuPush` 全部改读它；`ChannelManager` 新增按渠道策略；最后从 `packages/core` 删除 `settings.channels`。

**技术栈：** TypeScript、Vitest、pnpm workspace、node:fs/promises。

## Global Constraints

- 渠道配置只存在 `channel-credentials.json`；`settings.json` 不得再承载 `channels`。
- 密钥只在该文件；错误与日志不回显 `appSecret`；POSIX `0600`，Windows 依赖用户目录 ACL（已知限制）。
- 旧 v1 凭据文件视为“未配置渠道”（当空，不报错）。
- `settings.json`（含项目级）出现 `channels` → `SettingsFileError`（有意不兼容）。
- `ohs channels add/allow` 不读写 `settings.json`。
- 不引入兼容 fallback；除上述 v1 当空外不做迁移。
- 只改本计划列出的文件；不触碰 `packages/mcp`、`packages/services`、`packages/server`、`packages/protocol`。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/auth/src/channel-config-store.ts` | 渠道配置读写（v2） | 新建 |
| `packages/auth/src/__test__/channel-config-store.test.ts` | 存储测试 | 新建 |
| `packages/auth/src/index.ts` | 导出新类/类型 | 修改 |
| `packages/channels/src/core/manager.ts` | 按渠道策略 | 修改 |
| `packages/channels/src/__test__/manager.test.ts` | 策略测试 | 修改 |
| `apps/cli/src/commands/channels.ts` | 组装/serve/status 改读 store | 修改 |
| `apps/cli/src/commands/channels.test.ts` | 组装测试改写 | 修改 |
| `apps/cli/src/commands/channels-onboarding.ts` | add/allow 只写 store | 修改 |
| `apps/cli/src/commands/channels-onboarding.test.ts` | 依赖注入改写 | 修改 |
| `packages/tools/src/channels/feishu-push.ts` | 改读 store | 修改 |
| `packages/tools/src/channels/__test__/feishu-push.test.ts` | 工具测试改写 | 修改 |
| `packages/core/src/types/settings.ts` | 删 `channels` | 修改 |
| `packages/core/src/config/settings.ts` | 删白名单段 | 修改 |
| `packages/core/src/config/settings.test.ts` | 硬切断言 | 修改 |
| `packages/core/src/index.ts` | 删旧导出 | 修改 |
| `packages/auth/src/channel-credential-store.ts` | 旧存储 | 删除（任务 5） |
| `packages/auth/src/__test__/channel-credential-store.test.ts` | 旧测试 | 删除（任务 5） |
| `docs/channels-flow.md` 等 | 文档 | 修改 |

---

## 任务 1：新增 `ChannelConfigStore`

**文件：**
- 新建：`packages/auth/src/channel-config-store.ts`
- 测试：`packages/auth/src/__test__/channel-config-store.test.ts`（新建）
- 修改：`packages/auth/src/index.ts`（追加导出，保留旧导出到任务 5）

**Interfaces：**
- Produces：
  - `FeishuDomain`、`FeishuChannelConfig`、`ChannelConfigFile`
  - `class ChannelConfigStore { getFeishu(); setFeishu(config); updateFeishu(mutate); deleteFeishu(); }`
  - `class ChannelConfigStoreError extends Error { code }`

- [ ] **步骤 1：编写失败的测试**

新建 `packages/auth/src/__test__/channel-config-store.test.ts`：

```ts
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ChannelConfigStore } from "../channel-config-store.js";

function tempPath() {
  const directory = mkdtempSync(join(tmpdir(), "ohs-channel-config-"));
  return join(directory, "channel-credentials.json");
}

const feishu = {
  enabled: true,
  appId: "cli_x",
  appSecret: "sec",
  domain: "feishu" as const,
  allowFrom: { 个人: "ou_1" },
};

describe("ChannelConfigStore", () => {
  it("returns undefined for a missing file and round-trips feishu config", async () => {
    const store = new ChannelConfigStore(tempPath());
    expect(await store.getFeishu()).toBeUndefined();
    await store.setFeishu(feishu);
    expect(await store.getFeishu()).toEqual(feishu);
  });

  it("treats a legacy v1 credentials file as no channel configured", async () => {
    const path = tempPath();
    writeFileSync(path, JSON.stringify({ version: 1, credentials: { cli_old: { appSecret: "old" } } }));
    const store = new ChannelConfigStore(path);
    expect(await store.getFeishu()).toBeUndefined();
  });

  it("rejects an invalid file shape", async () => {
    const path = tempPath();
    writeFileSync(path, "{ not json");
    const store = new ChannelConfigStore(path);
    await expect(store.getFeishu()).rejects.toMatchObject({
      name: "ChannelConfigStoreError",
      code: "invalid-channel-config-store",
    });
  });

  it("normalizes a missing domain to feishu", async () => {
    const path = tempPath();
    await new ChannelConfigStore(path).setFeishu({ ...feishu, domain: "feishu" });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number };
    expect(raw.version).toBe(2);
  });

  it("updateFeishu creates, mutates, and deletes", async () => {
    const store = new ChannelConfigStore(tempPath());
    await store.updateFeishu(() => feishu);
    expect(await store.getFeishu()).toEqual(feishu);
    await store.updateFeishu((current) => (current ? { ...current, allowFrom: { 群: "oc_1" } } : current));
    expect((await store.getFeishu())?.allowFrom).toEqual({ 群: "oc_1" });
    await store.updateFeishu(() => undefined);
    expect(await store.getFeishu()).toBeUndefined();
    expect(await store.deleteFeishu()).toBe(false);
  });

  it("rejects unsafe allowFrom keys", async () => {
    const store = new ChannelConfigStore(tempPath());
    await expect(
      store.setFeishu({ ...feishu, allowFrom: { __proto__: "ou_1" } }),
    ).rejects.toMatchObject({ code: "invalid-channel-config-store" });
  });

  it("serializes concurrent writes without losing data", async () => {
    const store = new ChannelConfigStore(tempPath());
    await store.setFeishu(feishu);
    await Promise.all([
      store.updateFeishu((c) => (c ? { ...c, sendProgress: false } : c)),
      store.updateFeishu((c) => (c ? { ...c, sendToolHints: false } : c)),
    ]);
    const result = await store.getFeishu();
    expect(result?.sendProgress).toBe(false);
    expect(result?.sendToolHints).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @openharness/auth test -- --run src/__test__/channel-config-store.test.ts`
预期：FAIL，模块不存在。

- [ ] **步骤 3：实现**

新建 `packages/auth/src/channel-config-store.ts`（保留旧文件的 `read`/`write`/`withLock`/`isStaleLock` 机制，换结构与方法）：

```ts
import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { dirname } from "node:path";

import { getChannelCredentialsFilePath } from "@openharness/core";

export type FeishuDomain = "feishu" | "lark";

export interface FeishuChannelConfig {
  enabled: boolean;
  appId: string;
  appSecret: string;
  domain: FeishuDomain;
  allowFrom: Record<string, string>;
  replyAtBotNames?: string[];
  sendProgress?: boolean;
  sendToolHints?: boolean;
}

export interface ChannelConfigFile {
  version: 2;
  channels: { feishu?: FeishuChannelConfig };
}

export class ChannelConfigStoreError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "ChannelConfigStoreError";
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function invalid(filePath: string, detail: string): ChannelConfigStoreError {
  return new ChannelConfigStoreError(
    "invalid-channel-config-store",
    `Channel config file is invalid (${detail}): ${filePath}`,
  );
}

function normalizeDomain(value: unknown, filePath: string): FeishuDomain {
  if (value === undefined || value === "feishu") return "feishu";
  if (value === "lark") return "lark";
  throw invalid(filePath, "domain");
}

function normalizeAllowFrom(value: unknown, filePath: string): Record<string, string> {
  if (!isRecord(value)) throw invalid(filePath, "allowFrom");
  const allowFrom: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key) || key.length === 0 || typeof raw !== "string" || raw.length === 0) {
      throw invalid(filePath, "allowFrom entry");
    }
    allowFrom[key] = raw;
  }
  return allowFrom;
}

function normalizeFeishu(value: unknown, filePath: string): FeishuChannelConfig {
  if (!isRecord(value)) throw invalid(filePath, "feishu");
  if (typeof value.enabled !== "boolean") throw invalid(filePath, "enabled");
  if (typeof value.appId !== "string" || value.appId.length === 0) throw invalid(filePath, "appId");
  if (typeof value.appSecret !== "string" || value.appSecret.length === 0) throw invalid(filePath, "appSecret");
  const replyAtBotNames = value.replyAtBotNames;
  if (
    replyAtBotNames !== undefined &&
    (!Array.isArray(replyAtBotNames) || !replyAtBotNames.every((n) => typeof n === "string"))
  ) {
    throw invalid(filePath, "replyAtBotNames");
  }
  for (const flag of ["sendProgress", "sendToolHints"] as const) {
    if (value[flag] !== undefined && typeof value[flag] !== "boolean") throw invalid(filePath, flag);
  }
  return {
    enabled: value.enabled,
    appId: value.appId,
    appSecret: value.appSecret,
    domain: normalizeDomain(value.domain, filePath),
    allowFrom: normalizeAllowFrom(value.allowFrom, filePath),
    ...(replyAtBotNames !== undefined ? { replyAtBotNames: replyAtBotNames as string[] } : {}),
    ...(value.sendProgress !== undefined ? { sendProgress: value.sendProgress as boolean } : {}),
    ...(value.sendToolHints !== undefined ? { sendToolHints: value.sendToolHints as boolean } : {}),
  };
}

export class ChannelConfigStore {
  constructor(
    private readonly filePath = getChannelCredentialsFilePath(),
    private readonly clock = () => Date.now(),
  ) {}

  async getFeishu(): Promise<FeishuChannelConfig | undefined> {
    return this.withLock(async () => (await this.read()).channels.feishu);
  }

  async setFeishu(config: FeishuChannelConfig): Promise<void> {
    await this.withLock(async () => {
      const file = await this.read();
      file.channels.feishu = normalizeFeishu(config, this.filePath);
      await this.write(file);
    });
  }

  async updateFeishu(
    mutate: (current: FeishuChannelConfig | undefined) => FeishuChannelConfig | undefined,
  ): Promise<FeishuChannelConfig | undefined> {
    return this.withLock(async () => {
      const file = await this.read();
      const next = mutate(file.channels.feishu);
      if (next === undefined) {
        delete file.channels.feishu;
      } else {
        file.channels.feishu = normalizeFeishu(next, this.filePath);
      }
      await this.write(file);
      return file.channels.feishu;
    });
  }

  async deleteFeishu(): Promise<boolean> {
    return this.withLock(async () => {
      const file = await this.read();
      if (!file.channels.feishu) return false;
      delete file.channels.feishu;
      await this.write(file);
      return true;
    });
  }

  private async read(): Promise<ChannelConfigFile> {
    let raw: string;
    try {
      raw = await readFile(this.filePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 2, channels: {} };
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw invalid(this.filePath, "json");
    }
    if (!isRecord(parsed)) throw invalid(this.filePath, "root");
    // 旧 v1 凭据文件（只有 appSecret）视为未配置渠道。
    if (parsed.version === 1) return { version: 2, channels: {} };
    if (parsed.version !== 2 || !isRecord(parsed.channels)) throw invalid(this.filePath, "version");
    const channels: ChannelConfigFile["channels"] = {};
    if (parsed.channels.feishu !== undefined) {
      channels.feishu = normalizeFeishu(parsed.channels.feishu, this.filePath);
    }
    return { version: 2, channels };
  }

  private async write(value: ChannelConfigFile): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporaryPath, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value, null, 2), "utf8");
    } finally {
      await handle.close();
    }
    if (process.platform !== "win32") await chmod(temporaryPath, 0o600);
    try {
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  }

  private async withLock<T>(operation: () => Promise<T>): Promise<T> {
    const lockPath = `${this.filePath}.lock`;
    await mkdir(dirname(this.filePath), { recursive: true });
    const startedAt = this.clock();
    while (true) {
      try {
        const handle = await open(lockPath, "wx", 0o600);
        try {
          await handle.writeFile(
            JSON.stringify({ pid: process.pid, createdAt: this.clock() }),
            "utf8",
          );
          return await operation();
        } finally {
          await handle.close().catch(() => undefined);
          await rm(lockPath, { force: true }).catch(() => undefined);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (await isStaleLock(lockPath, this.clock())) {
          await rm(lockPath, { force: true }).catch(() => undefined);
          continue;
        }
        if (this.clock() - startedAt >= 10_000) {
          throw new ChannelConfigStoreError(
            "channel-config-lock-timeout",
            "Timed out waiting for channel config lock",
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }
}

async function isStaleLock(path: string, now: number): Promise<boolean> {
  try {
    const info = await stat(path);
    if (now - info.mtimeMs <= 30_000) return false;
    const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: number };
    if (!Number.isInteger(parsed.pid)) return false;
    try {
      process.kill(parsed.pid!, 0);
      return false;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH";
    }
  } catch {
    return false;
  }
}
```

`packages/auth/src/index.ts` 追加（旧导出保留到任务 5）：

```ts
export {
  ChannelConfigStore,
  ChannelConfigStoreError,
} from "./channel-config-store";
export type { FeishuChannelConfig, ChannelConfigFile, FeishuDomain } from "./channel-config-store";
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @openharness/auth test -- --run src/__test__/channel-config-store.test.ts` 与 `pnpm --filter @openharness/auth check-types`
预期：PASS / 退出码 0。

- [ ] **步骤 5：Commit**

```bash
git add packages/auth/src/channel-config-store.ts packages/auth/src/__test__/channel-config-store.test.ts packages/auth/src/index.ts
git commit -m "feat(auth): add v2 channel config store"
```

---

## 任务 2：CLI 改读 `ChannelConfigStore`（组装与 add/allow）

**文件：**
- 修改：`apps/cli/src/commands/channels.ts`
- 修改：`apps/cli/src/commands/channels.test.ts`
- 修改：`apps/cli/src/commands/channels-onboarding.ts`
- 修改：`apps/cli/src/commands/channels-onboarding.test.ts`

**Interfaces：**
- Consumes：任务 1 的 `ChannelConfigStore`、`FeishuChannelConfig`。
- Produces：
  - `AssembledChannels` 增加 `policies: Record<string, { sendProgress?: boolean; sendToolHints?: boolean }>`
  - `assembleChannelAdapters(store: ChannelConfigStore): Promise<AssembledChannels>`（`channels` 参数消失）
  - `ChannelsOnboardingDeps`/`ChannelsAllowDeps` 用 `createChannels()` 取代 `loadSettings`/`saveSettings`/`createCredentials`

- [ ] **步骤 1：改写测试（先红）**

`apps/cli/src/commands/channels.test.ts`：把 `vi.mock("@openharness/core", …)` 里的 `loadSettings` 去掉（或保留空对象，不再使用），把 `vi.mock("@openharness/auth", …)` 换成 `ChannelConfigStore`：

```ts
const configured = vi.hoisted(() => ({ feishu: undefined as unknown }));
vi.mock("@openharness/auth", () => ({
  ChannelConfigStore: class {
    async getFeishu() {
      return configured.feishu;
    }
    async setFeishu() {}
    async updateFeishu() {
      return configured.feishu;
    }
    async deleteFeishu() {
      return false;
    }
  },
}));
```

`assembleChannelAdapters` 用例改为按 store 行为断言：无配置 → 空；`{enabled:false}` → 空；
`{enabled:true, appId, domain, allowFrom}` → 组装 + `allowFrom` + `accountIds` + `policies`。
`channels status` 用例改为 mock `getFeishu` 返回配置，断言仍打印 `daemon: ready`。

`apps/cli/src/commands/channels-onboarding.test.ts`：把 `createCredentials` 换成 `createChannels`，
断言 `setFeishu` 收到完整 `FeishuChannelConfig`、`updateFeishu` 用于 allow；删除“跨文件回滚”用例
（单文件写入后不再有回滚）。

- [ ] **步骤 2：运行确认失败**

运行：`pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts src/commands/channels-onboarding.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现**

`apps/cli/src/commands/channels.ts`：

- 顶部 import 改为 `import { ChannelConfigStore } from "@openharness/auth";`（删 `Settings`/`ChannelsConfig` 里只用于 channels 的部分；`Settings` 仍用于 `settings.model`）。
- `AssembledChannels` 增加 `policies`。
- `assembleChannelAdapters` 签名改为 `(store: ChannelConfigStore = new ChannelConfigStore())`，
  读 `const feishu = await store.getFeishu()`；enabled 时组装 adapter（配置已含 `appSecret/domain`）、
  填 `allowFrom/accountIds/policies`。
- `runChannelsServe`：`const { adapters, allowFrom, accountIds, policies, warnings } = await assembleChannelAdapters(store);`
  `ChannelManager` options 传 `channelPolicies: policies`，删掉 `sendProgress`/`sendToolHints`（不再从 settings 取）。
- `status`：`const feishu = await store.getFeishu();`（删 `loadSettings().channels` 读取）。

`apps/cli/src/commands/channels-onboarding.ts`：

- `CredentialStoreLike` → `ChannelConfigStoreLike`（`getFeishu/setFeishu/updateFeishu`）。
- `ChannelsOnboardingDeps` 删 `createCredentials`/`loadSettings`/`saveSettings`，加 `createChannels()`；
  `ChannelsAllowDeps` 删 `loadSettings`/`saveSettings`，加 `createChannels()`。
- `createDefaultOnboardingDeps`/`createDefaultAllowDeps` 的 `createChannels` 动态 import `ChannelConfigStore`。
- `runChannelsAddFeishu`：删 `loadSettings`/`set`/`delete` 逻辑；`existing = await store.getFeishu()`；
  已有 `existing?.appId` 时 `promptConfirm` 覆盖确认；`next: FeishuChannelConfig = { ...existing, enabled: true, appId, appSecret, domain, allowFrom }`；
  `await store.setFeishu(next)`；保留原有收尾提示。
- `runChannelsAllow`：`feishu = await store.getFeishu()`；无 `appId` 报错；
  `await store.updateFeishu((current) => current ? { ...current, allowFrom: { ...current.allowFrom, [name ?? id]: id } } : current)`。

- [ ] **步骤 4：运行确认通过**

运行：
```bash
pnpm --filter @rzx/ohs test -- --run src/commands/channels.test.ts src/commands/channels-onboarding.test.ts
pnpm --filter @rzx/ohs check-types
```
预期：PASS / 退出码 0。

- [ ] **步骤 5：Commit**

```bash
git add apps/cli/src/commands/channels.ts apps/cli/src/commands/channels.test.ts apps/cli/src/commands/channels-onboarding.ts apps/cli/src/commands/channels-onboarding.test.ts
git commit -m "feat(cli): read channel config from the unified store"
```

---

## 任务 3：`FeishuPush` 改读 store

**文件：**
- 修改：`packages/tools/src/channels/feishu-push.ts`
- 修改：`packages/tools/src/channels/__test__/feishu-push.test.ts`（若存在）

**Interfaces：**
- Consumes：任务 1 的 `ChannelConfigStore`。

- [ ] **步骤 1：改写测试（先红）**

把测试改为注入/模拟 `ChannelConfigStore.getFeishu()`（配置里带 `appId/appSecret/domain/allowFrom`），
断言：缺配置 → `isError`；lark domain → 请求 `open.larksuite.com`；目标存在 → 发送请求体正确。
（若当前测试直接读 settings，先删掉那部分。）

- [ ] **步骤 2：运行确认失败**

运行：`pnpm --filter @openharness/tools test -- --run src/channels/__test__/feishu-push.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现**

`packages/tools/src/channels/feishu-push.ts`：

- 删除 `loadSettings`/`Settings`/`_settingsCache`/`getCachedSettings` 与 `ChannelCredentialStore` 导入。
- 新增 `import { ChannelConfigStore } from "@openharness/auth";`。
- `execute` 内：`const feishu = await new ChannelConfigStore().getFeishu();`
  - `!feishu?.appId` → `Error: 渠道未配置，请先运行 ohs channels add feishu`；
  - `chatId = feishu.allowFrom[target]`（同现有逻辑）；
  - `base = feishuApiBase(feishu.domain)`；
  - `token = await getTenantToken(feishu.appId, feishu.appSecret, abortScope.signal, base)`。
- 更新 `description` 与 `inputSchema` 的 `target` 描述：把 `settings.channels.feishu` 改为
  `channel-credentials.json 的 feishu 渠道配置`。

- [ ] **步骤 4：运行确认通过**

运行：`pnpm --filter @openharness/tools test -- --run src/channels/__test__/feishu-push.test.ts` 与 `pnpm --filter @openharness/tools check-types`
预期：PASS / 退出码 0。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/channels/feishu-push.ts packages/tools/src/channels/__test__/feishu-push.test.ts
git commit -m "feat(tools): read feishu push config from the channel store"
```

---

## 任务 4：`ChannelManager` 按渠道策略

**文件：**
- 修改：`packages/channels/src/core/manager.ts`
- 修改：`packages/channels/src/__test__/manager.test.ts`

**Interfaces：**
- Produces：`ChannelManagerOptions.channelPolicies?: Record<string, { sendProgress?: boolean; sendToolHints?: boolean }>`

- [ ] **步骤 1：编写失败的测试**

在 `manager.test.ts` 增加：

```ts
it("按渠道应用 sendProgress/sendToolHints 策略", async () => {
  const bus = new MessageBus();
  const a = makeAdapter("a");
  const b = makeAdapter("b");
  const mgr = new ChannelManager([a.adapter, b.adapter], bus, {
    allowFrom: { a: ["*"], b: ["*"] },
    channelPolicies: { a: { sendProgress: false }, b: { sendToolHints: false } },
  });
  await mgr.startAll();
  bus.publishOutbound({ channel: "a", chatId: "c", content: "p", metadata: { _progress: true } });
  bus.publishOutbound({ channel: "a", chatId: "c", content: "h", metadata: { _progress: true, _tool_hint: true } });
  bus.publishOutbound({ channel: "b", chatId: "c", content: "p", metadata: { _progress: true } });
  bus.publishOutbound({ channel: "b", chatId: "c", content: "h", metadata: { _progress: true, _tool_hint: true } });
  await tick();
  expect(a.sent.map((m) => m.content)).toEqual(["h"]); // a 关 progress、放 tool hint
  expect(b.sent.map((m) => m.content)).toEqual(["p"]); // b 关 tool hint、放 progress
  await mgr.stopAll();
});
```

- [ ] **步骤 2：运行确认失败**

运行：`pnpm --filter @openharness/channels test -- --run src/__test__/manager.test.ts`
预期：FAIL。

- [ ] **步骤 3：实现**

`manager.ts`：

- `ChannelManagerOptions` 增加 `channelPolicies`。
- 进度过滤改为：

```ts
      const meta = msg.metadata ?? {};
      if (meta["_progress"]) {
        const policy = this.opts.channelPolicies?.[msg.channel];
        const sendProgress = policy?.sendProgress ?? this.opts.sendProgress;
        const sendToolHints = policy?.sendToolHints ?? this.opts.sendToolHints;
        const isToolHint = Boolean(meta["_tool_hint"]);
        if (isToolHint && sendToolHints === false) continue;
        if (!isToolHint && sendProgress === false) continue;
      }
```

- [ ] **步骤 4：运行确认通过**

运行：`pnpm --filter @openharness/channels test -- --run` 与 `pnpm --filter @openharness/channels check-types`
预期：PASS / 退出码 0。

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/core/manager.ts packages/channels/src/__test__/manager.test.ts
git commit -m "feat(channels): allow per-channel progress policy"
```

---

## 任务 5：`settings.json` 硬切 + 删除旧存储

**文件：**
- 修改：`packages/core/src/types/settings.ts`
- 修改：`packages/core/src/config/settings.ts`
- 修改：`packages/core/src/config/settings.test.ts`
- 修改：`packages/core/src/index.ts`
- 删除：`packages/auth/src/channel-credential-store.ts`
- 删除：`packages/auth/src/__test__/channel-credential-store.test.ts`
- 修改：`packages/auth/src/index.ts`（删旧导出）

- [ ] **步骤 1：改写测试（先红）**

`settings.test.ts`：删除 `"accepts legacy feishu secret fields without deleting them"` 用例，
新增：

```ts
it("rejects the removed channels field", async () => {
  writeFileSync(join(configDir, "settings.json"), JSON.stringify({
    channels: { feishu: { enabled: true, appId: "cli_x", allowFrom: {} } },
  }));
  await expect(loadSettings()).rejects.toMatchObject({
    name: "SettingsFileError",
    field: "settings.channels",
  });
});
```

- [ ] **步骤 2：运行确认失败**

运行：`pnpm --filter @openharness/core test -- --run src/config/settings.test.ts`
预期：新增用例 FAIL（当前仍接受 `channels`）。

- [ ] **步骤 3：实现**

- `packages/core/src/types/settings.ts`：删除 `FeishuChannelSettings`、`ChannelsConfig` 与 `Settings.channels`。
- `packages/core/src/config/settings.ts`：顶层 allowed 列表删 `"channels"`；删除 `assertNestedFields(settings, "channels", …)` 与其内层 `feishu` 白名单整段（含旧键容忍）。
- `packages/core/src/index.ts`：删除 `ChannelsConfig`、`FeishuChannelSettings` 导出（保留 `getChannelCredentialsFilePath`）。
- 删除 `packages/auth/src/channel-credential-store.ts` 与其测试；`packages/auth/src/index.ts` 删除 `ChannelCredentialStore`/`ChannelCredentialStoreError` 导出。

- [ ] **步骤 4：运行确认通过**

运行：
```bash
pnpm --filter @openharness/core test -- --run
pnpm --filter @openharness/core check-types
pnpm --filter @openharness/auth test -- --run
pnpm --filter @openharness/auth check-types
pnpm --filter @rzx/ohs check-types
pnpm --filter @openharness/tools check-types
```
预期：全部通过（此时已无 `settings.channels` 消费者）。

- [ ] **步骤 5：Commit**

```bash
git add -A packages/core/src packages/auth/src
git commit -m "refactor: remove channels from settings and drop the legacy credential store"
```

---

## 任务 6：文档同步

**文件：** `docs/channels-flow.md`、`README.md`、`docs/security-and-trust-boundaries.md`、
`docs/development-data-reset.md`、`docs/context-memory-map.md`、
`docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md`、`PLAN-REMAINING.md`

- [ ] **步骤 1：更新**

- `docs/channels-flow.md`：配置示例改为 `channel-credentials.json`（含 enabled/appId/appSecret/domain/allowFrom/replyAtBotNames/sendProgress/sendToolHints）；删掉失效的 `_formatVersion`；说明 `settings.json` 不再含 `channels`。
- `README.md`：渠道条目与命令说明提到“配置在 channel-credentials.json”。
- `docs/security-and-trust-boundaries.md`：渠道配置与密钥同文件、0600、Windows 限制。
- `docs/development-data-reset.md` / `docs/context-memory-map.md`：`channel-credentials.json` 说明补“含渠道配置与密钥”。
- `docs/superpowers/handoffs/2026-09-18-desktop-channel-onboarding-handoff.md`：删“settings 只留非敏感项”的过期描述。
- `PLAN-REMAINING.md`：更新仍写 `settings.channels` 的条目。

- [ ] **步骤 2：校验**

运行：`pnpm check-docs` 与 `git diff --check`
预期：通过。

- [ ] **步骤 3：Commit**

```bash
git add docs README.md PLAN-REMAINING.md
git commit -m "docs: document the unified channel config file"
```

---

## 任务 7：阶段完整验证

**文件：** 无（仅验证）

- [ ] **步骤 1：相关包全量测试**

```bash
pnpm --filter @openharness/auth test -- --run
pnpm --filter @openharness/core test -- --run
pnpm --filter @openharness/channels test -- --run
pnpm --filter @openharness/tools test -- --run
pnpm --filter @rzx/ohs test -- --run
```

- [ ] **步骤 2：类型检查**

```bash
pnpm --filter @openharness/auth check-types
pnpm --filter @openharness/core check-types
pnpm --filter @openharness/channels check-types
pnpm --filter @openharness/tools check-types
pnpm --filter @rzx/ohs check-types
```

- [ ] **步骤 3：全仓构建**

```bash
pnpm exec turbo build --output-logs=full
```

- [ ] **步骤 4：残留扫描**

```bash
rg -n "settings\.channels|settings\?\.channels|ChannelsConfig|FeishuChannelSettings|ChannelCredentialStore" packages apps --glob '*.ts'
```
预期：除历史 `docs/superpowers/specs|plans` 文本外，无生产代码命中。

- [ ] **步骤 5：diff 与工作区**

```bash
git diff --check
git status --short
```

- [ ] **步骤 6：手工验收（人工执行一次）**

1. 删除本机 `settings.json` 里的 `channels` 段；
2. `ohs channels add feishu`（扫码或手填）→ 写入 `channel-credentials.json`（v2）；
3. `ohs channels status` 显示已配置；
4. `ohs channels serve` 收发一条消息；
5. `ohs channels allow ou_xxx` 生效。

---

## 阶段完成标准

- `settings.json` 不再有 `channels`；出现即 `SettingsFileError`。
- 渠道配置（含密钥）只在 `channel-credentials.json`；v1 文件当空。
- `sendProgress/sendToolHints` 按渠道生效。
- `add/allow` 不读写 settings；`FeishuPush` 读同一 store。
- 相关包测试、类型检查、全仓构建、`check-docs`、`git diff --check` 全绿。
- 无兼容 fallback（v1 当空除外）。
