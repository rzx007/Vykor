# Write 工具读后写保护与写入反馈 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `Write` 在覆盖**已存在**文件前要求模型先读过它（跨会话的读记录），同时保留 BOM、区分新建/覆盖并回报规模。

**架构：** `packages/core` 新增会话级 `ReadFileRegistry` 类型与实现，由 `QueryEngine`（会话级实例）构造并注入 `ToolContext`；`Read` 成功时登记，`Write` 覆盖已存在文件前查询。

**技术栈：** TypeScript、Vitest、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-22-write-tool-guard-and-feedback-design.md`

## 全局约束

- 新增类型名固定 `ReadFileRegistry`，字段名固定 `ToolContext.readFiles`，工厂名固定 `createReadFileRegistry`、`normalizeReadPath`。
- 归一化**按路径形状**判定，不按 `process.platform`：盘符（`/^[a-zA-Z]:\//`）或 UNC（`//` 开头）→ 小写；否则保留大小写。函数签名 `normalizeReadPath(path: string): string`（单参数）。
- 默认 `maxEntries = 4096`，FIFO 淘汰。
- 拒绝文案逐字：`` `Refusing to overwrite ${filePath} because it has not been read in this session. Read the file first, then write.` ``
- 写入反馈逐字：`` `Created ${filePath} (${lines} lines, ${bytes} bytes)` `` / `` `Overwrote ${filePath} (${lines} lines, ${bytes} bytes)` ``
- BOM 规则：`content` 的前导 BOM **一律丢弃**；**仅当原文件有 BOM** 时补回一个。因此新建文件与覆盖无 BOM 文件的结果都是 0 个 BOM。
- `context.readFiles` 缺失（`undefined`）时**跳过检查、放行**。
- `Write` 成功后**不**把文件标为已读。
- 存在性判定用 `operations.stat`，**不得**用 `readText` 探测（会把「存在但读不了」误判为不存在而绕过检查）。
- 不修改 `operations.ts`、`edit.ts`、`read.ts` 的既有输出格式。
- 测试命令：`pnpm --filter @openharness/core exec vitest run <file>`、`pnpm --filter @openharness/tools exec vitest run <file>`。
- 类型检查：`pnpm --filter @openharness/core run typecheck`、`pnpm --filter @openharness/tools run typecheck`。

## 已知行为变化

本计划完成后，**生产环境（daemon 经 `QueryEngine` 注入 `readFiles`）会真正启用读后写检查**：模型若要覆盖任何已存在文件，必须先 `Read`。这会影响既有 agent 行为（例如上一轮 `Write` 新建的文件，本轮再改时必须先 `Read`）。这是本功能的目的，但实施后应关注是否有既有自动化流程因此受阻。单元测试因不传 `readFiles` 而不受影响。

---

### 任务 1：`ReadFileRegistry` 类型与实现

**文件：**
- 修改：`packages/core/src/types/tools.ts`
- 创建：`packages/core/src/engine/read-file-registry.ts`
- 创建：`packages/core/src/engine/read-file-registry.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/core/src/engine/read-file-registry.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import { createReadFileRegistry, normalizeReadPath } from "./read-file-registry.js";

describe("normalizeReadPath", () => {
  it("lowercases Windows-shaped paths and unifies separators", () => {
    expect(normalizeReadPath("C:\\A\\B.txt")).toBe("c:/a/b.txt");
    expect(normalizeReadPath("c:/a/b.txt")).toBe("c:/a/b.txt");
  });

  it("preserves case for POSIX-shaped paths", () => {
    expect(normalizeReadPath("/A/B.txt")).toBe("/A/B.txt");
    expect(normalizeReadPath("/A/B.txt")).not.toBe(normalizeReadPath("/a/b.txt"));
  });

  it("keeps WSL mount paths case-sensitive", () => {
    expect(normalizeReadPath("/mnt/d/A.txt")).not.toBe(normalizeReadPath("/mnt/d/a.txt"));
  });

  it("treats UNC paths as Windows-shaped", () => {
    expect(normalizeReadPath("\\\\Server\\Share\\X")).toBe("//server/share/x");
  });

  it("ignores trailing separators", () => {
    expect(normalizeReadPath("C:\\A\\")).toBe(normalizeReadPath("c:/a"));
  });
});

describe("createReadFileRegistry", () => {
  it("records reads and reports them case-insensitively on Windows paths", () => {
    const registry = createReadFileRegistry();
    expect(registry.hasRead("C:\\A\\B.txt")).toBe(false);

    registry.markRead("C:\\A\\B.txt");

    expect(registry.hasRead("c:/a/b.txt")).toBe(true);
  });

  it("does not treat differently-cased POSIX paths as the same file", () => {
    const registry = createReadFileRegistry();
    registry.markRead("/mnt/d/A.txt");

    expect(registry.hasRead("/mnt/d/A.txt")).toBe(true);
    expect(registry.hasRead("/mnt/d/a.txt")).toBe(false);
  });

  it("evicts the oldest entry beyond maxEntries", () => {
    const registry = createReadFileRegistry({ maxEntries: 2 });
    registry.markRead("C:/one.txt");
    registry.markRead("C:/two.txt");
    registry.markRead("C:/three.txt");

    expect(registry.hasRead("C:/one.txt")).toBe(false);
    expect(registry.hasRead("C:/two.txt")).toBe(true);
    expect(registry.hasRead("C:/three.txt")).toBe(true);
  });

  it("ignores empty paths", () => {
    const registry = createReadFileRegistry();
    registry.markRead("   ");
    expect(registry.hasRead("   ")).toBe(false);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/core exec vitest run src/engine/read-file-registry.test.ts`
预期：FAIL，报错无法解析 `./read-file-registry.js`。

- [ ] **步骤 3：新增类型**

在 `packages/core/src/types/tools.ts` 的 `ToolContext` 定义之前加入：

```ts
/** 会话级：本会话内已成功读取过的文件路径。 */
export interface ReadFileRegistry {
  markRead(path: string): void;
  hasRead(path: string): boolean;
}
```

并在 `ToolContext` 内（`sessionId` 附近）加入：

```ts
  /** 会话级已读文件记录；缺省时 Write 的读后写检查被跳过。 */
  readFiles?: ReadFileRegistry;
```

- [ ] **步骤 4：实现 registry**

创建 `packages/core/src/engine/read-file-registry.ts`：

```ts
import type { ReadFileRegistry } from "../types/tools.js";

const DEFAULT_MAX_ENTRIES = 4096;

/**
 * 归一化用于比较的路径：反斜杠转正斜杠、去尾部斜杠；
 * 仅当路径是 Windows 形态（盘符或 UNC）时小写，POSIX 形态保留大小写。
 */
export function normalizeReadPath(path: string): string {
  const forward = path.replace(/\\/g, "/");
  const windowsStyle = /^[a-zA-Z]:\//.test(forward) || forward.startsWith("//");
  const stripped = forward.replace(/\/+$/, "");
  return windowsStyle ? stripped.toLowerCase() : stripped;
}

export function createReadFileRegistry(
  options: { maxEntries?: number } = {},
): ReadFileRegistry {
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const seen = new Set<string>();

  return {
    markRead(path: string): void {
      const key = normalizeReadPath(path);
      if (!key.trim()) return;
      // 先删再插：重复标记会把条目移到队尾，淘汰始终针对最久未标记的。
      seen.delete(key);
      seen.add(key);
      while (seen.size > maxEntries) {
        const oldest = seen.values().next().value;
        if (oldest === undefined) break;
        seen.delete(oldest);
      }
    },
    hasRead(path: string): boolean {
      const key = normalizeReadPath(path);
      return key.trim() ? seen.has(key) : false;
    },
  };
}
```

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @openharness/core exec vitest run src/engine/read-file-registry.test.ts`
预期：PASS。

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/types/tools.ts packages/core/src/engine/read-file-registry.ts packages/core/src/engine/read-file-registry.test.ts
git commit -m "feat(core): add a session-scoped read file registry"
```

---

### 任务 2：`QueryEngine` 注入 registry

**文件：**
- 修改：`packages/core/src/engine/query-engine.ts`
- 创建：`packages/core/src/engine/query-engine-read-files.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/core/src/engine/query-engine-read-files.test.ts`：

```ts
import { expect, it } from "vitest";

import type { StreamEvent, ToolContext } from "../index.js";
import { QueryEngine } from "./query-engine.js";
import { ToolRegistry } from "./tool-registry.js";

it("shares one read-file registry across turns of the same engine", async () => {
  const registry = new ToolRegistry();
  const contexts: ToolContext[] = [];

  registry.register({
    name: "Probe",
    description: "captures its tool context",
    inputSchema: { type: "object" },
    execute: async (_input, context) => {
      contexts.push(context);
      context.readFiles?.markRead("C:/probe.txt");
      return { content: [] };
    },
  });

  let callCount = 0;
  const engine = new QueryEngine(
    {
      streamMessage: async function* () {
        callCount += 1;
        if (callCount % 2 === 1) {
          yield {
            type: "tool_use_start",
            toolUse: { type: "tool_use", id: `tu${callCount}`, name: "Probe", input: {} },
          } as StreamEvent;
          yield { type: "complete", stopReason: "tool_use" } as StreamEvent;
          return;
        }
        yield { type: "complete", stopReason: "end_turn" } as StreamEvent;
      },
    },
    registry,
    { checkTool: async () => ({ action: "allow", reason: "test" }) },
    { execute: async () => ({ blocked: false }) } as any,
    { systemPrompt: "base" },
  );

  for await (const _ of engine.submitMessage("one")) {
    /* drain */
  }
  for await (const _ of engine.submitMessage("two")) {
    /* drain */
  }

  expect(contexts.length).toBeGreaterThanOrEqual(2);
  const [first, second] = contexts;
  expect(first?.readFiles).toBeDefined();
  expect(typeof first?.readFiles?.markRead).toBe("function");
  expect(typeof first?.readFiles?.hasRead).toBe("function");
  // 行为断言：第一轮登记的路径在第二轮仍可见（跨轮次共享）。
  expect(second?.readFiles?.hasRead("c:/probe.txt")).toBe(true);
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/core exec vitest run src/engine/query-engine-read-files.test.ts`
预期：FAIL，`first.readFiles` 为 `undefined`。

- [ ] **步骤 3：在 `QueryEngine` 上构造并注入**

在 `packages/core/src/engine/query-engine.ts` 顶部补 import：

```ts
import { createReadFileRegistry } from "./read-file-registry.js";
```

在 `QueryEngine` 类的私有字段区（`private sessionId: string | undefined;` 附近）加入：

```ts
  private readonly readFiles = createReadFileRegistry();
```

在组装 `ToolContext` 的字面量里（`sessionId: this.sessionId,` 之后）加入：

```ts
            readFiles: this.readFiles,
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/core exec vitest run src/engine/query-engine-read-files.test.ts`
预期：PASS。

- [ ] **步骤 5：跑 core 全量测试与类型检查**

运行：`pnpm --filter @openharness/core exec vitest run`
预期：全绿。

运行：`pnpm --filter @openharness/core run typecheck`
预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/core/src/engine/query-engine.ts packages/core/src/engine/query-engine-read-files.test.ts
git commit -m "feat(core): inject the read file registry into tool contexts"
```

---

### 任务 3：`Read` 成功时登记

**文件：**
- 修改：`packages/tools/src/file/read.ts`
- 修改：`packages/tools/src/file/__test__/read.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/tools/src/file/__test__/read.test.ts` 末尾追加：

```ts
function trackingRegistry(): { seen: Set<string>; readFiles: ReadFileRegistry } {
  const seen = new Set<string>();
  return {
    seen,
    readFiles: {
      markRead: (path: string) => void seen.add(path),
      hasRead: (path: string) => seen.has(path),
    },
  };
}

describe("fileReadTool read registry", () => {
  it("records a successfully read file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-mark-"));
    try {
      const file = join(dir, "marked.txt");
      await writeFile(file, "hello", "utf-8");
      const { seen, readFiles } = trackingRegistry();

      await fileReadTool.execute!({ file_path: file }, { cwd: dir, readFiles });

      expect([...seen].some((path) => path.endsWith("marked.txt"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not record a directory listing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-mark-dir-"));
    try {
      await mkdir(join(dir, "app"));
      const { seen, readFiles } = trackingRegistry();

      await fileReadTool.execute!({ file_path: dir }, { cwd: dir, readFiles });

      expect(seen.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("does not record a rejected binary read", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-mark-bin-"));
    try {
      const file = join(dir, "bin.dat");
      await writeFile(file, Buffer.from([0x68, 0x00, 0x69]));
      const { seen, readFiles } = trackingRegistry();

      await fileReadTool.execute!({ file_path: file }, { cwd: dir, readFiles });

      expect(seen.size).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("records a successfully read image", async () => {
    const dir = await mkdtemp(join(tmpdir(), "oh-read-mark-img-"));
    try {
      const file = join(dir, "screenshot.png");
      await writeFile(
        file,
        Buffer.from(
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
          "base64",
        ),
      );
      const { seen, readFiles } = trackingRegistry();

      await fileReadTool.execute!({ file_path: file }, { cwd: dir, readFiles });

      expect([...seen].some((path) => path.endsWith("screenshot.png"))).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
```

并在文件顶部补类型导入：

```ts
import type { ReadFileRegistry } from "@openharness/core";
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：FAIL。前 3 条断言 `seen` 为空（现在没有任何登记），图片那条同样失败。

- [ ] **步骤 3：在两个成功分支登记**

在 `packages/tools/src/file/read.ts` 中：

1. **图片成功**分支——在返回 `type: "image"` 结果之前加一行：

```ts
        context.readFiles?.markRead(filePath);
```

2. **文本成功**分支——在返回编号文本结果之前加同一行：

```ts
      context.readFiles?.markRead(filePath);
```

**不要**在目录分支、二进制拒绝分支、越界分支、以及 `catch` 里登记。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：PASS（既有用例 + 新增 4 条）。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts
git commit -m "feat(tools): record successfully read files in the session registry"
```

---

### 任务 4：`Write` 读后写检查、BOM 与写入反馈

**文件：**
- 修改：`packages/tools/src/file/write.ts`
- 创建：`packages/tools/src/file/__test__/write.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/tools/src/file/__test__/write.test.ts`：

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { ReadFileRegistry } from "@openharness/core";

import { fileWriteTool } from "../write.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "oh-write-"));
  roots.push(dir);
  return dir;
}

function fakeRegistry(): { seen: Set<string>; readFiles: ReadFileRegistry } {
  const seen = new Set<string>();
  return {
    seen,
    readFiles: {
      markRead: (path: string) => void seen.add(path),
      hasRead: (path: string) => seen.has(path),
    },
  };
}

const BOM = "\uFEFF";

/** 从工具结果里取第一段文本，避免每个断言重复 cast。 */
function outputText(result: { content: unknown[] }): string {
  return (result.content[0] as { text: string }).text;
}

describe("fileWriteTool", () => {
  it("creates a new file and reports its size", async () => {
    const dir = await tempDir();
    const file = join(dir, "new.txt");

    const result = await fileWriteTool.execute!({ file_path: file, content: "hello" }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect(outputText(result).startsWith("Created ")).toBe(true);
    expect(outputText(result)).toContain("new.txt");
    expect(outputText(result)).toContain("(1 lines, 5 bytes)");
    expect(await readFile(file, "utf8")).toBe("hello");
  });

  it("overwrites a file that has been read", async () => {
    const dir = await tempDir();
    const file = join(dir, "existing.txt");
    await writeFile(file, "old", "utf8");
    const { readFiles } = fakeRegistry();
    readFiles.markRead(file);

    const result = await fileWriteTool.execute!(
      { file_path: file, content: "new" },
      { cwd: dir, readFiles },
    );

    expect(result.isError).toBeFalsy();
    expect(outputText(result).startsWith("Overwrote ")).toBe(true);
    expect(outputText(result)).toContain("(1 lines, 3 bytes)");
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("refuses to overwrite a file that was not read", async () => {
    const dir = await tempDir();
    const file = join(dir, "unread.txt");
    await writeFile(file, "keep", "utf8");
    const { readFiles } = fakeRegistry();

    const result = await fileWriteTool.execute!(
      { file_path: file, content: "clobber" },
      { cwd: dir, readFiles },
    );

    expect(result.isError).toBe(true);
    expect(outputText(result)).toContain("has not been read in this session");
    expect(outputText(result)).toContain("unread.txt");
    expect(await readFile(file, "utf8")).toBe("keep");
  });

  it("allows overwriting when no read registry is provided", async () => {
    const dir = await tempDir();
    const file = join(dir, "legacy.txt");
    await writeFile(file, "old", "utf8");

    const result = await fileWriteTool.execute!({ file_path: file, content: "new" }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("preserves exactly one BOM when overwriting a BOM file", async () => {
    const dir = await tempDir();
    const file = join(dir, "bom.txt");
    await writeFile(file, `${BOM}old`, "utf8");
    const { readFiles } = fakeRegistry();
    readFiles.markRead(file);

    await fileWriteTool.execute!({ file_path: file, content: "new" }, { cwd: dir, readFiles });

    expect(await readFile(file, "utf8")).toBe(`${BOM}new`);
  });

  it("keeps exactly one BOM when content also carries one", async () => {
    const dir = await tempDir();
    const file = join(dir, "bom2.txt");
    await writeFile(file, `${BOM}old`, "utf8");
    const { readFiles } = fakeRegistry();
    readFiles.markRead(file);

    await fileWriteTool.execute!({ file_path: file, content: `${BOM}new` }, { cwd: dir, readFiles });

    expect(await readFile(file, "utf8")).toBe(`${BOM}new`);
  });

  it("drops a leading BOM from content when the target has none", async () => {
    const dir = await tempDir();
    const file = join(dir, "plain.txt");
    await writeFile(file, "old", "utf8");
    const { readFiles } = fakeRegistry();
    readFiles.markRead(file);

    await fileWriteTool.execute!({ file_path: file, content: `${BOM}new` }, { cwd: dir, readFiles });

    expect(await readFile(file, "utf8")).toBe("new");
  });

  it("does not mark a file as read after writing it", async () => {
    const dir = await tempDir();
    const file = join(dir, "twice.txt");
    const { readFiles } = fakeRegistry();

    const first = await fileWriteTool.execute!(
      { file_path: file, content: "one" },
      { cwd: dir, readFiles },
    );
    expect(first.isError).toBeFalsy();

    const second = await fileWriteTool.execute!(
      { file_path: file, content: "two" },
      { cwd: dir, readFiles },
    );

    expect(second.isError).toBe(true);
    expect(await readFile(file, "utf8")).toBe("one");
  });

  it("reports zero lines and bytes for empty content", async () => {
    const dir = await tempDir();
    const file = join(dir, "empty.txt");

    const result = await fileWriteTool.execute!({ file_path: file, content: "" }, { cwd: dir });

    expect(outputText(result)).toContain("(0 lines, 0 bytes)");
    expect(await readFile(file, "utf8")).toBe("");
  });

  it("advertises the read-before-write requirement", () => {
    expect(fileWriteTool.description.toLowerCase()).toContain("overwrite");
    expect(fileWriteTool.description.toLowerCase()).toContain("read");
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/write.test.ts`
预期：FAIL。当前 `Write` 返回 `Successfully wrote to ...`，没有拒绝逻辑、没有 BOM 处理。

- [ ] **步骤 3：改写 `write.ts`**

在 `packages/tools/src/file/write.ts` 顶部补 import：

```ts
import { splitReadLines } from "./read.js";
```

把 `description` 改为：

```ts
  description:
    "Write a file to the local filesystem. Overwrites the existing file entirely. If the target file already exists, you MUST read it first with the Read tool; otherwise this tool refuses to overwrite it. Does not add a byte-order mark.",
```

把 `execute` 中「sandbox 校验之后」的整段替换为：

```ts
      const operations = fileOperationsFor(context);

      let exists = false;
      try {
        exists = (await operations.stat(filePath)).isFile;
      } catch {
        exists = false;
      }

      const registry = context.readFiles;
      if (exists && registry && !registry.hasRead(filePath)) {
        return {
          content: [
            {
              type: "text",
              text: `Refusing to overwrite ${filePath} because it has not been read in this session. Read the file first, then write.`,
            },
          ],
          isError: true,
        };
      }

      let hasBom = false;
      if (exists) {
        try {
          hasBom = (await operations.readText(filePath)).startsWith("\uFEFF");
        } catch {
          hasBom = false;
        }
      }

      const body = content.startsWith("\uFEFF") ? content.slice(1) : content;
      await operations.writeText(filePath, (hasBom ? "\uFEFF" : "") + body);

      const lines = splitReadLines(body).length;
      const bytes = Buffer.byteLength(body, "utf8");
      const verb = exists ? "Overwrote" : "Created";
      return {
        content: [{ type: "text", text: `${verb} ${filePath} (${lines} lines, ${bytes} bytes)` }],
      };
```

保持前面的路径解析、managed-persistence、系统目录、sandbox 校验与 `catch` 分支**原样不变**。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/write.test.ts`
预期：PASS（10 条）。

- [ ] **步骤 5：跑 tools 全量测试与类型检查**

运行：`pnpm --filter @openharness/tools exec vitest run`
预期：全绿（重点确认 `operations.test.ts`、`edit.test.ts`、`read.test.ts`、`preview.test.ts` 不回归）。

运行：`pnpm --filter @openharness/tools run typecheck`
预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/write.ts packages/tools/src/file/__test__/write.test.ts
git commit -m "feat(tools): require a prior read before overwriting a file"
```

---

## 自检记录

- **规格覆盖度**：规格「接口 · core 类型」→ 任务 1 步骤 3；「接口 · read-file-registry」→ 任务 1 步骤 4；「接口 · query-engine」→ 任务 2 步骤 3；「接口 · read.ts」→ 任务 3 步骤 3；「接口 · write.ts」→ 任务 4 步骤 3；「运行流程 · Write 执行」8 步 → 任务 4 步骤 3（stat 判存在、拒绝、BOM、反馈）；「运行流程 · Read 记录」→ 任务 3 步骤 3；决策 3/4（归一化与有界）→ 任务 1；决策 5/6/7/8/9/10/11/12 → 任务 3/4 的代码与测试；规格「测试」四个文件 → 任务 1（registry）、任务 2（query-engine）、任务 3（read 追加）、任务 4（write 新建）。
- **占位符扫描**：无 TODO / 「待定」 / 「类似任务 N」；每个代码步骤均含完整可粘贴代码与真实断言。
- **类型一致性**：`ReadFileRegistry`、`createReadFileRegistry`、`normalizeReadPath`、`ToolContext.readFiles`、`splitReadLines` 在各任务间命名一致；`write.ts` 从 `./read.js` 导入 `splitReadLines`（read.ts 不依赖 write.ts，无循环）。
- **断言稳健性**：路径相关的断言一律用「前缀/包含 + 后缀精确」而非整体 `toBe`，避免 Windows 下 `resolveToolPathInContext` 的路径形态（盘符大小写、斜杠）导致误报。
- **任务边界**：任务 1 只加类型与 registry（不影响既有测试）；任务 2 只加注入（`readFiles` 可选，工具未使用它之前行为不变）；任务 3 只加登记（`readFiles` 缺省时无副作用）；任务 4 才改变 `Write` 的可见行为，并同批建立 `write.test.ts`。每个任务结束时对应包的测试应为绿。
- **自查中修正的三处**：① registry 对纯空白路径必须用 `key.trim()` 判空（否则 `"   "` 会被当作有效键写入）；② 测试结果取值改用 `outputText` 辅助函数，避免 `Awaited<ReturnType<...>>` 的脆弱类型；③ 明确 `hookExecutor` 测试替身用 `as any`（与 `goal-context.test.ts` 既有写法一致）。
