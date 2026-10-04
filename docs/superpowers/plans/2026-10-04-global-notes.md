# 全局便签 V1 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 在桌面端用可搜索、自动保存、可恢复的全局便签替换左栏无行为的“拉取请求”占位项。

**架构：** 便签作为正式业务数据保存在 daemon 管理的现有 SQLite 中，经 protocol → services → server HTTP → client → desktop IPC → Renderer 单向贯通。Renderer 只负责列表、选中态、搜索、自动保存协调和未确认写入 SQLite 的临时恢复稿，不把便签混入会话 Store 或 session event。

**技术栈：** TypeScript、Drizzle ORM、better-sqlite3、Hono、Electron IPC、React 19、TanStack Router、Vitest、Tailwind CSS。

---

## 执行前提

当前工作区的临时聊天存储改造已经占用 migration `0002_temporary_resource_sources.sql`，并修改了 protocol、SQLite schema、server 和 desktop shared IPC。执行本计划前先完成并提交那组在途修改，再从包含以下两部分的干净基线创建隔离 worktree：

1. 全局便签设计提交 `80314d3a`。
2. 当前临时聊天存储改造及其 migration `0002`。

新分支使用 `codex/global-notes-v1`。隔离 worktree 中 `git status --short` 必须为空；不要从当前脏工作区复制整个文件，也不要覆盖 shared IPC 或 schema 的新改动。便签迁移固定使用 `0003_global_notes.sql`。

## 文件结构

### 协议与持久化

- 创建 `packages/protocol/src/notes.ts`：记录类型、输入类型、长度常量和请求解析。
- 创建 `packages/protocol/src/notes.test.ts`：创建/更新输入边界测试。
- 修改 `packages/protocol/src/index.ts`：公开便签协议。
- 创建 `packages/services/src/notes/note-repository.ts`：SQLite CRUD、排序和 revision 冲突。
- 创建 `packages/services/src/notes/note-repository.test.ts`：重开、排序、清空、删除和冲突测试。
- 创建 `packages/services/src/notes/index.ts`：notes 领域导出。
- 修改 `packages/services/src/session-runtime/schema.ts`：新增 `notes` 表。
- 修改 `packages/services/src/session-runtime/store.ts`：暴露 `store.notes`，不加载进 SessionState。
- 修改 `packages/services/src/index.ts`：公开 `NoteRepository` 和冲突错误。
- 创建 `packages/services/src/session-runtime/migrations/0003_global_notes.sql`。
- 创建 `packages/services/src/session-runtime/migrations/meta/0003_snapshot.json`。
- 修改 `packages/services/src/session-runtime/migrations/meta/_journal.json`。
- 修改 `packages/services/src/database/__fixtures__/current-schema-inventory.json`。
- 修改 `packages/services/src/database/session-database.test.ts`：迁移数量和文件清单。

### daemon HTTP 与 typed client

- 创建 `packages/server/src/http/routes/notes.ts`：四个 notes 路由及错误映射。
- 创建 `packages/server/src/http/routes/notes.test.ts`：HTTP 成功、400、404、409。
- 修改 `packages/server/src/application/daemon-application.ts`：把 `store.notes` 暴露为应用能力。
- 修改 `packages/server/src/http/server.ts`：挂载 `/notes`。
- 创建 `packages/client/src/resources/note-resource.ts`：typed HTTP 调用。
- 修改 `packages/client/src/resources/index.ts`、`packages/client/src/transport/http-client.ts`、`packages/client/src/index.ts`、`packages/client/src/types/index.ts`：公开 `client.notes` 和类型。
- 修改 `packages/client/src/transport/__test__/http-client.test.ts`、`packages/client/src/__test__/public-api.test.ts`：请求路径和公共表面。

### Desktop bridge

- 创建 `apps/desktop/src/shared/note-types.ts`：desktop 类型别名。
- 修改 `apps/desktop/src/shared/desktop-api-contract.ts`、`apps/desktop/src/shared/ipc-channels.ts`：窄 IPC 契约。
- 创建 `apps/desktop/src/main/features/notes/note-service.ts`：daemon client 包装与一次重连重试。
- 创建 `apps/desktop/src/main/features/notes/ipc.ts`、`ipc.test.ts`：注册四个 IPC handler。
- 修改 `apps/desktop/src/main/features/index.ts`：装配 notes contribution。
- 修改 `apps/desktop/src/preload/desktop-api.ts`、`desktop-api.test.ts`：暴露 `window.desktop.notes`。

### Renderer

- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-model.ts`、`note-model.test.ts`：标题、摘要、搜索和排序。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.ts`、`note-recovery.test.ts`：版本化恢复稿集合与最后选择。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-save-coordinator.ts`、`note-save-coordinator.test.ts`：300ms debounce、串行保存、coalesce 和 revision。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.ts`、`use-notes-controller.test.tsx`：加载、新建、切换、搜索、删除和错误状态。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-list.tsx`：搜索、新建和列表。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-editor.tsx`：纯文本编辑、保存状态和更多菜单。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/note-delete-dialog.tsx`：不可撤销确认。
- 创建 `apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.tsx`、`notes-page.test.tsx`、`index.ts`：页面组合与行为测试。
- 创建 `apps/desktop/src/renderer/src/routes/_main.notes.tsx`。
- 修改 `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`、`sidebar.test.tsx`、`main-layout.tsx`：替换入口并导航。
- 由 TanStack Router 生成器更新 `apps/desktop/src/renderer/src/routeTree.gen.ts`；禁止手改。

### 备份与验收

- 创建 `packages/server/src/application/backup/application-backup.test.ts`：便签随数据库备份与恢复。

## 范围护栏

本计划只实现设计规格的第一版。下列五组能力是第二期，任务和验收中都不得出现对应入口或预留字段：

1. 置顶、归档、回收站。
2. 文件夹、标签、颜色。
3. Markdown 预览、富文本、图片和附件。
4. 项目关联、AI 整理、多端同步。
5. 系统级快捷唤起或悬浮窗。

---

### 任务 1：建立便签协议

**文件：**

- 创建：`packages/protocol/src/notes.ts`
- 创建：`packages/protocol/src/notes.test.ts`
- 修改：`packages/protocol/src/index.ts`

- [ ] **步骤 1：编写失败的协议测试**

```ts
import { describe, expect, it } from "vitest";
import {
  MAX_NOTE_CONTENT_LENGTH,
  ProtocolValidationError,
  parseCreateNoteInput,
  parseUpdateNoteInput,
} from "./index.js";

describe("note requests", () => {
  it("accepts nonblank create content and empty update content", () => {
    expect(parseCreateNoteInput({ content: "  idea  " })).toEqual({
      content: "  idea  ",
    });
    expect(parseUpdateNoteInput({ content: "", expectedRevision: 2 })).toEqual({
      content: "",
      expectedRevision: 2,
    });
  });

  it("rejects blank creates, invalid revisions, oversized content and unknown fields", () => {
    expect(() => parseCreateNoteInput({ content: "   " })).toThrow(
      ProtocolValidationError,
    );
    expect(() =>
      parseUpdateNoteInput({ content: "x", expectedRevision: 0 }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseCreateNoteInput({
        content: "x".repeat(MAX_NOTE_CONTENT_LENGTH + 1),
      }),
    ).toThrow(ProtocolValidationError);
    expect(() =>
      parseUpdateNoteInput({ content: "x", expectedRevision: 1, id: "forged" }),
    ).toThrow(ProtocolValidationError);
  });
});
```

- [ ] **步骤 2：运行测试，确认因为 notes API 尚不存在而失败**

运行：

```bash
pnpm --filter @vykor/protocol exec vitest run src/notes.test.ts
```

预期：FAIL，提示 `parseCreateNoteInput`、`parseUpdateNoteInput` 或 `MAX_NOTE_CONTENT_LENGTH` 未导出。

- [ ] **步骤 3：实现最小协议**

`packages/protocol/src/notes.ts` 的公共表面固定为：

```ts
import { ProtocolValidationError } from "./requests.js";

export const MAX_NOTE_CONTENT_LENGTH = 100_000;

export interface NoteRecord {
  id: string;
  content: string;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface CreateNoteInput {
  content: string;
}

export interface UpdateNoteInput {
  content: string;
  expectedRevision: number;
}

export function parseCreateNoteInput(value: unknown): CreateNoteInput {
  const record = readRecord(value);
  rejectUnknown(record, ["content"]);
  const content = readContent(record.content);
  if (!content.trim())
    throw new ProtocolValidationError("content must not be blank", "content");
  return { content };
}

export function parseUpdateNoteInput(value: unknown): UpdateNoteInput {
  const record = readRecord(value);
  rejectUnknown(record, ["content", "expectedRevision"]);
  const content = readContent(record.content);
  if (
    !Number.isSafeInteger(record.expectedRevision) ||
    Number(record.expectedRevision) < 1
  ) {
    throw new ProtocolValidationError(
      "expectedRevision must be a positive safe integer",
      "expectedRevision",
    );
  }
  return { content, expectedRevision: Number(record.expectedRevision) };
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ProtocolValidationError("Request body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function readContent(value: unknown): string {
  if (typeof value !== "string")
    throw new ProtocolValidationError("content must be a string", "content");
  if (value.length > MAX_NOTE_CONTENT_LENGTH) {
    throw new ProtocolValidationError(
      "content is too large",
      "content",
      "payload_too_large",
    );
  }
  return value;
}

function rejectUnknown(
  record: Record<string, unknown>,
  allowed: string[],
): void {
  const unknown = Object.keys(record).find((key) => !allowed.includes(key));
  if (unknown)
    throw new ProtocolValidationError(
      `Unknown note field: ${unknown}`,
      unknown,
    );
}
```

从 `packages/protocol/src/index.ts` 导出 `./notes.js`。

- [ ] **步骤 4：重新运行协议测试并执行类型检查**

运行：

```bash
pnpm --filter @vykor/protocol exec vitest run src/notes.test.ts
pnpm --filter @vykor/protocol check-types
```

预期：测试 PASS，类型检查退出码 0。

- [ ] **步骤 5：提交协议交付物**

```bash
git add packages/protocol/src/notes.ts packages/protocol/src/notes.test.ts packages/protocol/src/index.ts
git commit -m "feat(protocol): add global note contracts"
```

---

### 任务 2：实现 SQLite 便签仓库与 migration 0003

**文件：**

- 创建：`packages/services/src/notes/note-repository.ts`
- 创建：`packages/services/src/notes/note-repository.test.ts`
- 创建：`packages/services/src/notes/index.ts`
- 修改：`packages/services/src/session-runtime/schema.ts`
- 修改：`packages/services/src/session-runtime/store.ts`
- 修改：`packages/services/src/index.ts`
- 创建：`packages/services/src/session-runtime/migrations/0003_global_notes.sql`
- 创建：`packages/services/src/session-runtime/migrations/meta/0003_snapshot.json`
- 修改：`packages/services/src/session-runtime/migrations/meta/_journal.json`
- 修改：`packages/services/src/database/__fixtures__/current-schema-inventory.json`
- 修改：`packages/services/src/database/session-database.test.ts`

- [ ] **步骤 1：编写失败的仓库测试**

```ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SessionStore } from "../session-runtime/store.js";
import { NoteRevisionConflictError } from "./note-repository.js";

describe("NoteRepository", () => {
  it("persists, sorts, clears and deletes notes across database reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-notes-"));
    const path = join(directory, "sessions.db");
    try {
      const first = new SessionStore({ path });
      const older = first.notes.create(
        { content: "older" },
        { id: "older", now: 10 },
      );
      const newer = first.notes.create(
        { content: "newer" },
        { id: "newer", now: 20 },
      );
      expect(first.notes.list().map((note) => note.id)).toEqual([
        "newer",
        "older",
      ]);
      expect(
        first.notes.update(older.id, { content: "", expectedRevision: 1 }, 30),
      ).toMatchObject({
        content: "",
        revision: 2,
        updatedAt: 30,
      });
      first.close();

      const second = new SessionStore({ path });
      expect(
        second.notes.list().map((note) => [note.id, note.content]),
      ).toEqual([
        ["older", ""],
        ["newer", "newer"],
      ]);
      expect(second.notes.remove(newer.id)).toBe(true);
      expect(second.notes.remove(newer.id)).toBe(false);
      second.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects stale revisions without changing content", () => {
    const directory = mkdtempSync(join(tmpdir(), "vk-note-conflict-"));
    const store = new SessionStore({ path: join(directory, "sessions.db") });
    try {
      const note = store.notes.create(
        { content: "v1" },
        { id: "note", now: 10 },
      );
      store.notes.update(note.id, { content: "v2", expectedRevision: 1 }, 20);
      expect(() =>
        store.notes.update(
          note.id,
          { content: "stale", expectedRevision: 1 },
          30,
        ),
      ).toThrow(NoteRevisionConflictError);
      expect(store.notes.get(note.id)?.content).toBe("v2");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
```

- [ ] **步骤 2：运行仓库测试，确认失败**

运行：

```bash
pnpm --filter @vykor/services exec vitest run src/notes/note-repository.test.ts
```

预期：FAIL，提示 `SessionStore.notes` 或 `NoteRepository` 不存在。

- [ ] **步骤 3：添加 Drizzle schema 并生成 migration 0003**

在 `schema.ts` 中加入：

```ts
export const notes = sqliteTable(
  "note",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    revision: integer("revision").notNull().default(1),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("note_updated_at_idx").on(table.updatedAt.desc())],
);
```

运行：

```bash
pnpm --filter @vykor/services exec drizzle-kit generate --config drizzle.config.ts --name global_notes
```

预期：生成 `0003_global_notes.sql` 和 `meta/0003_snapshot.json`，并向 `_journal.json` 加入 tag `0003_global_notes`。

- [ ] **步骤 4：实现仓库与冲突错误**

核心更新必须使用条件写入，而不是先读后无条件覆盖：

```ts
export class NoteRevisionConflictError extends Error {
  constructor(readonly noteId: string, readonly expectedRevision: number) {
    super(`Note revision conflict: ${noteId} expected ${expectedRevision}`);
    this.name = "NoteRevisionConflictError";
  }
}

update(id: string, input: UpdateNoteInput, now = Date.now()): NoteRecord {
  return this.storage.atomic(() => {
    this.storage.assertWritable();
    const result = this.database
      .update(notes)
      .set({ content: input.content, revision: input.expectedRevision + 1, updatedAt: now })
      .where(and(eq(notes.id, id), eq(notes.revision, input.expectedRevision)))
      .run();
    if (result.changes === 0) {
      if (!this.get(id)) throw new Error(`Note not found: ${id}`);
      throw new NoteRevisionConflictError(id, input.expectedRevision);
    }
    return this.get(id)!;
  });
}
```

`create` 使用 `randomUUID()`，但测试可通过第二个可选参数注入 `{ id, now }`；`list` 使用 `orderBy(desc(notes.updatedAt), desc(notes.createdAt))`；`remove` 返回是否删除。

仓库公共签名固定为：

```ts
create(
  input: CreateNoteInput,
  options: { id?: string; now?: number } = {},
): NoteRecord;
get(id: string): NoteRecord | undefined;
list(): NoteRecord[];
update(id: string, input: UpdateNoteInput, now?: number): NoteRecord;
remove(id: string): boolean;
```

在 `SessionStore` 构造时使用已有 `StorageContext` 创建 `this.notes = new NoteRepository(this.storage)`。不要把记录加入 `SessionState`、mutation buffer 或 durable event。

- [ ] **步骤 5：更新 migration 清单与 schema inventory**

`session-database.test.ts` 的期望值改为 4 条 migration，并包含：

```ts
expect(sqlFiles).toEqual([
  "0000_current_schema.sql",
  "0001_drop_application_storage_format.sql",
  "0002_temporary_resource_sources.sql",
  "0003_global_notes.sql",
]);
```

向 `current-schema-inventory.json` 按名称排序加入 `note` 表与 `note_updated_at_idx`。运行数据库测试时必须比较完整 inventory，不得只放宽断言。

- [ ] **步骤 6：运行仓库、迁移与 Drizzle 检查**

运行：

```bash
pnpm --filter @vykor/services exec vitest run src/notes/note-repository.test.ts src/database/session-database.test.ts
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/services check-types
```

预期：全部 PASS；migration 文件清单包含 `0003_global_notes.sql`；Drizzle 检查退出码 0。

- [ ] **步骤 7：提交持久化交付物**

```bash
git add packages/services/src/notes packages/services/src/session-runtime/schema.ts packages/services/src/session-runtime/store.ts packages/services/src/session-runtime/migrations packages/services/src/database/__fixtures__/current-schema-inventory.json packages/services/src/database/session-database.test.ts packages/services/src/index.ts
git commit -m "feat(services): persist global notes"
```

---

### 任务 3：提供 daemon HTTP 与 typed client

**文件：**

- 创建：`packages/server/src/http/routes/notes.ts`
- 创建：`packages/server/src/http/routes/notes.test.ts`
- 修改：`packages/server/src/application/daemon-application.ts`
- 修改：`packages/server/src/http/server.ts`
- 创建：`packages/client/src/resources/note-resource.ts`
- 修改：`packages/client/src/resources/index.ts`
- 修改：`packages/client/src/transport/http-client.ts`
- 修改：`packages/client/src/index.ts`
- 修改：`packages/client/src/types/index.ts`
- 修改：`packages/client/src/transport/__test__/http-client.test.ts`
- 修改：`packages/client/src/__test__/public-api.test.ts`

- [ ] **步骤 1：编写失败的 HTTP route 测试**

```ts
import { describe, expect, it, vi } from "vitest";
import { NoteRevisionConflictError } from "@vykor/services";
import { Hono } from "hono";
import { createNoteRoutes } from "./notes.js";

describe("note routes", () => {
  it("lists, creates, updates and removes notes", async () => {
    const note = {
      id: "n1",
      content: "idea",
      revision: 1,
      createdAt: 1,
      updatedAt: 1,
    };
    const notes = {
      list: vi.fn(() => [note]),
      create: vi.fn(() => note),
      update: vi.fn(() => ({ ...note, content: "changed", revision: 2 })),
      remove: vi.fn(() => true),
    };
    const app = new Hono().route("/notes", createNoteRoutes({ notes }));
    expect(await (await app.request("/notes")).json()).toEqual({
      notes: [note],
    });
    expect(
      (
        await app.request("/notes", {
          method: "POST",
          body: JSON.stringify({ content: "idea" }),
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await app.request("/notes/n1", {
          method: "PATCH",
          body: JSON.stringify({ content: "changed", expectedRevision: 1 }),
        })
      ).status,
    ).toBe(200);
    expect((await app.request("/notes/n1", { method: "DELETE" })).status).toBe(
      200,
    );
  });

  it("maps invalid, missing and conflicting writes", async () => {
    const app = new Hono().route(
      "/notes",
      createNoteRoutes({
        notes: {
          list: () => [],
          create: () => {
            throw new Error("unreachable");
          },
          update: () => {
            throw new NoteRevisionConflictError("n1", 1);
          },
          remove: () => false,
        },
      }),
    );
    expect(
      (
        await app.request("/notes", {
          method: "POST",
          body: JSON.stringify({ content: " " }),
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await app.request("/notes/n1", {
          method: "PATCH",
          body: JSON.stringify({ content: "x", expectedRevision: 1 }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await app.request("/notes/missing", { method: "DELETE" })).status,
    ).toBe(404);
  });
});
```

- [ ] **步骤 2：编写失败的 client 请求测试**

在 `http-client.test.ts` 的 fake fetch 中加入 notes 响应，然后断言：

```ts
await client.notes.list();
await client.notes.create({ content: "idea" });
await client.notes.update("n1", { content: "changed", expectedRevision: 1 });
await client.notes.remove("n1");

expect(urls.slice(-4)).toEqual([
  "GET http://127.0.0.1:3456/notes",
  "POST http://127.0.0.1:3456/notes",
  "PATCH http://127.0.0.1:3456/notes/n1",
  "DELETE http://127.0.0.1:3456/notes/n1",
]);
```

- [ ] **步骤 3：运行两组测试，确认 route 和 client API 尚不存在**

运行：

```bash
pnpm --filter @vykor/server exec vitest run src/http/routes/notes.test.ts
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts
```

预期：FAIL，提示 `createNoteRoutes` 或 `client.notes` 不存在。

- [ ] **步骤 4：实现 notes 路由并挂载**

`createNoteRoutes` 使用以下路径和响应：

```ts
return new Hono()
  .get("/", () => jsonResponse({ notes: context.notes.list() }))
  .post("/", async (c) =>
    jsonResponse(
      { note: context.notes.create(parseCreateNoteInput(await readJson(c))) },
      201,
    ),
  )
  .patch("/:id", async (c) =>
    jsonResponse({
      note: context.notes.update(
        c.req.param("id"),
        parseUpdateNoteInput(await readJson(c)),
      ),
    }),
  )
  .delete("/:id", (c) => {
    if (!context.notes.remove(c.req.param("id")))
      return errorResponse(404, "Note not found");
    return jsonResponse({ removed: true });
  });
```

所有 handler 都通过同一个 `noteError` 捕获：`ProtocolValidationError`/JSON 语法错误 → 400，`NoteRevisionConflictError` → 409，`Note not found` → 404，其余错误 → 500。

在 `DurableAgentApplication` 和 `DaemonApplication` 暴露 `readonly notes = store.notes`，在 `HttpServer` 中挂载：

```ts
this.app.route("/notes", createNoteRoutes({ notes: this.application.notes }));
```

- [ ] **步骤 5：实现 NoteResource 并公开 `client.notes`**

```ts
export class NoteResource {
  constructor(private readonly transport: HttpTransport) {}

  async list(): Promise<NoteRecord[]> {
    return (await this.transport.request<{ notes: NoteRecord[] }>("/notes"))
      .notes;
  }

  async create(input: CreateNoteInput): Promise<NoteRecord> {
    return (
      await this.transport.request<{ note: NoteRecord }>("/notes", {
        method: "POST",
        body: input,
      })
    ).note;
  }

  async update(id: string, input: UpdateNoteInput): Promise<NoteRecord> {
    return (
      await this.transport.request<{ note: NoteRecord }>(
        `/notes/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          body: input,
        },
      )
    ).note;
  }

  async remove(id: string): Promise<void> {
    await this.transport.request<{ removed: true }>(
      `/notes/${encodeURIComponent(id)}`,
      {
        method: "DELETE",
      },
    );
  }
}
```

把 `notes` 加入 `VykorClient` 的 readonly resources、公共导出和 `public-api.test.ts` 的实例键集合；从 `@vykor/client` 明确导出 `NoteRecord`、`CreateNoteInput` 和 `UpdateNoteInput` 三个类型。

- [ ] **步骤 6：运行 route、client、公共 API 和类型检查**

运行：

```bash
pnpm --filter @vykor/server exec vitest run src/http/routes/notes.test.ts
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts src/__test__/public-api.test.ts
pnpm --filter @vykor/server check-types
pnpm --filter @vykor/client check-types
```

预期：全部 PASS，`VykorClient` 公共键中包含 `notes`。

- [ ] **步骤 7：提交 HTTP 与 client 交付物**

```bash
git add packages/server/src/http/routes/notes.ts packages/server/src/http/routes/notes.test.ts packages/server/src/http/server.ts packages/server/src/application/daemon-application.ts packages/client/src/resources/note-resource.ts packages/client/src/resources/index.ts packages/client/src/transport/http-client.ts packages/client/src/index.ts packages/client/src/types/index.ts packages/client/src/transport/__test__/http-client.test.ts packages/client/src/__test__/public-api.test.ts
git commit -m "feat(api): expose global notes"
```

---

### 任务 4：接通 Desktop IPC 与 preload

**文件：**

- 创建：`apps/desktop/src/shared/note-types.ts`
- 修改：`apps/desktop/src/shared/desktop-api-contract.ts`
- 修改：`apps/desktop/src/shared/ipc-channels.ts`
- 创建：`apps/desktop/src/main/features/notes/note-service.ts`
- 创建：`apps/desktop/src/main/features/notes/ipc.ts`
- 创建：`apps/desktop/src/main/features/notes/ipc.test.ts`
- 修改：`apps/desktop/src/main/features/index.ts`
- 修改：`apps/desktop/src/preload/desktop-api.ts`
- 修改：`apps/desktop/src/preload/desktop-api.test.ts`

- [ ] **步骤 1：编写失败的 preload 与 IPC contribution 测试**

向 `desktop-api.test.ts` 加入：

```ts
it("forwards global note operations through fixed IPC channels", async () => {
  await desktopAPI.notes.list();
  await desktopAPI.notes.create({ content: "idea" });
  await desktopAPI.notes.update("n1", {
    content: "changed",
    expectedRevision: 1,
  });
  await desktopAPI.notes.remove("n1");

  expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.noteList);
  expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.noteCreate, {
    content: "idea",
  });
  expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.noteUpdate, "n1", {
    content: "changed",
    expectedRevision: 1,
  });
  expect(electron.invoke).toHaveBeenCalledWith(IpcChannels.noteRemove, "n1");
});
```

`ipc.test.ts` 断言 contribution 注册 `note:list/create/update/remove` 四个 handler，并把参数原样传给 mocked service。

- [ ] **步骤 2：运行测试，确认 bridge 尚不存在**

运行：

```bash
pnpm --filter @vykor/desktop exec vitest run src/preload/desktop-api.test.ts src/main/features/notes/ipc.test.ts
```

预期：FAIL，提示 `desktopAPI.notes`、notes IPC channels 或 contribution 不存在。

- [ ] **步骤 3：添加 shared 类型和 IPC 契约**

`note-types.ts` 只做别名，不复制协议结构：

```ts
import type {
  CreateNoteInput,
  NoteRecord,
  UpdateNoteInput,
} from "@vykor/client";

export type DesktopNote = NoteRecord;
export type CreateDesktopNoteInput = CreateNoteInput;
export type UpdateDesktopNoteInput = UpdateNoteInput;
```

在 `IpcChannels` 和 `IpcInvokeMap` 加入：

```ts
noteList: "note:list",
noteCreate: "note:create",
noteUpdate: "note:update",
noteRemove: "note:remove",
```

`DesktopAPI.notes` 固定为 `list/create/update/remove` 四个方法。

- [ ] **步骤 4：实现 DesktopNoteService、IPC 和 preload**

`DesktopNoteService` 复用 `desktopSessionService.daemonClient()`，错误仅在 `Failed to fetch`、`ECONNREFUSED` 或 `ECONNRESET` 时刷新 daemon client 后重试一次。不要为 notes 再抽一个跨功能重试框架。

preload 实现：

```ts
notes: {
  list: () => invoke(IpcChannels.noteList),
  create: (input) => invoke(IpcChannels.noteCreate, input),
  update: (id, input) => invoke(IpcChannels.noteUpdate, id, input),
  remove: (id) => invoke(IpcChannels.noteRemove, id),
},
```

将 `noteIpcContribution` 加入 `allIpcContributions`。

- [ ] **步骤 5：运行 IPC、preload 和 Desktop 类型检查**

运行：

```bash
pnpm --filter @vykor/desktop exec vitest run src/preload/desktop-api.test.ts src/main/features/notes/ipc.test.ts
pnpm --filter @vykor/desktop typecheck
```

预期：测试 PASS，node/web 两套 typecheck 退出码 0。

- [ ] **步骤 6：提交 Desktop bridge 交付物**

```bash
git add apps/desktop/src/shared/note-types.ts apps/desktop/src/shared/desktop-api-contract.ts apps/desktop/src/shared/ipc-channels.ts apps/desktop/src/main/features/notes apps/desktop/src/main/features/index.ts apps/desktop/src/preload/desktop-api.ts apps/desktop/src/preload/desktop-api.test.ts
git commit -m "feat(desktop): bridge global note operations"
```

---

### 任务 5：实现派生模型、恢复稿和自动保存协调器

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-model.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-model.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-save-coordinator.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-save-coordinator.test.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.ts`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.test.tsx`

- [ ] **步骤 1：编写失败的派生模型与恢复稿测试**

```ts
it("derives a title and preview without storing either", () => {
  expect(describeNote("\n  First line  \n\n second   line\nthird")).toEqual({
    title: "First line",
    preview: "second line third",
  });
  expect(describeNote("   ")).toEqual({ title: "无标题便签", preview: "" });
});

it("filters the full body case-insensitively and sorts by updated time", () => {
  const oldNote = {
    id: "old",
    content: "other",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  const newNote = {
    id: "new",
    content: "contains BODY",
    revision: 1,
    createdAt: 2,
    updatedAt: 2,
  };
  expect(
    filterAndSortNotes([oldNote, newNote], "body").map((note) => note.id),
  ).toEqual(["new"]);
});

it("keeps recovery drafts keyed separately and repairs malformed storage", () => {
  const storage = createMemoryStorage();
  const draftA = {
    draftId: "a",
    noteId: "n1",
    baseRevision: 1,
    content: "one",
    updatedAt: 1,
  };
  const draftB = {
    draftId: "b",
    noteId: null,
    baseRevision: null,
    content: "two",
    updatedAt: 2,
  };
  writeRecoveryDraft(storage, draftA);
  writeRecoveryDraft(storage, draftB);
  expect(readRecoveryDrafts(storage).map((draft) => draft.draftId)).toEqual([
    "a",
    "b",
  ]);
  storage.setItem(NOTE_RECOVERY_STORAGE_KEY, "broken");
  expect(readRecoveryDrafts(storage)).toEqual([]);
});

function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key);
    },
    setItem: (key, value) => {
      values.set(key, value);
    },
  };
}
```

- [ ] **步骤 2：编写失败的保存顺序测试**

使用 fake timers 和可控 Promise 验证：

```ts
it("coalesces rapid edits and never lets revision 1 overwrite revision 2", async () => {
  vi.useFakeTimers();
  const existingNote = {
    id: "note",
    content: "v1",
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  };
  let resolveFirst!: (note: typeof existingNote) => void;
  const update = vi.fn((id: string, input: UpdateDesktopNoteInput) => {
    if (input.expectedRevision === 1) {
      return new Promise<typeof existingNote>((resolve) => {
        resolveFirst = resolve;
      });
    }
    return Promise.resolve({
      ...existingNote,
      id,
      content: input.content,
      revision: input.expectedRevision + 1,
      updatedAt: 3,
    });
  });
  const api = { create: vi.fn(), update };
  const recovery = { write: vi.fn(), remove: vi.fn() };
  const coordinator = new NoteSaveCoordinator({ api, recovery, delayMs: 300 });
  const draft = {
    draftId: "draft",
    noteId: existingNote.id,
    baseRevision: 1,
    content: "v1",
    updatedAt: 1,
  };

  coordinator.stage({ ...draft, content: "v2", baseRevision: 1 });
  await vi.advanceTimersByTimeAsync(300);
  coordinator.stage({ ...draft, content: "v3", baseRevision: 1 });
  resolveFirst({ ...existingNote, content: "v2", revision: 2, updatedAt: 2 });
  await coordinator.flush();

  expect(update.mock.calls).toEqual([
    [existingNote.id, { content: "v2", expectedRevision: 1 }],
    [existingNote.id, { content: "v3", expectedRevision: 2 }],
  ]);
  expect(coordinator.snapshot()).toMatchObject({
    status: "saved",
    record: { content: "v3" },
  });
});
```

另加三个用例：新草稿首次非空调用 `create`；保存失败保留恢复稿并进入 `error`；409 冲突进入 `conflict` 且不自动重试覆盖。

- [ ] **步骤 3：运行测试，确认模型和协调器尚不存在**

运行：

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/note-model.test.ts src/renderer/src/components/desktop/notes-page/note-recovery.test.ts src/renderer/src/components/desktop/notes-page/note-save-coordinator.test.ts src/renderer/src/components/desktop/notes-page/use-notes-controller.test.tsx
```

预期：FAIL，提示被测模块不存在。

- [ ] **步骤 4：实现纯函数模型和版本化恢复稿**

固定 storage keys：

```ts
export const NOTE_RECOVERY_STORAGE_KEY = "vykor.desktop.note-recovery-v1";
export const NOTE_SELECTED_STORAGE_KEY = "vykor.desktop.notes-selected-id-v1";
```

恢复稿结构：

```ts
export interface NoteRecoveryDraft {
  draftId: string;
  noteId: string | null;
  baseRevision: number | null;
  content: string;
  updatedAt: number;
}

export interface NoteRecoveryPort {
  write(draft: NoteRecoveryDraft): void;
  remove(draftId: string): void;
}
```

`note-model.ts` 定义统一列表视图：

```ts
export interface NoteView {
  draftId: string;
  noteId: string | null;
  content: string;
  revision: number | null;
  createdAt: number;
  updatedAt: number;
  recovered: boolean;
}
```

解析时只接受非空 `draftId`、合法 nullable ID/revision、字符串 content 和有限时间戳；坏数据返回空集合但不抛到页面。写入单条时读取集合、按 `draftId` 替换、再整体写回；成功保存只删除对应 `draftId`。Renderer 把持久记录和未保存草稿都投影成 `NoteView`，列表与选择统一使用稳定的 `draftId`；只有持久记录才有 `noteId` 和 `revision`。

- [ ] **步骤 5：实现单草稿保存协调器**

每个 `draftId` 对应一个 `NoteSaveCoordinator`。`stage` 同步写 recovery 后重置 300ms timer；`flush` 使用一个循环串行处理最新内容：

```ts
while (this.pending && this.pending.content !== this.savedContent) {
  const target = this.pending;
  this.pending = null;
  this.setStatus("saving");
  const saved = target.noteId
    ? await this.api.update(target.noteId, {
        content: target.content,
        expectedRevision: this.record!.revision,
      })
    : await this.api.create({ content: target.content });
  this.record = saved;
  this.savedContent = target.content;
  if (!this.pending || this.pending.content === saved.content) {
    this.recovery.remove(target.draftId);
  }
}
this.setStatus("saved");
```

错误时保持 `savedContent`、`pending` 和 recovery，不把状态改回 saved。`retry()` 重新进入 `flush`；`dispose()` 只清 timer，不清恢复稿。

错误识别以 typed client 的 `VykorApiError.status` 为准：409 进入 `conflict`，其他错误进入 `error`。冲突状态不会由 timer 自动重试，必须等用户选择重新载入或另存为新便签。

- [ ] **步骤 6：实现 `useNotesController` 并测试用户状态流**

Hook 暴露：

```ts
interface NotesController {
  notes: NoteView[];
  visibleNotes: NoteView[];
  selectedKey: string | null;
  content: string;
  query: string;
  status: "loading" | "idle" | "saving" | "saved" | "error" | "conflict";
  error: string | null;
  setQuery(value: string): void;
  createDraft(): void;
  select(draftId: string): Promise<void>;
  edit(content: string): void;
  retrySave(): Promise<void>;
  reloadConflict(): Promise<void>;
  saveConflictAsNew(): Promise<void>;
  removeSelected(): Promise<void>;
}
```

加载时把 SQLite records 与 recovery drafts 合并成 `NoteView`；优先选择持久化的最后 note ID，否则选择最近修改项；多条恢复稿在列表上标记待恢复。新建草稿用本地 `draftId` 选中，创建成功后保持同一 `draftId`，只补上 `noteId` 和 `revision`，因此列表不会闪跳。切换前 `await` 当前 coordinator 的 `flush()`，但保存失败不删除 recovery，也不阻止用户查看别的便签。

- [ ] **步骤 7：运行 Renderer 状态测试和 web 类型检查**

运行：

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/note-model.test.ts src/renderer/src/components/desktop/notes-page/note-recovery.test.ts src/renderer/src/components/desktop/notes-page/note-save-coordinator.test.ts src/renderer/src/components/desktop/notes-page/use-notes-controller.test.tsx
pnpm --filter @vykor/desktop typecheck:web
```

预期：全部 PASS，状态机类型无 `any` 逃逸。

- [ ] **步骤 8：提交自动保存交付物**

```bash
git add apps/desktop/src/renderer/src/components/desktop/notes-page/note-model.ts apps/desktop/src/renderer/src/components/desktop/notes-page/note-model.test.ts apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.ts apps/desktop/src/renderer/src/components/desktop/notes-page/note-recovery.test.ts apps/desktop/src/renderer/src/components/desktop/notes-page/note-save-coordinator.ts apps/desktop/src/renderer/src/components/desktop/notes-page/note-save-coordinator.test.ts apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.ts apps/desktop/src/renderer/src/components/desktop/notes-page/use-notes-controller.test.tsx
git commit -m "feat(desktop): coordinate note autosave and recovery"
```

---

### 任务 6：实现便签页面、路由和左栏入口

**文件：**

- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-list.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-editor.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/note-delete-dialog.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/notes-page.test.tsx`
- 创建：`apps/desktop/src/renderer/src/components/desktop/notes-page/index.ts`
- 创建：`apps/desktop/src/renderer/src/routes/_main.notes.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx`
- 修改：`apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx`
- 生成：`apps/desktop/src/renderer/src/routeTree.gen.ts`

- [ ] **步骤 1：编写失败的页面行为测试**

至少覆盖以下可见行为：

```tsx
it("focuses an empty editor, creates on first nonblank input and exposes save state", async () => {
  window.desktop.notes.list = vi.fn(async () => []);
  window.desktop.notes.create = vi.fn(async ({ content }) => ({
    id: "n1",
    content,
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
  }));

  act(() => root.render(<NotesPage />));
  await act(async () => await Promise.resolve());
  const editor = container.querySelector(
    'textarea[aria-label="便签正文"]',
  ) as HTMLTextAreaElement;
  expect(document.activeElement).toBe(editor);

  act(() => {
    editor.value = "idea";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(300));
  expect(window.desktop.notes.create).toHaveBeenCalledWith({ content: "idea" });
  expect(container.textContent).toContain("已保存");
});
```

再加用例：搜索正文并恢复搜索前选择；点击“＋”不立即创建空记录；保存失败显示重试和复制；删除必须确认；冲突显示“重新载入/另存为新便签”。

- [ ] **步骤 2：扩展 Sidebar 测试，先确认旧占位仍存在**

测试点击“便签”调用 `onOpenNotes`，点击后对应按钮具有选中样式；断言页面不再包含“拉取请求”。首次运行应因新 prop 和新 label 不存在而失败。

- [ ] **步骤 3：实现页面组件**

组件边界：

- `NoteList`：标题、“全部项目共用”标签、搜索、新建按钮、结果列表和无结果状态。
- `NoteEditor`：一个 `Textarea`、字数、相对时间、`aria-live` 保存状态、错误动作和更多菜单。
- `NoteDeleteDialog`：使用现有 `AlertDialog`，正文明确写“删除后无法恢复”。
- `NotesPage`：只组合 `useNotesController` 与上述展示组件，不重新实现保存逻辑。

列表标题/摘要只调用 `describeNote`。第一版正文保持单个纯文本 `Textarea`；不要引入 Lexical、Markdown preview、附件 drop zone、置顶或归档入口。

保存失败时“复制正文”调用现有 `window.desktop.clipboard.writeText(content)`，不直接访问浏览器 Clipboard API。

- [ ] **步骤 4：替换左栏占位并接入路由**

在 `SidebarProps` 新增 `onOpenNotes`；将静态 `secondaryNavigation` 改成有明确 ID 的项目，避免继续按中文 label 分支：

```ts
const secondaryNavigation = [
  { id: "notes", icon: StickyNote, label: "便签" },
  { id: "scheduled", icon: Clock3, label: "定时任务" },
  { id: "plugins", icon: PlugZap, label: "插件" },
] as const;
```

使用 `matchRoute({ to: "/notes" })` 设置选中态；`MainLayout` 注入 `onOpenNotes={() => void navigate({ to: "/notes" })}`。

路由文件：

```tsx
import { createFileRoute } from "@tanstack/react-router";
import { NotesPage } from "@renderer/components/desktop/notes-page";

export const Route = createFileRoute("/_main/notes")({
  component: NotesPage,
});
```

- [ ] **步骤 5：运行生成器更新 route tree**

运行：

```bash
pnpm --filter @vykor/desktop exec electron-vite build
```

预期：`routeTree.gen.ts` 自动包含 `/notes`；不要手工编辑生成文件。若构建因实现中的类型错误失败，先修复错误再继续，不能只保留生成文件。

- [ ] **步骤 6：运行页面、侧栏和类型检查**

运行：

```bash
pnpm --filter @vykor/desktop exec vitest run src/renderer/src/components/desktop/notes-page/notes-page.test.tsx src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx
pnpm --filter @vykor/desktop typecheck
```

预期：测试 PASS；`/notes` 路由类型可用；node/web 类型检查退出码 0。

- [ ] **步骤 7：提交 UI 交付物**

```bash
git add apps/desktop/src/renderer/src/components/desktop/notes-page apps/desktop/src/renderer/src/routes/_main.notes.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/main-layout.tsx apps/desktop/src/renderer/src/routeTree.gen.ts
git commit -m "feat(desktop): add global notes workspace"
```

---

### 任务 7：验证备份、migration 打包和跨层回归

**文件：**

- 创建：`packages/server/src/application/backup/application-backup.test.ts`
- 修改：仅在验证发现本功能缺口时修改前述便签文件；不要借机修无关失败。

- [ ] **步骤 1：编写失败的备份恢复测试**

```ts
it("backs up and restores global notes with their revisions", async () => {
  const directory = mkdtempSync(join(tmpdir(), "vk-note-backup-"));
  const sourcePath = join(directory, "source.db");
  const backupPath = join(directory, "backup");
  const restoredPath = join(directory, "restored.db");
  try {
    const source = new SessionStore({ path: sourcePath });
    const created = source.notes.create(
      { content: "before backup" },
      { id: "note", now: 10 },
    );
    source.notes.update(
      created.id,
      { content: "saved", expectedRevision: 1 },
      20,
    );
    await createApplicationBackup({ store: source, destination: backupPath });
    source.close();

    restoreApplicationBackup({ source: backupPath, storePath: restoredPath });
    const restored = new SessionStore({ path: restoredPath });
    expect(restored.notes.list()).toMatchObject([
      {
        id: "note",
        content: "saved",
        revision: 2,
        createdAt: 10,
        updatedAt: 20,
      },
    ]);
    restored.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
```

测试使用 `mkdtempSync` 创建 source/backup/restored 路径，并在 `finally` 递归删除测试目录。

- [ ] **步骤 2：运行备份测试并确认实现行为**

运行：

```bash
pnpm --filter @vykor/server exec vitest run src/application/backup/application-backup.test.ts
```

预期：PASS；如果失败，只修复 notes 未进入现有数据库备份的真实缺口，不新增第二套备份文件。

- [ ] **步骤 3：运行全部针对性测试**

运行：

```bash
pnpm --filter @vykor/protocol exec vitest run src/notes.test.ts
pnpm --filter @vykor/services exec vitest run src/notes/note-repository.test.ts src/database/session-database.test.ts
pnpm --filter @vykor/server exec vitest run src/http/routes/notes.test.ts src/application/backup/application-backup.test.ts
pnpm --filter @vykor/client exec vitest run src/transport/__test__/http-client.test.ts src/__test__/public-api.test.ts
pnpm --filter @vykor/desktop exec vitest run src/main/features/notes/ipc.test.ts src/preload/desktop-api.test.ts src/renderer/src/components/desktop/notes-page/note-model.test.ts src/renderer/src/components/desktop/notes-page/note-recovery.test.ts src/renderer/src/components/desktop/notes-page/note-save-coordinator.test.ts src/renderer/src/components/desktop/notes-page/use-notes-controller.test.tsx src/renderer/src/components/desktop/notes-page/notes-page.test.tsx src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx
```

预期：全部 PASS，无 skipped 或 unhandled rejection。

- [ ] **步骤 4：验证 migration artifact 与跨包类型**

运行：

```bash
pnpm --filter @vykor/services db:check
pnpm --filter @vykor/desktop exec node --test scripts/verify-migration-artifact.test.mjs
pnpm check-types
node scripts/check-docs.mjs
```

预期：Drizzle、migration artifact、全部 33 个 workspace 类型检查和文档检查都退出 0。

- [ ] **步骤 5：核对需求清单和提交范围**

运行：

```bash
git status --short
git diff --check
git log --oneline --decorate -7
```

逐项人工核对：左栏已替换、全局列表 + 编辑器、新建不留空记录、300ms 自动保存、revision 防旧写、恢复稿、全文搜索、确认删除、数据库重开、备份恢复。确认没有出现二期入口：置顶、归档、回收站、文件夹、标签、颜色、Markdown 预览、富文本、附件、项目关联、AI、同步、系统快捷键或悬浮窗。

- [ ] **步骤 6：提交备份测试或最终修正**

```bash
git add packages/server/src/application/backup/application-backup.test.ts
git commit -m "test(notes): verify backup recovery"
```

若步骤 2-5 暴露了便签实现缺口，把对应便签文件一并加入此提交，并在提交说明中准确描述；不得纳入工作区中的无关改动。

- [ ] **步骤 7：确认最终工作区只剩执行者明确保留的非本功能修改**

运行：

```bash
git status --short
git diff --check
```

预期：隔离 worktree 为空；若执行者明确保留了非本功能调试文件，必须在交接中逐项列出，不能声称工作区干净。

---

## 完成定义

- 设计规格 `docs/superpowers/specs/2026-10-04-global-notes-design.md` 的 10 条验收标准全部有测试或明确人工核对证据。
- 任务 1-7 的针对性测试、migration artifact 检查和 `pnpm check-types` 均以退出码 0 完整运行。
- Git 历史保留协议、持久化、API、Desktop bridge、自动保存、UI、备份七个可审查交付物。
- 工作区不包含本功能之外的新修改；现有用户改动没有被覆盖、回退或顺带提交。
