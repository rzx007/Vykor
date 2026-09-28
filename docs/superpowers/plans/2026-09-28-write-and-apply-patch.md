# Write 安全化与 ApplyPatch 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 将 `Write` 收紧为安全创建/显式覆盖，并新增基于 `diff@7` 的多文件 `ApplyPatch`，避免盲目整文件覆盖和自研 diff 引擎。

**架构：** 第一阶段扩展共享环境文件系统的 exclusive create、原子替换和单文件删除原语，并接入 Write 的 overwrite/no-op/hash 语义。第二阶段用现有 `diff@7` 解析和应用标准 unified diff，先对全部文件预演与校验，再按稳定顺序落盘；不实现跨文件回滚、rename、fuzzy patch 或 UI review。

**技术栈：** TypeScript、Vitest、Node 标准库、现有 `diff@7`、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-28-write-and-apply-patch-design.md`

---

## 全局约束

- 先完整阅读规格和当前 `read.ts`、`write.ts`、`edit.ts`、`preview.ts`、`operations.ts`、environment types、registry/index。
- 严格 TDD：每个行为先写失败测试并实际看到正确红灯，再写生产代码。
- 优先复用 `diff@7`；禁止自行实现 unified diff parser 或通用 hunk matcher。
- 不新增 npm 依赖。SHA-256 使用 `node:crypto`。
- `ApplyPatch` 首版只支持 create/update/delete；拒绝 rename/copy/mode/binary patch。
- 不实现跨文件事务回滚、备份目录、append/chunk write、自动 merge 或 diff review UI。
- patch 内路径只接受 POSIX `/`；拒绝绝对路径、反斜杠、盘符、UNC、NUL、空路径和 `..` 段。
- `diff.applyPatch` 固定 `fuzzFactor: 0`，接受 jsdiff 对完全匹配上下文的行号偏移语义。
- `compactSummary` 必须不超过 1000 字符，不含文件正文。
- 所有新增数组索引适配 `noUncheckedIndexedAccess`。
- 不要覆盖工作区现有用户修改；不要使用 `git checkout --`、`git reset --hard`。
- 若执行者按用户指示不提交，跳过每个任务的 Commit 步骤即可，其余步骤不变。

## 目标文件

| 文件 | 操作 | 职责 |
|---|---|---|
| `packages/environment/src/types.ts` | 修改 | 扩展共享文件系统原语 |
| `packages/tools/src/file/operations.ts` | 修改 | Host/WSL 原子创建、替换、删除 |
| `packages/tools/src/file/__test__/operations.test.ts` | 修改 | Host/WSL 原语测试 |
| `packages/tools/src/file/write.ts` | 修改 | overwrite/no-op/hash/反馈 |
| `packages/tools/src/file/__test__/write.test.ts` | 修改 | Write 端到端行为 |
| `packages/tools/src/file/text-content.ts` | 创建 | Read/ApplyPatch 共用严格 UTF-8 与二进制判断 |
| `packages/tools/src/file/read.ts` | 修改 | 改为导入共享文本 helper，不改变行为 |
| `packages/tools/src/file/apply-patch.ts` | 创建 | patch 解析、预演、复核、落盘 |
| `packages/tools/src/file/__test__/apply-patch.test.ts` | 创建 | ApplyPatch 纯函数与端到端测试 |
| `packages/tools/src/file/index.ts` | 修改 | 文件工具导出 |
| `packages/tools/src/index.ts` | 修改 | 包导出 |
| `packages/tools/src/registry.ts` | 修改 | 注册内置 ApplyPatch |

---

## 阶段一：Write 安全化

### 任务 1：扩展环境文件系统原子原语

**文件：**
- 修改：`packages/environment/src/types.ts`
- 修改：`packages/tools/src/file/operations.ts`
- 修改：`packages/tools/src/file/__test__/operations.test.ts`

- [ ] **步骤 1：为 Host 原语编写失败测试**

在 `operations.test.ts` 中直接实例化 `HostFileOperations`，追加：

```ts
it("creates a new file exclusively and creates parent directories", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-atomic-create-"));
  roots.push(root);
  const file = join(root, "nested", "new.txt");
  const operations = new HostFileOperations();

  await operations.createTextExclusive(file, "first");
  await expect(operations.createTextExclusive(file, "second")).rejects.toThrow();
  expect(await readFile(file, "utf8")).toBe("first");
});

it("atomically replaces an existing host file", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-atomic-replace-"));
  roots.push(root);
  const file = join(root, "value.txt");
  const operations = new HostFileOperations();
  await writeFile(file, "old", "utf8");

  await operations.writeTextAtomic(file, "new");
  expect(await readFile(file, "utf8")).toBe("new");
  expect((await readdir(root)).filter((name) => name.startsWith(".vykor-write-"))).toEqual([]);
});

it("removes a file but refuses a directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "vk-remove-file-"));
  roots.push(root);
  const file = join(root, "gone.txt");
  const operations = new HostFileOperations();
  await writeFile(file, "x", "utf8");

  await operations.removeFile(file);
  await expect(readFile(file)).rejects.toThrow();
  await expect(operations.removeFile(root)).rejects.toThrow();
});
```

补充测试 import：

```ts
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { HostFileOperations, WslFileOperations } from "../operations.js";
```

- [ ] **步骤 2：运行测试确认红灯**

运行：

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/operations.test.ts
```

预期：FAIL，三个新方法不存在。

- [ ] **步骤 3：扩展共享接口**

在 `EnvironmentFileSystem` 中加入必选方法：

```ts
createTextExclusive(path: string, content: string): Promise<void>;
writeTextAtomic(path: string, content: string): Promise<void>;
removeFile(path: string): Promise<void>;
```

不要把它们只加在 `FileOperations`，因为 `fileOperationsFor(context)` 会直接返回 `context.environment.files`。

同时在 `operations.ts` 导出：

```ts
export class FileNotFoundError extends Error {
  constructor(readonly path: string) {
    super(`Path not found: ${path}`);
    this.name = "FileNotFoundError";
  }
}
```

`HostFileOperations.stat/readBytes` 只把带 `code === "ENOENT"` 的 Node 错误映射成该类型；`WslFileOperations.stat/readBytes` 只把其固定命令的“目标不存在”退出分支映射成该类型。权限、目录误用和其它 I/O 错误不得映射。为 Host 和 WSL 各加不存在/权限非不存在测试。

`EnvironmentFileStat` 增加可选 `isSymbolicLink?: boolean`。Host 用 `lstat` 标注符号链接，WSL 固定 stat 脚本先检查 `-L` 并返回单独标记；Read 可继续按现有规则读取，Write 与 ApplyPatch 拒绝符号链接目标。WSL 的不存在脚本沿父目录向上查找最近已存在的祖先，仅在它是可搜索目录时返回专用退出码，其余失败保留原错误。

- [ ] **步骤 4：实现 Host 最小原语**

在 `operations.ts` 增加所需标准库 import：

```ts
import { link, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative } from "node:path";
import { randomUUID } from "node:crypto";
```

在 `HostFileOperations` 中实现：

```ts
async createTextExclusive(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.vykor-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await link(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async writeTextAtomic(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  let existingMode: number | undefined;
  try {
    existingMode = (await stat(path)).mode & 0o7777;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  const temporary = join(dirname(path), `.vykor-write-${randomUUID()}`);
  try {
    const handle = await open(temporary, "wx");
    try {
      await handle.writeFile(content, "utf8");
      if (existingMode !== undefined) await handle.chmod(existingMode);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

async removeFile(path: string): Promise<void> {
  const item = await stat(path);
  if (!item.isFile()) throw new Error(`Refusing to remove non-file path: ${path}`);
  await unlink(path);
}
```

若 Windows 的 `rename` 不能覆盖现有目标，测试会暴露。只针对该平台分支做最小兼容处理；不得先删除目标再 rename，因为那会破坏原子性。记录该平台限制并停下来让用户决定，而不是静默退化。

- [ ] **步骤 5：为 WSL 命令写失败测试并实现**

扩展现有 fake environment，使其记录 argv/stdin；测试必须断言路径只出现在位置参数，不插入脚本文本：

```ts
expect(calls.at(-1)?.argv.slice(-2)).toEqual(["vk-atomic", "/tmp/a;touch-pwned.txt"]);
expect(calls.at(-1)?.argv[2]).not.toContain("touch-pwned");
```

实现使用固定 shell 脚本：

```sh
set -eu
target=$1
parent=$(dirname -- "$target")
mkdir -p -- "$parent"
tmp=$(mktemp -- "$parent/.vykor-write.XXXXXX")
trap 'rm -f -- "$tmp"' EXIT
cat > "$tmp"
if [ -e "$target" ]; then chmod --reference="$target" -- "$tmp"; fi
# atomic replace: mv -T -f -- "$tmp" "$target"
# exclusive create: ln -- "$tmp" "$target"
```

分别为 replace/exclusive 使用两个固定脚本或一个固定 mode 参数；不得把路径或 content 拼进脚本。`removeFile` 使用 `/bin/rm -- "$1"` 前先以固定脚本验证 `[ -f "$1" ]`。

- [ ] **步骤 6：修复受接口扩展影响的完整测试替身**

运行：

```bash
pnpm --filter @vykor/environment run check-types
pnpm --filter @vykor/tools run check-types
```

只给真正声明为完整 `EnvironmentFileSystem` 的实现补方法。使用 `as unknown as ExecutionEnvironmentHandle` 且测试不走写入路径的局部 partial mock 不要机械扩写。

- [ ] **步骤 7：验证任务 1**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/operations.test.ts
pnpm --filter @vykor/environment run check-types
pnpm --filter @vykor/tools run check-types
```

预期：全部通过。

- [ ] **步骤 8：Commit**

```bash
git add packages/environment/src/types.ts packages/tools/src/file/operations.ts packages/tools/src/file/__test__/operations.test.ts
git commit -m "feat(tools): add atomic file operations"
```

---

### 任务 2：接入 Write 安全语义

**文件：**
- 修改：`packages/tools/src/file/write.ts`
- 修改：`packages/tools/src/file/__test__/write.test.ts`

- [ ] **步骤 1：编写完整失败测试**

在 `write.test.ts` 追加以下行为；沿用每个用例自己的临时目录并在 finally 清理：

```ts
it("refuses to overwrite an existing different file by default", async () => {
  await writeFile(file, "old", "utf8");
  const result = await fileWriteTool.execute({ file_path: file, content: "new" }, { cwd: dir });
  expect(result).toMatchObject({ isError: true, failureKind: "invalid_input", executionState: "not_started" });
  expect(await readFile(file, "utf8")).toBe("old");
});

it("overwrites only when overwrite is true", async () => {
  await writeFile(file, "old", "utf8");
  const result = await fileWriteTool.execute(
    { file_path: file, content: "new", overwrite: true },
    { cwd: dir },
  );
  expect(result).toMatchObject({ executionState: "completed" });
  expect((result.content[0] as { text: string }).text).toContain("Overwrote");
  expect(await readFile(file, "utf8")).toBe("new");
});

it("returns unchanged without writing identical bytes", async () => {
  await writeFile(file, "same", "utf8");
  const before = await stat(file);
  await new Promise((resolve) => setTimeout(resolve, 20));
  const result = await fileWriteTool.execute({ file_path: file, content: "same" }, { cwd: dir });
  const after = await stat(file);
  expect((result.content[0] as { text: string }).text).toContain("No write needed");
  expect(after.mtimeMs).toBe(before.mtimeMs);
});
```

再添加：合法 hash + 覆盖成功、错误 hash 拒绝、非法 hash 拒绝且不 stat、同内容 + 合法错误 hash 返回 unchanged、新文件 + hash 拒绝、新建嵌套目录成功、sandbox/system/managed 回归。hash 测试使用：

```ts
const sha256 = (value: string) =>
  createHash("sha256").update(Buffer.from(value, "utf8")).digest("hex");
```

- [ ] **步骤 2：确认红灯**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/write.test.ts
```

预期：默认覆盖仍成功，schema 不认识新字段或行为断言失败。

- [ ] **步骤 3：扩展 schema 和 description**

```ts
description:
  "Create a new UTF-8 text file. Existing files are not overwritten unless overwrite=true. Prefer Edit for small changes and ApplyPatch for multi-file or multi-hunk changes.",

overwrite: {
  type: "boolean",
  description: "Set true to replace an existing file with the complete content.",
},
expected_sha256: {
  type: "string",
  description: "Optional SHA-256 of existing raw bytes for guarded overwrite.",
},
```

- [ ] **步骤 4：实现最小 Write 流程**

在 `write.ts` 增加：

```ts
const SHA256_PATTERN = /^[0-9a-f]{64}$/i;

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
```

在 `execute` 入口先校验 `expected_sha256` 格式，非法值直接返回 `invalid_input`，且不得调用路径解析。其后保持路径/managed/system/write-sandbox 校验原顺序。目标已存在时，读取内容前还必须通过 read-sandbox 校验：

```ts
const overwrite = input.overwrite === true;
const expectedSha256 = input.expected_sha256 as string | undefined;
if (expectedSha256 !== undefined && !SHA256_PATTERN.test(expectedSha256)) {
  return invalidInput("expected_sha256 must be a 64-character hexadecimal SHA-256 value.");
}

const operations = fileOperationsFor(context);
let existing: Uint8Array | undefined;
try {
  const item = await operations.stat(filePath);
  if (!item.isFile || item.isSymbolicLink) return invalidInput(`Cannot write over a non-file path: ${filePath}`);
  const readError = await sandboxPathError(filePath, cwd, "read", context.settings, context.environment);
  if (readError) return { content: [{ type: "text", text: readError }], isError: true, failureKind: "policy", executionState: "not_started" };
  existing = await operations.readBytes(filePath);
} catch (error) {
  if (!(error instanceof FileNotFoundError)) throw error;
}

if (!existing) {
  if (expectedSha256 !== undefined) return invalidInput("expected_sha256 cannot be used when creating a new file.");
  await operations.createTextExclusive(filePath, content);
  return completed("created", filePath, content);
}

const requested = new TextEncoder().encode(content);
if (Buffer.from(existing).equals(Buffer.from(requested))) {
  return completed("unchanged", filePath, content);
}
if (expectedSha256 !== undefined && sha256(existing) !== expectedSha256.toLowerCase()) {
  return invalidInput("Write conflict: the existing file no longer matches expected_sha256.");
}
if (!overwrite) {
  return invalidInput("File already exists with different content. Use Edit, ApplyPatch, or set overwrite=true for a complete replacement.");
}
await operations.writeTextAtomic(filePath, content);
return completed("overwrote", filePath, content);
```

只捕获 `FileNotFoundError`；权限/I/O stat 错误会进入工具现有 unknown-outcome 分支，不能伪装成不存在。测试覆盖不可读目标不会进入 exclusive create。

结果 helper 必须保持：

```ts
executionState: "completed"
compactSummary.length <= 1000
```

且 summary 只含 operation、path、UTF-8 byte length 和短 hash，不含正文。

- [ ] **步骤 5：运行 Write 与全包回归**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/write.test.ts src/file/__test__/operations.test.ts
pnpm --filter @vykor/tools run check-types
pnpm --filter @vykor/tools exec vitest run
```

预期：全部通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/write.ts packages/tools/src/file/__test__/write.test.ts
git commit -m "feat(tools): make whole-file writes explicit and safe"
```

---

## 阶段二：ApplyPatch

### 任务 3：验证并锁定 diff@7 行为

**文件：**
- 创建：`packages/tools/src/file/__test__/diff-library-contract.test.ts`

- [ ] **步骤 1：编写三方库契约测试**

```ts
import { applyPatch, createTwoFilesPatch, parsePatch } from "diff";
import { describe, expect, it } from "vitest";

describe("diff@7 contract used by ApplyPatch", () => {
  it.each([
    ["update", "--- a/x.txt\n+++ b/x.txt\n@@ -1 +1 @@\n-old\n+new\n", "old\n", "new\n"],
    ["create", "--- /dev/null\n+++ b/x.txt\n@@ -0,0 +1 @@\n+new\n", "", "new\n"],
    ["delete", "--- a/x.txt\n+++ /dev/null\n@@ -1 +0,0 @@\n-old\n", "old\n", ""],
  ])("applies %s patches", (_name, patch, before, after) => {
    const parsed = parsePatch(patch);
    expect(parsed).toHaveLength(1);
    expect(applyPatch(before, parsed[0]!, { fuzzFactor: 0 })).toBe(after);
  });

  it("allows line-number drift when exact context is unique", () => {
    const patch = "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-target\n+changed\n";
    expect(applyPatch("prefix\ntarget\n", parsePatch(patch)[0]!, { fuzzFactor: 0 }))
      .toBe("prefix\nchanged\n");
  });
});
```

追加真实 CRLF、UTF-8 BOM、无最终换行、重复相同上下文用例。测试的目的不是强迫库符合猜测；先记录实际结果，再据结果决定适配位置：

- 行尾适配在传入 `applyPatch` 前完成；
- BOM 在调用库前剥离、成功后补回；
- 不修改 `parsePatch` 产生的 hunk 对象；
- 若 create/delete 的手写 patch 语法与库不兼容，使用 `createTwoFilesPatch` 生成 fixture，并把规格允许格式收敛到库实际支持的标准格式。

- [ ] **步骤 2：运行契约测试**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/diff-library-contract.test.ts
```

预期：基础 update/create/delete 和行号偏移通过；CRLF/BOM/最终换行的实际结果被断言锁定。若基础能力失败，停止并报告，不得转而自研 parser。

- [ ] **步骤 3：Commit**

```bash
git add packages/tools/src/file/__test__/diff-library-contract.test.ts
git commit -m "test(tools): lock jsdiff patch behavior"
```

---

### 任务 4：抽取共享文本判定与 patch 路径规则

**文件：**
- 创建：`packages/tools/src/file/text-content.ts`
- 修改：`packages/tools/src/file/read.ts`
- 创建：`packages/tools/src/file/patch-path.ts`（若少于约 50 行且仅一处使用，可并入 `apply-patch.ts`）
- 创建：`packages/tools/src/file/__test__/patch-path.test.ts`
- 修改：`packages/tools/src/file/__test__/read.test.ts`

- [ ] **步骤 1：先写路径失败测试**

覆盖：

```ts
expect(normalizePatchPath("a/src/app.ts", "posix")).toBe("src/app.ts");
expect(() => normalizePatchPath("../secret", "posix")).toThrow();
expect(() => normalizePatchPath("a/./src/app.ts", "posix")).toThrow();
expect(() => normalizePatchPath("C:/secret", "windows")).toThrow();
expect(() => normalizePatchPath("src\\app.ts", "windows")).toThrow();
expect(patchPathIdentity("Src/App.ts", "windows")).toBe("src/app.ts");
expect(patchPathIdentity("Src/App.ts", "posix")).toBe("Src/App.ts");
```

再加 `/dev/null` 仅由操作分类器处理、空路径/NUL/UNC/重复 slash 的用例。

- [ ] **步骤 2：确认红灯**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/patch-path.test.ts
```

- [ ] **步骤 3：抽取文本 helper**

把 `read.ts` 中严格 decode 与 `isBinaryContent` 相关常量/函数移动到 `text-content.ts`：

```ts
export function decodeUtf8Text(bytes: Uint8Array): string {
  let content: string;
  try {
    content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new Error("Unsupported binary content");
  }
  if (isBinaryContent(content)) throw new Error("Unsupported binary content");
  return content;
}
```

`read.ts` 改为调用 helper，但保持现有 `Cannot read binary file: {path}` 文案、图片分支和所有测试不变。

- [ ] **步骤 4：实现最小路径 helper**

只实现：去掉一个 `a/` 或 `b/` 前缀、拒绝 `.`/`..` 等不安全路径段、按 execution path style 生成 identity。不要解析 Git rename 或文件系统符号链接。

- [ ] **步骤 5：验证**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/read.test.ts src/file/__test__/patch-path.test.ts
pnpm --filter @vykor/tools run check-types
```

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/text-content.ts packages/tools/src/file/read.ts packages/tools/src/file/patch-path.ts packages/tools/src/file/__test__/read.test.ts packages/tools/src/file/__test__/patch-path.test.ts
git commit -m "refactor(tools): share text and patch path validation"
```

---

### 任务 5：实现 ApplyPatch 预演

**文件：**
- 创建：`packages/tools/src/file/apply-patch.ts`
- 创建：`packages/tools/src/file/__test__/apply-patch.test.ts`

- [ ] **步骤 1：编写纯预演失败测试**

对导出的纯函数 `planPatch` 使用内存 `FileOperations` fake，覆盖：

- update/create/delete；
- 一个文件多 hunk、多个文件；
- 0 文件、0 hunk；
- update old/new 不同；
- 重复 identity（Windows `A.ts`/`a.ts`）；
- create 已存在、update/delete 不存在；
- hunk 不匹配；
- binary marker、rename/copy/mode marker；
- 非 UTF-8、NUL、控制字符比例；
- CRLF、BOM、最终换行。

核心断言形状：

```ts
const plan = await planPatch(patch, context);
expect(plan.changes).toEqual([
  expect.objectContaining({ operation: "update", relativePath: "src/a.ts", beforeHash: expect.any(String) }),
]);
expect(plan.changes[0]!.newContent).toContain("changed");
expect(fake.writeCalls).toEqual([]);
```

- [ ] **步骤 2：确认红灯**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/apply-patch.test.ts
```

- [ ] **步骤 3：实现解析与操作分类**

使用：

```ts
import { applyPatch, parsePatch, type ParsedDiff } from "diff";
```

预扫描原 patch 字符串，拒绝规格列出的 binary/rename/copy/mode 标记。`parsePatch` 后要求：

解析前先验证 `Buffer.from(patch, "utf8").toString("utf8") === patch`；否则返回 `invalid_input`，避免孤立 surrogate 在解析时被静默替换。

```ts
parsed.length > 0
file.hunks.length > 0
```

分类规则：

```ts
old === "/dev/null" && next !== "/dev/null" // create
old !== "/dev/null" && next === "/dev/null" // delete
oldIdentity === nextIdentity                 // update
```

其余拒绝。

- [ ] **步骤 4：实现权限与内存预演**

为每个 change：

1. 解析 workspace 相对路径并 `resolveToolPathInContext`。
2. 复用 Write/Edit 的 managed/system/sandbox 规则；如果重复明显，抽一个 `file-mutation-guard.ts` 小 helper，禁止复制三份系统目录表。
3. create 要求 `stat` 抛 `FileNotFoundError`；update/delete 要求非符号链接的普通文件存在。其它 stat/read 错误原样失败。
4. update/delete 用 `readBytes` + `decodeUtf8Text`；记录 SHA-256。
5. 剥离 BOM，探测主行尾；将 patch 适配到目标行尾后调用 `applyPatch(..., { fuzzFactor: 0 })`。
6. create 从空串应用；delete 结果必须为空。create/update 的最终 `newContent` 用共享的 `isBinaryContent` 再校验一次，含 NUL 或控制字符比例超限时在预演阶段拒绝。

`normalizePatchPath` 的普通错误应在 `classifyFile` 边界转换成 `PatchToolError("invalid_input", ...)`，确保工具返回 `not_started`，不能让非法输入落到 `unknown_outcome`。

WSL 缺失目标的固定脚本需向上找到最近已存在的祖先，仅在其为可搜索目录时返回 `FileNotFoundError` 专用退出码。测试要真实执行 POSIX shell，覆盖多级尚不存在父目录；另以真实 shell 验证目标在复核后变成目录时 `mv -T -f` 失败且目录内没有临时文件。Host 用 220 字符 basename 的真实文件验证 exclusive create 与原子覆盖均成功。

所有变化存入 plan，不调用任何 write/remove 方法。

- [ ] **步骤 5：验证纯预演**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/apply-patch.test.ts
pnpm --filter @vykor/tools run check-types
```

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/apply-patch.ts packages/tools/src/file/__test__/apply-patch.test.ts packages/tools/src/file/file-mutation-guard.ts
git commit -m "feat(tools): plan validated unified patches"
```

只 add 实际创建的 helper 文件。

---

### 任务 6：ApplyPatch 落盘、反馈和注册

**文件：**
- 修改：`packages/tools/src/file/apply-patch.ts`
- 修改：`packages/tools/src/file/__test__/apply-patch.test.ts`
- 修改：`packages/tools/src/file/index.ts`
- 修改：`packages/tools/src/index.ts`
- 修改：`packages/tools/src/registry.ts`
- 修改：相关 registry/tool snapshot 测试（以 `rg "fileEditTool|fileWriteTool" packages/tools/src -g "*.test.ts"` 结果为准）

- [ ] **步骤 1：编写端到端失败测试**

真实临时目录覆盖：

```ts
it("applies create update and delete in one patch", async () => {
  await writeFile(join(dir, "update.txt"), "old\n", "utf8");
  await writeFile(join(dir, "delete.txt"), "gone\n", "utf8");
  const result = await applyPatchTool.execute!({ patch }, { cwd: dir });

  expect(result).toMatchObject({ executionState: "completed" });
  expect(await readFile(join(dir, "update.txt"), "utf8")).toBe("new\n");
  expect(await readFile(join(dir, "create.txt"), "utf8")).toBe("created\n");
  await expect(readFile(join(dir, "delete.txt"))).rejects.toThrow();
});
```

追加：sandbox 任一文件拒绝则全部不变、预演后 update 文件变化则全部不开始、create 并发出现不被覆盖、多文件第二次写失败返回 unknown 并列出 completed/pending、summary 大量路径时 <=1000。

并发变化测试通过注入 `FileOperations` fake 或在 plan/write 间测试 hook 完成；不要在生产接口添加仅测试使用的公开参数。优先把 `executePatchPlan(plan, operations)` 作为模块内可导出纯编排函数直接测试。

- [ ] **步骤 2：确认红灯**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/apply-patch.test.ts
```

- [ ] **步骤 3：实现复核和落盘**

`executePatchPlan`：

1. 重新读取 update/delete 原始字节并比较 plan hash；变化则在任何写入前拒绝。
2. 按 relative path 稳定排序。
3. create → `createTextExclusive`；update → `writeTextAtomic`；delete → `removeFile`。
4. 捕获第一个运行时失败，返回 completed/pending 列表和 `unknown_outcome`；不声称回滚。

工具定义：

```ts
export const applyPatchTool: ToolDefinition = {
  name: "ApplyPatch",
  description: "Apply a standard unified diff for multi-file or multi-hunk text changes. Supports create, update, and delete; rejects rename, binary, fuzzy, and mode patches.",
  inputSchema: {
    type: "object",
    properties: { patch: { type: "string", description: "Standard unified diff." } },
    required: ["patch"],
  },
  async execute(input, context) {
    try {
      const plan = await planPatch(input.patch as string, context);
      return await executePatchPlan(plan, fileOperationsFor(context));
    } catch (error) {
      return patchErrorResult(error);
    }
  },
};
```

`patchErrorResult` 将已知的 parse/path/hunk/conflict 错误映射成 `invalid_input + not_started`，policy 错误映射成 `policy + not_started`，其它异常映射成 `unknown_outcome + unknown`。不要按任意 message 猜类型；为本模块定义一个含 `kind` 的小型 `PatchToolError`。

summary builder 必须在加入每条路径前检查最终长度，保留计数并以 `... +N more` 结束，不要生成后再盲目 `slice(0, 1000)` 截断半个路径。

- [ ] **步骤 4：注册和导出**

在 file index、包 index 和 registry 中加入 `applyPatchTool`，执行域与 Write/Edit 相同：

```ts
registerBuiltin(applyPatchTool, environment());
```

- [ ] **步骤 5：更新工具选择描述**

把 Edit description 改成明确的小范围修改定位：

```ts
"Modify an existing text file with a precise old/new replacement. Prefer ApplyPatch for multiple hunks or files."
```

Write description 已在任务 2 更新。不要修改系统 prompt，除非 `rg` 找到集中维护的文件工具选择规则；若存在，只做同义同步并加 snapshot 测试。

- [ ] **步骤 6：验证阶段二**

```bash
pnpm --filter @vykor/tools exec vitest run src/file/__test__/diff-library-contract.test.ts src/file/__test__/patch-path.test.ts src/file/__test__/apply-patch.test.ts
pnpm --filter @vykor/tools run check-types
pnpm --filter @vykor/tools exec vitest run
pnpm --filter @vykor/environment run check-types
```

预期：全部通过。

- [ ] **步骤 7：Commit**

```bash
git add packages/tools/src/file/apply-patch.ts packages/tools/src/file/__test__/apply-patch.test.ts packages/tools/src/file/index.ts packages/tools/src/index.ts packages/tools/src/registry.ts packages/tools/src/file/edit.ts
git commit -m "feat(tools): add validated multi-file patching"
```

将本任务实际修改的 snapshot/registry 测试一并 add。

---

## 最终验收

- [ ] **步骤 1：运行目标测试**

```bash
pnpm --filter @vykor/tools exec vitest run \
  src/file/__test__/operations.test.ts \
  src/file/__test__/write.test.ts \
  src/file/__test__/read.test.ts \
  src/file/__test__/edit.test.ts \
  src/file/__test__/diff-library-contract.test.ts \
  src/file/__test__/patch-path.test.ts \
  src/file/__test__/apply-patch.test.ts
```

- [ ] **步骤 2：运行全包验证**

```bash
pnpm --filter @vykor/environment run check-types
pnpm --filter @vykor/tools run check-types
pnpm --filter @vykor/tools exec vitest run
pnpm check-docs
git diff --check
git status --short
```

- [ ] **步骤 3：人工核对关键边界**

确认：

- Write 创建新文件不要求 overwrite。
- Write 对已有不同内容默认拒绝。
- 同内容 no-op 不改变 mtime。
- create 并发出现时不覆盖对方文件。
- ApplyPatch 任一预演/权限失败时没有写盘。
- jsdiff 行号偏移行为与契约测试一致。
- CRLF、BOM、最终换行与契约测试一致。
- 多文件运行时失败不谎称回滚。
- summary 不超过 1000 字符且不含正文。
- 没有新增 diff/parser/atomic-write npm 依赖。

## 自检记录

- **规格覆盖度**：Write 安全语义由任务 1-2；三方库真实行为由任务 3；共享文本/路径边界由任务 4；patch 预演由任务 5；复核、落盘、反馈、注册由任务 6 覆盖。审查新增的符号链接拒绝、输出文本二进制校验、读权限与 `.` 路径段测试纳入相应任务。
- **第三方优先**：全部 unified diff 解析和应用交给现有 `diff@7`；自有逻辑只负责项目路径、权限、环境文件系统和反馈。
- **不过度设计**：没有 rename、mode、二进制 patch、fuzzy matcher、三方 merge、跨文件事务、备份和 UI。
- **类型一致性**：`createTextExclusive`、`writeTextAtomic`、`removeFile` 同时存在于 `EnvironmentFileSystem` 与所有生产实现；Host/WSL 共享 `FileNotFoundError`；ApplyPatch 只调用这些共享方法。
- **并发承诺**：create 是 exclusive；update/delete hash 复核明确为 best-effort，不宣称 CAS。
- **占位符扫描**：计划没有 TODO、待定、“类似任务 N”或空实现；所有被引用的 helper 都在对应任务中定义。
