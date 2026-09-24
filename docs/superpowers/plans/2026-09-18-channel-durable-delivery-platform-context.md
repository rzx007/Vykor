# 通道 durable 出站平台上下文（线程回复贯通）实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 channels 的 durable 出站消息携带通用 `platformMeta`（Feishu 场景含 `rootMessageId`），使飞书话题里的 Agent 回复能真正落回原话题，而不是被 fail-closed 拒绝。

**架构：** 入站时 adapter 的 `ChannelMessage.platformMeta` 被 manager 复制到 `InboundMessage.platformMeta`，经 DurableChannelBridge 作为 `DurableChannelMessageInput.platformMeta` 交给 server；server 把它写进 `channel_delivery.platform_meta_json`；出站时 `ChannelDeliveryRecord.platformMeta` 被 bridge 放进 `OutboundMessage`，manager 原样转给 adapter。全链路只透传通用对象，Feishu 专属判断仍留在 adapter。

**技术栈：** TypeScript、Vitest、pnpm workspace、Drizzle ORM（SQLite baseline）、MessageBus、ChannelManager、DurableChannelBridge、Feishu Node SDK。

## Global Constraints

- 平台语义不泄漏：通用层只透传 `platformMeta`，Feishu 的 `rootMessageId` 规则只在 adapter。
- 不降级：image 不得降级 text/file；file 不得降级 text；thread 不得降级普通 chat。
- 不伪造：缺失 `message_id`/`sender`/`chat_id`/media key/root message id 时直接拒绝；不得用 sender、chatId、随机 id 或当前时间补造平台字段。
- `ChannelMessage.threadId` 保存 Feishu `thread_id`；`platformMeta.rootMessageId` 保存 Feishu `root_id`，二者不得混用。
- `platformMeta` 只允许非空普通对象；数组/标量/`null` 非法；`{}` 视为缺失。
- 协议版本保持 `CURRENT_PROTOCOL_VERSION = 4`（已评审确认，不升级）。
- 数据库沿用 clean-slate 单基线约定：只有一份 `0000_current_schema.sql`，旧库不升级、需重建。
- 禁止任何兼容性 fallback。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/protocol/src/channel.ts` | durable channel 线协议类型与解析 | 修改 |
| `packages/protocol/src/channel.test.ts` | 协议解析测试 | 新建 |
| `packages/channels/src/bus/queue.ts` | `InboundMessage`/`OutboundMessage` | 修改 |
| `packages/channels/src/core/manager.ts` | 入站映射、出站分发 | 修改 |
| `packages/channels/src/core/durable-bridge.ts` | durable 入站转交、出站发布 | 修改 |
| `packages/channels/src/__test__/manager.test.ts` | manager 测试 | 修改 |
| `packages/channels/src/__test__/durable-bridge.test.ts` | bridge 测试 | 修改 |
| `packages/channels/src/__test__/durable-thread-reply.test.ts` | Feishu 线程回复端到端集成测试 | 新建 |
| `packages/services/src/session-runtime/schema.ts` | DB schema | 修改 |
| `packages/services/src/session-runtime/migrations/*` | clean-slate 基线 | 重新生成 |
| `packages/services/src/database/__fixtures__/current-schema-inventory.json` | schema inventory fixture | 重新生成 |
| `packages/services/src/database/session-database.test.ts` | 基线断言 | 修改 |
| `packages/services/src/session-runtime/__test__/store.test.ts` | storage format 断言 | 修改 |
| `packages/services/scripts/check-bundled-baseline.ts` | bundle baseline 断言 | 修改 |
| `packages/services/src/channels/channel-repository.ts` | delivery 写入 | 修改 |
| `packages/services/src/channels/channel-records.ts` | 行 ↔ 记录映射 | 修改 |
| `packages/services/src/channels/channel-repository.test.ts` | 仓储测试 | 修改 |
| `packages/server/src/application/channel/channel-application-service.ts` | server 应用服务 | 修改 |
| `packages/server/src/application/channel/__test__/channel-application-service.test.ts` | server 测试 | 修改 |

---

## 任务 1：protocol 增加 platformMeta

**文件：**
- 修改：`packages/protocol/src/channel.ts`
- 测试：`packages/protocol/src/channel.test.ts`（新建）

**Interfaces：**
- Produces：
  - `ChannelDeliveryRecord.platformMeta?: Record<string, unknown>`
  - `DurableChannelMessageInput.platformMeta?: Record<string, unknown>`
  - `parseDurableChannelMessageInput(value)`：解析非空普通对象 `platformMeta`；数组/标量/`null` 抛错，错误信息含 ` must be `；`{}` 视为缺失。

- [ ] **步骤 1：编写失败的测试**

新建 `packages/protocol/src/channel.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { parseDurableChannelMessageInput } from "./channel.js";

const base = {
  connector: "feishu",
  accountId: "app-1",
  chatId: "chat-1",
  externalMessageId: "msg-1",
  senderId: "ou-1",
  content: "hello",
  cwd: "/repo",
  model: "model-1",
};

describe("parseDurableChannelMessageInput platformMeta", () => {
  it("keeps a non-empty plain object platformMeta", () => {
    const parsed = parseDurableChannelMessageInput({
      ...base,
      platformMeta: { rootMessageId: "msg_root", chatType: "group" },
    });
    expect(parsed.platformMeta).toEqual({
      rootMessageId: "msg_root",
      chatType: "group",
    });
  });

  it("omits platformMeta when absent or empty", () => {
    expect(parseDurableChannelMessageInput({ ...base })).not.toHaveProperty(
      "platformMeta",
    );
    expect(
      parseDurableChannelMessageInput({ ...base, platformMeta: {} }),
    ).not.toHaveProperty("platformMeta");
  });

  it.each([
    ["array", []],
    ["string", "root"],
    ["number", 1],
    ["boolean", true],
    ["null", null],
  ])("rejects %s platformMeta", (_label, value) => {
    expect(() =>
      parseDurableChannelMessageInput({ ...base, platformMeta: value }),
    ).toThrow(/ must be /);
  });
});
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/protocol test -- --run src/channel.test.ts`
预期：FAIL，`platformMeta` 字段不存在、非法输入不抛错。

- [ ] **步骤 3：最小实现**

在 `packages/protocol/src/channel.ts`：

1. `ChannelDeliveryRecord` 增加：

```ts
  platformMeta?: Record<string, unknown>;
```

2. `DurableChannelMessageInput` 增加：

```ts
  platformMeta?: Record<string, unknown>;
```

3. 在文件底部 `optional` 辅助函数附近新增：

```ts
/**
 * 只接受非空普通对象；undefined 视为缺失，null/数组/标量抛错。
 * 空对象按缺失处理。
 */
function optionalObject(
  row: Record<string, unknown>,
  field: string,
): Record<string, unknown> | undefined {
  const value = row[field];
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const object = value as Record<string, unknown>;
  return Object.keys(object).length > 0 ? object : undefined;
}
```

4. `parseDurableChannelMessageInput`：在 `const row = record(value);` 之后加一行，并在返回对象 `metadata` 之前加一行：

```ts
  const platformMeta = optionalObject(row, "platformMeta");
```

```ts
    ...(platformMeta ? { platformMeta } : {}),
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/protocol test -- --run src/channel.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/protocol/src/channel.ts packages/protocol/src/channel.test.ts
git commit -m "feat(protocol): carry platformMeta on durable channel delivery"
```

---

## 任务 2：channels runtime 透传 platformMeta

**文件：**
- 修改：`packages/channels/src/bus/queue.ts`
- 修改：`packages/channels/src/core/manager.ts`
- 修改：`packages/channels/src/core/durable-bridge.ts`
- 测试：`packages/channels/src/__test__/manager.test.ts`
- 测试：`packages/channels/src/__test__/durable-bridge.test.ts`

**Interfaces：**
- Consumes：任务 1 的 `DurableChannelMessageInput.platformMeta`。
- Produces：
  - `InboundMessage.platformMeta?: Record<string, unknown>`
  - `ChannelManager.handleInbound` 复制 `msg.platformMeta`
  - bridge `handle` 转交 `platformMeta`；`publish` 把 `delivery.platformMeta` 放进 outbound

- [ ] **步骤 1：编写失败的测试**

在 `packages/channels/src/__test__/manager.test.ts` 的 `describe("ChannelManager")` 内追加：

```ts
  it("preserves platformMeta on the inbound message", async () => {
    const bus = new MessageBus();
    const fake = makeAdapter("t");
    const mgr = new ChannelManager([fake.adapter], bus, {
      allowFrom: { t: ["*"] },
    });
    await mgr.startAll();

    fake.emit({
      chatId: "chat-1",
      platformMeta: { rootMessageId: "msg_root", chatType: "group" },
    });
    const inbound = await bus.consumeInbound();

    expect(inbound.platformMeta).toEqual({
      rootMessageId: "msg_root",
      chatType: "group",
    });
    await mgr.stopAll();
  });
```

在 `packages/channels/src/__test__/durable-bridge.test.ts` 的 `describe("DurableChannelBridge")` 内追加：

```ts
  it("passes inbound platformMeta to the durable application", async () => {
    const bus = new MessageBus();
    const application = port();
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    bridge.start();

    bus.publishInbound({
      channel: "feishu",
      accountId: "app-1",
      externalMessageId: "message-1",
      senderId: "user-1",
      chatId: "chat-1",
      content: "question",
      timestamp: new Date(0),
      media: [],
      metadata: {},
      platformMeta: { rootMessageId: "msg_root" },
    });

    await vi.waitFor(() => {
      expect(application.handleChannelMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          platformMeta: { rootMessageId: "msg_root" },
        }),
      );
    });
    await bridge.stop();
  });

  it("forwards delivery platformMeta to outbound so the thread root survives", async () => {
    const bus = new MessageBus();
    const application = port({
      listPendingChannelDeliveries: vi.fn(async () => [
        delivery({
          id: "delivery-root",
          content: "thread reply",
          threadId: "thread_1",
          platformMeta: { rootMessageId: "msg_root" },
        }),
      ]),
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
      connectors: ["feishu"],
    });
    bridge.start();

    await expect(bus.consumeOutbound()).resolves.toMatchObject({
      content: "thread reply",
      threadId: "thread_1",
      platformMeta: { rootMessageId: "msg_root" },
    });
    await bridge.stop();
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/channels test -- --run src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：FAIL，`InboundMessage` 无 `platformMeta`；bridge 不传/不转发。

- [ ] **步骤 3：最小实现**

1. `packages/channels/src/bus/queue.ts` 的 `InboundMessage` 增加（放在 `messageType` 附近）：

```ts
  platformMeta?: Record<string, unknown>;
```

2. `packages/channels/src/core/manager.ts` 的 `handleInbound` 构造 `inbound` 时，在 `...(msg.threadId ? { threadId: msg.threadId } : {}),` 之后加：

```ts
      ...(msg.platformMeta ? { platformMeta: msg.platformMeta } : {}),
```

3. `packages/channels/src/core/durable-bridge.ts` 的 `handle` 里 `handleChannelMessage({...})` 参数中，在 `metadata,` 之前加：

```ts
      platformMeta: message.platformMeta,
```

4. 同文件 `publish` 里，把现有的注释与转发替换为：

```ts
  private publish(delivery: ChannelDeliveryRecord): void {
    this.deps.bus.publishOutbound({
      channel: delivery.connector,
      chatId: delivery.chatId,
      content: delivery.content,
      // 平台路由上下文必须透传：缺失时不得静默降级成普通 chat。
      ...(delivery.platformMeta ? { platformMeta: delivery.platformMeta } : {}),
      // 线程标识单独透传；rootMessageId 在 platformMeta 内。
      ...(delivery.threadId ? { threadId: delivery.threadId } : {}),
      metadata: {
        _delivery_id: delivery.id,
        _session_id: delivery.sessionId,
        _run_id: delivery.runId,
      },
    });
  }
```

（这一步同时删除旧注释「rootMessageId 不在 durable delivery 协议内…」。）

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/channels test -- --run src/__test__/manager.test.ts src/__test__/durable-bridge.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/channels/src/bus/queue.ts packages/channels/src/core/manager.ts packages/channels/src/core/durable-bridge.ts packages/channels/src/__test__/manager.test.ts packages/channels/src/__test__/durable-bridge.test.ts
git commit -m "feat(channels): propagate platformMeta through the durable runtime"
```

---

## 任务 3：services DB 基线加入 platform_meta_json

**文件：**
- 修改：`packages/services/src/session-runtime/schema.ts`
- 重新生成：`packages/services/src/session-runtime/migrations/0000_current_schema.sql`、`meta/_journal.json`、`meta/0000_snapshot.json`
- 重新生成：`packages/services/src/database/__fixtures__/current-schema-inventory.json`
- 修改：`packages/services/src/database/session-database.test.ts`
- 修改：`packages/services/src/session-runtime/__test__/store.test.ts`
- 修改：`packages/services/scripts/check-bundled-baseline.ts`

**Interfaces：**
- Produces：`channel_delivery.platform_meta_json`（可空 text），storage format version `3`。

> 该任务机械性强、破坏性大：严格按顺序执行，每步验证。

- [ ] **步骤 1：修改 schema**

在 `packages/services/src/session-runtime/schema.ts` 的 `channelDelivery` 定义里，给可空字段组增加：

```ts
    platformMetaJson: text("platform_meta_json"),
```

- [ ] **步骤 2：重新生成单一基线**

```powershell
Remove-Item -Recurse -Force packages/services/src/session-runtime/migrations
pnpm --filter @vykor/services db:generate
```

drizzle-kit 会生成 `migrations\0000_<随机tag>.sql` 与 `migrations\meta\`。然后：

1. 把生成的 `0000_<随机tag>.sql` 重命名为 `0000_current_schema.sql`。
2. 编辑 `migrations\meta\_journal.json`：`entries` 只保留一条，`idx` 为 `0`，`tag` 改为 `"0000_current_schema"`；其余字段保留 drizzle 生成值。

- [ ] **步骤 3：追加两条手工数据行**

在 `0000_current_schema.sql` **末尾**追加（注意必须保留 `--> statement-breakpoint`，drizzle migrator 靠它切分语句）：

```sql
INSERT INTO application_storage_format (id, version) VALUES (1, 3);
--> statement-breakpoint
INSERT INTO session_event_sequence (id, reserved_through) VALUES (1, 0);
```

运行：`pnpm --filter @vykor/services db:check`
预期：通过（迁移文件无冲突）。

- [ ] **步骤 4：重新生成 inventory fixture**

新建临时文件 `packages/services/src/database/__dump-inventory.test.ts`：

```ts
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { it } from "vitest";

import { SessionDatabase } from "./session-database.js";

it("dump inventory", () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-dump-"));
  const database = SessionDatabase.open({ path: join(directory, "sessions.db") });
  const schema = database.connection
    .prepare(
      "SELECT type,name,tbl_name,sql FROM sqlite_master WHERE name NOT LIKE ? AND name != ? ORDER BY type,name",
    )
    .all("sqlite_%", "__drizzle_migrations") as Array<{
    type: string;
    name: string;
    sql: string;
  }>;
  const inventory = {
    schema,
    tables: schema
      .filter((row) => row.type === "table")
      .map((row) => ({
        name: row.name,
        columns: database.connection.pragma(`table_info(${JSON.stringify(row.name)})`),
        foreignKeys: database.connection.pragma(
          `foreign_key_list(${JSON.stringify(row.name)})`,
        ),
      })),
    format: database.connection
      .prepare("SELECT * FROM application_storage_format")
      .all(),
  };
  const normalized = JSON.parse(
    JSON.stringify(inventory, (_key, item) =>
      typeof item === "string" ? item.replace(/\s+/g, " ").trim() : item,
    ),
  );
  writeFileSync(
    new URL("./__fixtures__/current-schema-inventory.json", import.meta.url),
    `${JSON.stringify(normalized, null, 2)}\n`,
  );
  database.close();
  rmSync(directory, { recursive: true, force: true });
});
```

运行：`pnpm --filter @vykor/services exec vitest run src/database/__dump-inventory.test.ts`
预期：PASS；fixture 被覆盖，`format` 为 `[{ "id": 1, "version": 3 }]`。
运行后**删除**临时文件 `packages/services/src/database/__dump-inventory.test.ts`。

- [ ] **步骤 5：更新版本断言**

1. `packages/services/src/database/session-database.test.ts:59`：`{ version: 2 }` → `{ version: 3 }`。
2. `packages/services/src/session-runtime/__test__/store.test.ts:141` 测试名 "creates a format 2 database..." → "creates a format 3 database..."；`:149` `{ version: 2 }` → `{ version: 3 }`。
3. `packages/services/scripts/check-bundled-baseline.ts:43`：`get().version, 2` → `get().version, 3`。

（注意：变的是 `application_storage_format.version`；drizzle journal 自身的 `version` 字段不随之变化。）

- [ ] **步骤 6：运行相关测试**

运行：`pnpm --filter @vykor/services test -- --run src/database/session-database.test.ts src/session-runtime/__test__/store.test.ts`
预期：PASS。

- [ ] **步骤 7：更新受影响的文档**

运行：`rg -n "storage format|application_storage_format|version.*2" docs`
对命中的过时描述（例如 `docs/durable-execution-data-model.md` 里 `version = 1`）改为当前 `3`。

- [ ] **步骤 8：Commit**

```bash
git add packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/migrations packages/services/src/database/__fixtures__/current-schema-inventory.json packages/services/src/database/session-database.test.ts packages/services/src/session-runtime/__test__/store.test.ts packages/services/scripts/check-bundled-baseline.ts docs
git commit -m "chore(services): add channel_delivery.platform_meta_json and re-baseline storage format 3"
```

---

## 任务 4：services 仓储读写 platformMeta

**文件：**
- 修改：`packages/services/src/channels/channel-repository.ts`
- 修改：`packages/services/src/channels/channel-records.ts`
- 测试：`packages/services/src/channels/channel-repository.test.ts`

**Interfaces：**
- Consumes：任务 3 的 `platform_meta_json` 列。
- Produces：
  - `CreateChannelDeliveryInput.platformMeta?: Record<string, unknown>`
  - `encodePlatformMeta(value): string | null`
  - `decodePlatformMeta(value): Record<string, unknown> | undefined`

- [ ] **步骤 1：编写失败的测试**

在 `packages/services/src/channels/channel-repository.test.ts` 的 `describe("ChannelRepository")` 内追加：

```ts
  it("round-trips platformMeta and omits absent or corrupt values", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-channel-meta-"));
    const path = join(directory, "sessions.db");
    const store = new SessionStore({ path });
    try {
      store.sessions.create({ id: "session-1", cwd: directory, model: "m" });
      const input = store.conversationTransactions.admitPrompt({
        id: "input-1",
        sessionId: "session-1",
        content: "hello",
      });
      const run = store.runs.createRun({
        id: "run-1",
        sessionId: "session-1",
        inputId: input.id,
      });
      const conversation = store.channels.upsertConversation({
        connector: "feishu",
        accountId: "account-1",
        chatId: "chat-1",
        threadId: "thread-1",
        sessionId: "session-1",
      });

      const created = store.channels.createDelivery({
        id: "delivery-meta",
        conversationId: conversation.id,
        connector: "feishu",
        accountId: "account-1",
        chatId: "chat-1",
        threadId: "thread-1",
        sessionId: "session-1",
        inputId: input.id,
        runId: run.id,
        externalMessageId: "external-1",
        content: "reply",
        platformMeta: { rootMessageId: "msg_root", chatType: "group" },
      });

      expect(created.platformMeta).toEqual({
        rootMessageId: "msg_root",
        chatType: "group",
      });
      expect(store.channels.getDelivery(created.id)?.platformMeta).toEqual({
        rootMessageId: "msg_root",
        chatType: "group",
      });
      expect(
        store.channels.listDeliveries({ connector: "feishu" })[0]?.platformMeta,
      ).toEqual({ rootMessageId: "msg_root", chatType: "group" });

      // absent -> omitted
      const input2 = store.conversationTransactions.admitPrompt({
        id: "input-2",
        sessionId: "session-1",
        content: "hello2",
      });
      const run2 = store.runs.createRun({
        id: "run-2",
        sessionId: "session-1",
        inputId: input2.id,
      });
      const noMeta = store.channels.createDelivery({
        id: "delivery-no-meta",
        conversationId: conversation.id,
        connector: "feishu",
        accountId: "account-1",
        chatId: "chat-1",
        threadId: "thread-1",
        sessionId: "session-1",
        inputId: input2.id,
        runId: run2.id,
        externalMessageId: "external-2",
        content: "reply2",
      });
      expect(noMeta.platformMeta).toBeUndefined();

      // corrupt JSON on read -> omitted, no throw
      store.storage.database.connection
        .prepare("UPDATE channel_delivery SET platform_meta_json = ? WHERE id = ?")
        .run("not-json", created.id);
      expect(() => store.channels.getDelivery(created.id)).not.toThrow();
      expect(store.channels.getDelivery(created.id)?.platformMeta).toBeUndefined();
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/services test -- --run src/channels/channel-repository.test.ts`
预期：FAIL，`platformMeta` 参数不存在 / 未持久化。

- [ ] **步骤 3：最小实现**

1. 在 `packages/services/src/channels/channel-records.ts` 末尾新增：

```ts
export function encodePlatformMeta(
  value: Record<string, unknown> | undefined,
): string | null {
  if (!value) return null;
  try {
    const normalized = JSON.parse(JSON.stringify(value)) as unknown;
    if (
      !normalized ||
      typeof normalized !== "object" ||
      Array.isArray(normalized) ||
      Object.keys(normalized as Record<string, unknown>).length === 0
    ) {
      return null;
    }
    return JSON.stringify(normalized);
  } catch {
    return null;
  }
}

export function decodePlatformMeta(
  value: string,
): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      Object.keys(parsed as Record<string, unknown>).length === 0
    ) {
      return undefined;
    }
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}
```

2. `channelDeliveryFromRow`：在 `return {` 之前加一行，并在返回对象里（`...(row.thread_id ...)` 之后）加一行：

```ts
  const platformMeta = row.platform_meta_json
    ? decodePlatformMeta(row.platform_meta_json as string)
    : undefined;
```

```ts
    ...(platformMeta ? { platformMeta } : {}),
```

3. `packages/services/src/channels/channel-repository.ts`：
   - `CreateChannelDeliveryInput` 增加：

```ts
  platformMeta?: Record<string, unknown>;
```

   - 顶部 import 增加：

```ts
import { channelDeliveryFromRow, encodePlatformMeta, externalConversationFromRow } from "./channel-records.js";
```

   - `createDelivery` 的 INSERT 语句与 `.run(...)` 增加 `platform_meta_json`：

```ts
    const platformMetaJson = encodePlatformMeta(input.platformMeta);
    this.storage.database.connection
      .prepare(
        `INSERT INTO channel_delivery
          (id, conversation_id, connector, account_id, chat_id, thread_id,
           session_id, input_id, run_id, external_message_id, content, status,
           attempt_count, platform_meta_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
      )
      .run(
        id,
        input.conversationId,
        input.connector,
        input.accountId,
        input.chatId,
        input.threadId ?? "",
        input.sessionId,
        input.inputId,
        input.runId,
        input.externalMessageId,
        input.content,
        platformMetaJson,
        timestamp,
        timestamp,
      );
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/services test -- --run src/channels/channel-repository.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/services/src/channels/channel-repository.ts packages/services/src/channels/channel-records.ts packages/services/src/channels/channel-repository.test.ts
git commit -m "feat(services): persist platformMeta on channel deliveries"
```

---

## 任务 5：server 透传 input.platformMeta 到 delivery

**文件：**
- 修改：`packages/server/src/application/channel/channel-application-service.ts`
- 测试：`packages/server/src/application/channel/__test__/channel-application-service.test.ts`

**Interfaces：**
- Consumes：任务 1 的 `DurableChannelMessageInput.platformMeta`；任务 4 的 `CreateChannelDeliveryInput.platformMeta`。
- Produces：`ChannelOperations.createDelivery` 入参含 `platformMeta?`；`handleMessageInLane` 写入它。

- [ ] **步骤 1：编写失败的测试**

在 `packages/server/src/application/channel/__test__/channel-application-service.test.ts` 的 `describe(...)` 内追加：

```ts
  it("forwards input.platformMeta into the channel delivery", async () => {
    const fixture = createFixture();
    const service = createService(fixture);

    const input: DurableChannelMessageInput = {
      connector: "slack",
      accountId: "acc-1",
      chatId: "chat-1",
      externalMessageId: "msg-meta",
      content: "Hello",
      cwd: "/repo",
      platformMeta: { rootMessageId: "msg_root" },
    };

    await service.handleMessage(input);

    expect(fixture.channels.createDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        platformMeta: { rootMessageId: "msg_root" },
      }),
    );
  });

  it("returns platformMeta on pending deliveries", () => {
    const fixture = createFixture();
    fixture.delivery.platformMeta = { rootMessageId: "msg_root" };
    const service = createService(fixture);

    expect(service.pendingDeliveries()[0]?.platformMeta).toEqual({
      rootMessageId: "msg_root",
    });
  });
```

- [ ] **步骤 2：运行测试确认失败**

运行：`pnpm --filter @vykor/server test -- --run src/application/channel/__test__/channel-application-service.test.ts`
预期：FAIL，createDelivery 调用未含 platformMeta。

- [ ] **步骤 3：最小实现**

1. `ChannelOperations.createDelivery` 的内联入参类型（`channel-application-service.ts:35-46`）增加：

```ts
    platformMeta?: Record<string, unknown>;
```

2. `handleMessageInLane` 的 `createDelivery({...})` 增加（放在 `threadId: input.threadId,` 之后）：

```ts
      platformMeta: input.platformMeta,
```

- [ ] **步骤 4：运行测试确认通过**

运行：`pnpm --filter @vykor/server test -- --run src/application/channel/__test__/channel-application-service.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/server/src/application/channel/channel-application-service.ts packages/server/src/application/channel/__test__/channel-application-service.test.ts
git commit -m "feat(server): pass channel platformMeta into delivery"
```

---

## 任务 6：Feishu 线程回复端到端集成测试

**文件：**
- 测试：`packages/channels/src/__test__/durable-thread-reply.test.ts`（新建）

**Interfaces：**
- Consumes：任务 1-5 的全部改动。
- Produces：证明「Feishu 入站带 root_id → durable delivery → 出站真正调用 `im.message.reply`」的自动化证据。

- [ ] **步骤 1：编写失败的测试**

新建 `packages/channels/src/__test__/durable-thread-reply.test.ts`：

```ts
import { describe, expect, it, vi } from "vitest";

import type { ChannelDeliveryRecord } from "@vykor/protocol";

import { MessageBus } from "../bus/queue.js";
import { DurableChannelBridge, type DurableChannelPort } from "../core/durable-bridge.js";
import { ChannelManager } from "../core/manager.js";
import { FeishuAdapter } from "../impl/feishu.js";

interface ReplyCall {
  path: { message_id: string };
  data: { content: string; msg_type: string; reply_in_thread?: boolean };
}
interface CreateCall {
  params: { receive_id_type: string };
  data: { receive_id: string; content: string; msg_type: string };
}

function makeFeishu() {
  const adapter = new FeishuAdapter({ appId: "a", appSecret: "s" });
  const create = vi.fn<(call: CreateCall) => Promise<void>>(async () => {});
  const reply = vi.fn<(call: ReplyCall) => Promise<void>>(async () => {});
  (adapter as unknown as { client: unknown }).client = {
    im: { message: { create, reply } },
  };
  // manager.startAll() 会调用 connect()，这里 stub 掉真实 SDK / WS。
  (adapter as unknown as { connect: () => Promise<void> }).connect = vi.fn(
    async () => {},
  );
  return { adapter, create, reply };
}

describe("durable Feishu thread reply", () => {
  it("routes a durable delivery back into the Feishu thread via reply API", async () => {
    const bus = new MessageBus();
    const { adapter, create, reply } = makeFeishu();
    const threadId = "thread_1";
    const rootMessageId = "msg_root";

    const baseDelivery: ChannelDeliveryRecord = {
      id: "delivery-1",
      conversationId: "conv-1",
      connector: "feishu",
      accountId: "app-1",
      chatId: "chat-1",
      threadId,
      sessionId: "session-1",
      inputId: "input-1",
      runId: "run-1",
      externalMessageId: "message-1",
      content: "thread answer",
      status: "pending",
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      platformMeta: { rootMessageId },
    };

    const application: DurableChannelPort = {
      handleChannelMessage: vi.fn(async (input) => ({
        conversation: {
          id: "conv-1",
          connector: "feishu",
          accountId: "app-1",
          chatId: "chat-1",
          threadId,
          sessionId: "session-1",
          createdAt: 1,
          updatedAt: 1,
        },
        delivery: { ...baseDelivery, platformMeta: input.platformMeta },
        duplicate: false,
      })),
      listPendingChannelDeliveries: vi.fn(async () => []),
      recordChannelDelivery: vi.fn(async (id, input) => ({
        ...baseDelivery,
        id,
        status: input.status,
      })),
    };

    const manager = new ChannelManager([adapter], bus, {
      allowFrom: { feishu: ["*"] },
    });
    const bridge = new DurableChannelBridge({
      application,
      bus,
      cwd: "D:/project",
      model: "model-1",
    });
    await manager.startAll();
    bridge.start();

    await (
      adapter as unknown as { _handleEvent(d: unknown): Promise<void> }
    )._handleEvent({
      message: {
        message_id: "message-1",
        chat_id: "chat-1",
        chat_type: "group",
        msg_type: "text",
        content: JSON.stringify({ text: "question" }),
        create_time: "1710000000000",
        thread_id: threadId,
        root_id: rootMessageId,
        sender: { sender_id: { open_id: "ou_sender" }, sender_type: "user" },
        mentions: [],
      },
    });

    await vi.waitFor(() => {
      expect(reply).toHaveBeenCalledOnce();
    });
    const call = reply.mock.calls[0]![0] as ReplyCall;
    expect(call.path.message_id).toBe(rootMessageId);
    expect(call.data.reply_in_thread).toBe(true);
    expect(call.data.msg_type).toBe("text");
    expect(call.data.content).toBe(JSON.stringify({ text: "thread answer" }));
    expect(create).not.toHaveBeenCalled();

    await bridge.stop();
    await manager.stopAll();
  });
});
```

- [ ] **步骤 2：运行测试确认失败（在改动前应失败）**

运行：`pnpm --filter @vykor/channels test -- --run src/__test__/durable-thread-reply.test.ts`
预期：若任务 1-5 未完成则 FAIL（`reply` 未被调用，因为出站缺 `platformMeta.rootMessageId`）。任务 1-5 已完成时该测试应当 PASS；若仍 FAIL，说明链路有缺口，按失败信息回到对应任务修复。

- [ ] **步骤 3：确认通过**

运行：`pnpm --filter @vykor/channels test -- --run src/__test__/durable-thread-reply.test.ts`
预期：PASS。

- [ ] **步骤 4：Commit**

```bash
git add packages/channels/src/__test__/durable-thread-reply.test.ts
git commit -m "test(channels): prove durable Feishu thread replies reach the reply API"
```

---

## 任务 7：阶段完整验证

**文件：** 无（仅验证）

- [ ] **步骤 1：四个包全量测试**

```bash
pnpm --filter @vykor/protocol test -- --run
pnpm --filter @vykor/services test -- --run
pnpm --filter @vykor/server test -- --run
pnpm --filter @vykor/channels test -- --run
```

预期：全部通过。

- [ ] **步骤 2：类型检查**

```bash
pnpm --filter @vykor/protocol check-types
pnpm --filter @vykor/services check-types
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/channels check-types
```

预期：退出码 0。

- [ ] **步骤 3：DB 与 clean-slate 校验**

```bash
pnpm --filter @vykor/services db:check
pnpm check:clean-slate
pnpm check-docs
```

预期：全部通过。

- [ ] **步骤 4：全仓构建**

```bash
pnpm exec turbo build --output-logs=full
```

预期：全部任务成功。

- [ ] **步骤 5：反 fallback 扫描**

```powershell
rg -n -g '!**/*.test.ts' -g '!**/__test__/**' "fallback|fall back|Date\.now\(\)|msg\.message_id \?\?|senderId .*chat_id|image.*text|file.*text|thread.*chat" packages/channels/src/core packages/channels/src/bus packages/channels/src/impl/feishu.ts packages/server/src/application/channel packages/protocol/src/channel.ts
```

预期：无生产性伪造；如有注释命中，人工确认不是「把缺失 thread/root 字段伪造成 chat/随机值」。

- [ ] **步骤 6：diff 与工作区检查**

```bash
git diff --check
git status --short
```

预期：无格式错误；工作区只剩明确属于本阶段的改动（其他人已有的未提交变更不应被触碰）。

- [ ] **步骤 7：最终报告**

汇报：每个任务改动的文件、测试结果、commit hash 与 message、是否修改了协议版本（否，保持 4）、是否保留 fallback（否）、全量测试/类型/构建/clean-slate 结果、工作区剩余未提交变更。

---

## 阶段完成标准

- Feishu 入站的 `root_id` 经 `platformMeta.rootMessageId` 一路保存到 delivery，并在立即出站与恢复两条路径回到 adapter。
- Feishu adapter 用 `platformMeta.rootMessageId` 调用真实 `im.message.reply`，不降级普通 chat。
- `threadId`（Feishu `thread_id`）与 `platformMeta.rootMessageId`（Feishu `root_id`）语义始终分离。
- `platformMeta` 只接受非空普通对象；写入规范化、读取容错；不伪造、不降级。
- 数据库为 clean-slate 单基线，storage format 3，旧库不支持。
- 协议版本保持 4。
- 四包测试、类型检查、全仓构建、clean-slate、check-docs 全部通过。
