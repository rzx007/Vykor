# Read 工具输出感知与安全边界 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `Read` 的输出自解释（总行数 + 续读指引）且不炸上下文（字节/单行上限），并在遇到二进制、越界 offset、路径不存在时给出明确可行动的失败。

**架构：** 在 `read.ts` 内新增一组导出的纯函数与常量（范围归一、二进制判定、行拆分、文件/目录切片与字节计数、尾部提示、相近名筛选），`execute` 改为调用它们。保留现有 `readBytes`、图片签名校验与 image block 分支；文本严格 UTF-8 解码后再进入有界输出流程。不改工具入参、返回结构或 `N: ` 行号前缀。

**技术栈：** TypeScript、Vitest、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-22-read-tool-output-awareness-design.md`

## 全局约束

- 只改 `packages/tools/src/file/read.ts` 与其测试（`read.test.ts`、`operations.test.ts`、`environment-path.test.ts`）。**不修改** `operations.ts`、`write.ts`、`edit.ts`。
- 常量名与取值固定：`DEFAULT_READ_LIMIT = 2000`、`MAX_READ_BYTES = 50 * 1024`、`MAX_READ_BYTES_LABEL = "50 KB"`、`MAX_LINE_LENGTH = 2000`、`MAX_LINE_SUFFIX = " ... (line truncated to 2000 chars)"`、`BINARY_SAMPLE_CHARS = 4096`、`BINARY_CONTROL_RATIO = 0.3`、`MAX_SUGGESTIONS = 3`。
- 尾部提示文案逐字固定（三种）：
  - 字节：`(Output capped at 50 KB. Showing lines {first}-{last}. Use offset={next} to continue.)`
  - 行数：`(Showing lines {first}-{last} of {total}. Use offset={next} to continue.)`
  - 结束：`(End of file - total {total} lines)`
  - 目录空：`(empty directory)`；从 1 开始全部读完：`({total} entries)`；从中间读到末尾：`(Showing entries {first}-{last} of {total}. End of directory.)`；目录行数截断：`(Showing entries {first}-{last} of {total}. Use offset={next} to continue.)`；目录字节截断：`(Output capped at 50 KB. Showing entries {first}-{last} of {total}. Use offset={next} to continue.)`
- 二进制错误文案：`Cannot read binary file: {path}`；文件越界文案：`Offset {offset} is out of range for this file ({total} lines)`；目录越界文案：`Offset {offset} is out of range for this directory ({total} entries)`。
- 行数规则（决策 9，逐字）：`content === "" ? [] : (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")`。
- 二进制控制字符区间必须为 `code < 9 || (code > 13 && code < 32)`（排除 `\t\n\v\f\r`），不得收窄。
- 入参归一：有限数执行 `Math.max(1, Math.trunc(value))`；非有限数回退默认值。`offset` 默认 1，`limit` 默认 `DEFAULT_READ_LIMIT`。
- 文件与目录的尾部提示都**不计入** `MAX_READ_BYTES`。
- 缺失路径建议只能在父目录也通过 sandbox read 校验后生成；未授权时不得调用 `listDir` 或泄露兄弟条目名。
- **必须同步更新三处既有文本精确断言**（否则实现后必红）：`read.test.ts:37`、`operations.test.ts:17`、`environment-path.test.ts:63`；现有图片测试不得删除或弱化。
- 测试命令：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`（全量为 `pnpm --filter @openharness/tools exec vitest run`）。
- 类型检查：`pnpm --filter @openharness/tools run check-types`。

---

### 任务 1：常量与纯函数（不改变 `execute` 行为）

**文件：**
- 修改：`packages/tools/src/file/read.ts`（仅新增导出）
- 修改：`packages/tools/src/file/__test__/read.test.ts`（仅追加纯函数单测）

- [ ] **步骤 1：编写失败的测试**

把 `packages/tools/src/file/__test__/read.test.ts` 现有的 `fileReadTool` import 改为：

```ts
import {
  MAX_READ_BYTES,
  fileReadTool,
  isBinaryContent,
  normalizeReadInteger,
  readTrailer,
  sliceDirectoryEntries,
  sliceReadLines,
  splitReadLines,
  suggestSimilarNames,
  truncateReadLine,
} from "../read.js";
```

并在文件末尾追加：

```ts
describe("read helpers", () => {
  it("splits lines without counting a trailing newline", () => {
    expect(splitReadLines("")).toEqual([]);
    expect(splitReadLines("\n")).toEqual([""]);
    expect(splitReadLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitReadLines("a\nb")).toEqual(["a", "b"]);
    expect(splitReadLines("a\r\n")).toEqual(["a\r"]);
  });

  it("detects binary content by NUL and by control-char ratio", () => {
    expect(isBinaryContent("hello\u0000world")).toBe(true);
    expect(isBinaryContent("hello world")).toBe(false);
    expect(isBinaryContent("tab\there\nand\r\nnewline")).toBe(false);
    expect(isBinaryContent("中文与 emoji 🙂 都正常")).toBe(false);
    expect(isBinaryContent("\u0001".repeat(200))).toBe(true);
  });

  it("truncates only lines beyond the per-line limit", () => {
    expect(truncateReadLine("short")).toBe("short");
    const long = "x".repeat(2500);
    const truncated = truncateReadLine(long);
    expect(truncated).toContain("(line truncated to 2000 chars)");
    expect(truncated.length).toBeLessThan(long.length);
  });

  it("emits every line when the file is small", () => {
    const slice = sliceReadLines(["one", "two", "three"], 1, 2000);
    expect(slice.lines).toEqual(["1: one", "2: two", "3: three"]);
    expect(slice.emitted).toBe(3);
    expect(slice.byteCapped).toBe(false);
  });

  it("honours offset and limit", () => {
    const slice = sliceReadLines(["one", "two", "three"], 2, 1);
    expect(slice.lines).toEqual(["2: two"]);
    expect(slice.emitted).toBe(1);
  });

  it("normalizes finite values and falls back for non-finite values", () => {
    expect(normalizeReadInteger(-5, 1)).toBe(1);
    expect(normalizeReadInteger(2.9, 1)).toBe(2);
    expect(normalizeReadInteger(Number.NaN, 1)).toBe(1);
    expect(normalizeReadInteger(Number.POSITIVE_INFINITY, 2000)).toBe(2000);
  });

  it("caps the byte budget and always emits at least one line", () => {
    const lines = Array.from({ length: 30 }, () => "a".repeat(1990));
    const slice = sliceReadLines(lines, 1, 2000);
    expect(slice.byteCapped).toBe(true);
    expect(slice.emitted).toBeGreaterThan(0);
    expect(slice.emitted).toBeLessThan(30);
    const totalBytes = slice.lines.reduce(
      (sum, line, index) => sum + Buffer.byteLength(line, "utf8") + (index > 0 ? 1 : 0),
      0,
    );
    expect(totalBytes).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("applies the same byte budget to directory entries", () => {
    const entries = Array.from({ length: 300 }, (_, index) => `${index}-${"x".repeat(240)}`);
    const slice = sliceDirectoryEntries(entries, 1, 2000);
    expect(slice.byteCapped).toBe(true);
    expect(slice.emitted).toBeGreaterThan(0);
    expect(slice.emitted).toBeLessThan(entries.length);
  });

  it("truncates an oversized first directory entry before applying the byte budget", () => {
    const slice = sliceDirectoryEntries(["x".repeat(MAX_READ_BYTES + 1)], 1, 2000);
    expect(slice.emitted).toBe(1);
    expect(slice.lines[0]).toContain("(line truncated to 2000 chars)");
    expect(Buffer.byteLength(slice.lines[0]!, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
  });

  it("builds the three trailer shapes", () => {
    expect(readTrailer({ offset: 1, emitted: 1, total: 3, byteCapped: false })).toBe(
      "(Showing lines 1-1 of 3. Use offset=2 to continue.)",
    );
    expect(readTrailer({ offset: 1, emitted: 3, total: 3, byteCapped: false })).toBe(
      "(End of file - total 3 lines)",
    );
    expect(readTrailer({ offset: 1, emitted: 2, total: 5, byteCapped: true })).toBe(
      "(Output capped at 50 KB. Showing lines 1-2. Use offset=3 to continue.)",
    );
    expect(readTrailer({ offset: 1, emitted: 0, total: 0, byteCapped: false })).toBe(
      "(End of file - total 0 lines)",
    );
  });

  it("suggests at most three mutually-containing names in stable order", () => {
    expect(suggestSimilarNames("config.ts", ["config.tsx", "other.md", "config.ts"])).toEqual([
      "config.ts",
      "config.tsx",
    ]);
    expect(suggestSimilarNames("config", ["config4", "config2", "config1", "config3"])).toEqual([
      "config1",
      "config2",
      "config3",
    ]);
    expect(suggestSimilarNames("missing.ts", ["a.ts", "b.ts", "c.ts", "d.ts"])).toEqual([]);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：FAIL，报错这些导出不存在（`isBinaryContent is not a function` 等）。

- [ ] **步骤 3：新增常量与纯函数**

在 `packages/tools/src/file/read.ts` 顶部（`import` 之后、`fileReadTool` 之前）加入：

```ts
export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_READ_BYTES_LABEL = "50 KB";
export const MAX_LINE_LENGTH = 2000;
export const MAX_LINE_SUFFIX = ` ... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const BINARY_SAMPLE_CHARS = 4096;
export const BINARY_CONTROL_RATIO = 0.3;
export const MAX_SUGGESTIONS = 3;

export function normalizeReadInteger(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(1, Math.trunc(value))
    : fallback;
}

/** 行数规则：空串为 0 行；只剥一个尾随 \n；不做行尾归一。 */
export function splitReadLines(content: string): string[] {
  if (content === "") return [];
  return (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n");
}

/** 含 NUL，或前 4096 字符中控制字符占比超过阈值，即判定为二进制。 */
export function isBinaryContent(content: string): boolean {
  if (content.includes("\u0000")) return true;
  const sample = content.slice(0, BINARY_SAMPLE_CHARS);
  if (sample.length === 0) return false;
  let control = 0;
  for (let index = 0; index < sample.length; index += 1) {
    const code = sample.charCodeAt(index);
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / sample.length > BINARY_CONTROL_RATIO;
}

export function truncateReadLine(line: string): string {
  return line.length > MAX_LINE_LENGTH ? line.slice(0, MAX_LINE_LENGTH) + MAX_LINE_SUFFIX : line;
}

export type ReadSlice = {
  lines: string[];
  emitted: number;
  byteCapped: boolean;
};

function sliceReadItems(
  items: string[],
  offset: number,
  limit: number,
  format: (item: string, index: number) => string,
): ReadSlice {
  const start = offset - 1;
  const output: string[] = [];
  let bytes = 0;
  let byteCapped = false;

  for (let index = start; index < items.length; index += 1) {
    if (output.length >= limit) break;
    const text = format(items[index]!, index);
    const size = Buffer.byteLength(text, "utf8") + (output.length > 0 ? 1 : 0);
    if (output.length > 0 && bytes + size > MAX_READ_BYTES) {
      byteCapped = true;
      break;
    }
    output.push(text);
    bytes += size;
  }

  return { lines: output, emitted: output.length, byteCapped };
}

/** 从 offset 开始取最多 limit 行，先截断单行，再执行总字节上限。 */
export function sliceReadLines(lines: string[], offset: number, limit: number): ReadSlice {
  return sliceReadItems(
    lines,
    offset,
    limit,
    (line, index) => `${index + 1}: ${truncateReadLine(line)}`,
  );
}

export function sliceDirectoryEntries(entries: string[], offset: number, limit: number): ReadSlice {
  return sliceReadItems(entries, offset, limit, (entry) => truncateReadLine(entry));
}

/** 尾部提示：按 remaining 判定行数提示与结束提示，避免"读完却提示续读"。 */
export function readTrailer(input: {
  offset: number;
  emitted: number;
  total: number;
  byteCapped: boolean;
}): string {
  const first = input.offset;
  const last = input.offset + input.emitted - 1;
  const next = last + 1;

  if (input.byteCapped) {
    return `(Output capped at ${MAX_READ_BYTES_LABEL}. Showing lines ${first}-${last}. Use offset=${next} to continue.)`;
  }

  const remaining = input.total - (input.offset - 1) - input.emitted;
  if (remaining > 0) {
    return `(Showing lines ${first}-${last} of ${input.total}. Use offset=${next} to continue.)`;
  }

  return `(End of file - total ${input.total} lines)`;
}

/** 名称互相包含（忽略大小写），最多 MAX_SUGGESTIONS 条。 */
export function suggestSimilarNames(target: string, entries: string[]): string[] {
  const base = target.toLowerCase();
  if (!base) return [];
  return entries
    .filter((name) => {
      const lower = name.toLowerCase();
      return lower.includes(base) || base.includes(lower);
    })
    .sort((left, right) => left.localeCompare(right))
    .slice(0, MAX_SUGGESTIONS);
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：PASS（现有 7 条 + 新增 10 条全绿；`execute` 未改动，现有断言不受影响）。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts
git commit -m "feat(tools): add read output helpers and limits"
```

---

### 任务 2：文件分支接入（保留图片能力并同步既有断言）

**文件：**
- 修改：`packages/tools/src/file/read.ts`（`execute` 文件分支 + `description`）
- 修改：`packages/tools/src/file/__test__/read.test.ts`（更新 `:37` + 追加）
- 修改：`packages/tools/src/file/__test__/operations.test.ts`（仅改 `:17` 断言）
- 修改：`packages/tools/src/file/__test__/environment-path.test.ts`（仅改 `:63` 断言）

- [ ] **步骤 1：更新文本断言与二进制文案断言**

先读这三个文件确认上下文，然后按下表修改（**只改断言，不动测试意图**）：

| 文件 | 位置 | 现状 | 改为 |
|---|---|---|---|
| `read.test.ts` | `:37` | `expect((result.content[0] as any).text).toBe("2: two")` | `const text = (result.content[0] as any).text as string; expect(text.startsWith("2: two")).toBe(true); expect(text).toContain("(Showing lines 2-2 of 3. Use offset=3 to continue.)")` |
| `operations.test.ts` | `:17` | `toMatchObject({ text: "1: hello" })` | 保存结果，断言 `isError` 为假、正文含 `1: hello`，并含 `(End of file - total 1 lines)` |
| `environment-path.test.ts` | `:63` | `toMatchObject({ text: "1: hello" })` | 同上 |
| `read.test.ts` | 无效二进制用例 | 包含 `Unsupported binary file` | 精确断言 `Cannot read binary file: ${file}` |

具体替换为：

```ts
// read.test.ts 的编号读取用例
const text = (result.content[0] as { text: string }).text;
expect(text).toBe(
  "2: two\n\n(Showing lines 2-2 of 3. Use offset=3 to continue.)",
);
expect(result.isError).toBeFalsy();

// operations.test.ts：替换原内联断言
const readResult = await fileReadTool.execute!({ file_path: file }, { cwd });
expect(readResult.isError).toBeFalsy();
expect((readResult.content[0] as { text: string }).text).toBe(
  "1: hello\n\n(End of file - total 1 lines)",
);

// environment-path.test.ts：保留已有 result/readBytes 断言，替换文本断言
expect(result.isError).toBeFalsy();
expect((result.content[0] as { text: string }).text).toBe(
  "1: hello\n\n(End of file - total 1 lines)",
);

// read.test.ts 的无效二进制用例
expect(result.isError).toBe(true);
expect((result.content[0] as { text: string }).text).toBe(
  `Cannot read binary file: ${file}`,
);
```

关键是同时锁定编号正文和结束 trailer。不要删除或弱化现有 PNG image block、错误图片、WSL host-path 与 provider 不可访问测试。

- [ ] **步骤 2：追加文件分支用例**

在 `read.test.ts` 的 `describe("fileReadTool", ...)` 内追加（沿用文件里既有的 `mkdtemp`/`writeFile`/`rm` 与 `{ cwd: dir }` 调用风格）：

```ts
it("appends an end-of-file trailer when the whole file is read", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-eof-"));
  try {
    const file = join(dir, "three.txt");
    await writeFile(file, "one\ntwo\nthree", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1: one");
    expect(text).toContain("(End of file - total 3 lines)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports end-of-file when limit exactly exhausts the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-exact-"));
  try {
    const file = join(dir, "three.txt");
    await writeFile(file, "one\ntwo\nthree", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file, offset: 1, limit: 3 }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("(End of file - total 3 lines)");
    expect(text).not.toContain("Use offset=");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not count a trailing newline as an extra line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-trailing-"));
  try {
    const file = join(dir, "two.txt");
    await writeFile(file, "a\nb\n", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect((result.content[0] as { text: string }).text).toContain("(End of file - total 2 lines)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("caps output at the byte budget and keeps the trailer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-bytes-"));
  try {
    const file = join(dir, "big.txt");
    const lines = Array.from({ length: 30 }, () => "a".repeat(1990));
    await writeFile(file, lines.join("\n"), "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Output capped at 50 KB");
    expect(text).toContain("Use offset=");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("truncates a line beyond 2000 characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-longline-"));
  try {
    const file = join(dir, "long.txt");
    await writeFile(file, "x".repeat(2500), "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect((result.content[0] as { text: string }).text).toContain("(line truncated to 2000 chars)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects a file containing NUL without returning its content", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-nul-"));
  try {
    const file = join(dir, "bin.dat");
    await writeFile(file, Buffer.from([0x68, 0x00, 0x69]), "binary");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(`Cannot read binary file: ${file}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects a file dominated by control characters", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-control-"));
  try {
    const file = join(dir, "ctrl.dat");
    await writeFile(file, Buffer.from(new Array(200).fill(0x01)), "binary");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Cannot read binary file");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not misclassify normal text with tabs and CJK as binary", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-text-"));
  try {
    const file = join(dir, "normal.txt");
    await writeFile(file, "col1\tcol2\n中文 🙂\n", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("col1\tcol2");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports an out-of-range offset with the total line count", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-range-"));
  try {
    const file = join(dir, "three.txt");
    await writeFile(file, "one\ntwo\nthree", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file, offset: 5 }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "Offset 5 is out of range for this file (3 lines)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reads an empty file with a zero-line trailer", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-empty-"));
  try {
    const file = join(dir, "empty.txt");
    await writeFile(file, "", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toBe("(End of file - total 0 lines)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("normalizes invalid offset and limit instead of failing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-normalize-"));
  try {
    const file = join(dir, "three.txt");
    await writeFile(file, "one\ntwo\nthree", "utf-8");

    const result = await fileReadTool.execute!({ file_path: file, offset: -5, limit: 0 }, { cwd: dir });

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text.startsWith("1: one")).toBe(true);
    expect(text).toContain("(Showing lines 1-1 of 3. Use offset=2 to continue.)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("falls back from non-finite offset and limit values", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-nonfinite-"));
  try {
    const file = join(dir, "two.txt");
    await writeFile(file, "one\ntwo", "utf-8");

    const result = await fileReadTool.execute!(
      { file_path: file, offset: Number.NaN, limit: Number.POSITIVE_INFINITY },
      { cwd: dir },
    );

    expect(result.isError).toBeFalsy();
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1: one");
    expect(text).toContain("2: two");
    expect(text).not.toMatch(/NaN|Infinity/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("advertises offset-based continuation in its description", () => {
  expect(fileReadTool.description).toContain("offset");
  expect(fileReadTool.description).toContain("image");
  expect(fileReadTool.description).toContain("50 KB");
});
```

- [ ] **步骤 3：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：FAIL。文件分支新用例失败（无尾部提示、控制字符二进制文案不一致、无越界报错、无有限数归一）；`description` 用例失败。现有图片测试应继续通过。

- [ ] **步骤 4：改写 `execute` 的文件分支与 `description`**

把 `description` 改为：

```ts
    description:
      "Read a local text file, supported image, or directory. Text is returned with each line prefixed as `N: <content>`. Use `offset` (1-indexed) and `limit` to continue through large files or directories. Lines longer than 2000 characters and text or directory output beyond 50 KB are truncated with a note. Supported images are returned as image blocks; other binary files are rejected.",
```

把 `execute` 的入参归一与文件分支改为：

```ts
  async execute(input, context) {
    const rawPath = input.file_path as string;
    const cwd = (context as { cwd?: string } | undefined)?.cwd ?? process.cwd();
    const offset = normalizeReadInteger(input.offset, 1);
    const limit = normalizeReadInteger(input.limit, DEFAULT_READ_LIMIT);

    try {
      const filePath = await resolveToolPathInContext(rawPath, context, "read");
      const sandboxError = await sandboxPathError(filePath, cwd, "read", context.settings, context.environment);
      if (sandboxError) {
        return {
          content: [{ type: "text", text: sandboxError }],
          isError: true,
        };
      }

      const operations = fileOperationsFor(context);
      const fileStat = await operations.stat(filePath);
      if (fileStat.isDirectory) {
        return await readDirectoryListing(operations, filePath, offset, limit);
      }

      const bytes = await operations.readBytes(filePath);
      const mediaType = imageMediaType(bytes);
      const expectedMediaType = IMAGE_EXTENSIONS[extname(filePath).toLowerCase()];
      if (expectedMediaType && mediaType !== expectedMediaType) {
        throw new Error(`Invalid image file: expected ${expectedMediaType} content`);
      }
      if (mediaType) {
        const hostPath = context.environment
          ? context.environment.paths.toHostPath(filePath)
          : filePath;
        if (!hostPath) throw new Error("Image file is not accessible to the model provider");
        return {
          content: [{
            type: "image",
            source: { type: "file", mediaType, path: hostPath, sizeBytes: bytes.byteLength },
          }],
        };
      }

      let content: string;
      try {
        content = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
      } catch {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${filePath}` }],
          isError: true,
        };
      }
      if (isBinaryContent(content)) {
        return {
          content: [{ type: "text", text: `Cannot read binary file: ${filePath}` }],
          isError: true,
        };
      }

      const lines = splitReadLines(content);
      const total = lines.length;
      if (offset > total && !(total === 0 && offset === 1)) {
        return {
          content: [{ type: "text", text: `Offset ${offset} is out of range for this file (${total} lines)` }],
          isError: true,
        };
      }

      const slice = sliceReadLines(lines, offset, limit);
      const body = slice.lines.join("\n");
      const trailer = readTrailer({
        offset,
        emitted: slice.emitted,
        total,
        byteCapped: slice.byteCapped,
      });
      return {
        content: [{ type: "text", text: body ? `${body}\n\n${trailer}` : trailer }],
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: `Error reading file: ${error}` }],
        isError: true,
      };
    }
  },
```

**注意**：本步骤引用到的 `readDirectoryListing` 在任务 3 实现。为让本任务结束时可运行，先加一个**保持现有行为**的临时实现（任务 3 再替换为带尾部提示的版本）：

```ts
async function readDirectoryListing(
  operations: FileOperations,
  dir: string,
  offset: number,
  limit: number,
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const entries = (await operations.listDir(dir)).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const start = Math.max(0, offset - 1);
  const listed = entries
    .slice(start, start + limit)
    .map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`)
    .join("\n");
  return { content: [{ type: "text", text: listed || "(empty directory)" }] };
}
```

把现有 operations import 合并为：

```ts
import { fileOperationsFor, type FileOperations } from "./operations.js";
```

同时删除原 `execute` 中已被替换的旧文本 `lines`/`numbered` 代码，但保留文件末尾的 `IMAGE_EXTENSIONS` 与 `imageMediaType` 定义。图片分支必须与当前实现保持等价。

- [ ] **步骤 5：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：PASS（现有 7 条 + 任务 1 的 10 条 + 本次 13 条全绿，包括既有图片用例）。

- [ ] **步骤 6：跑整个 tools 包测试（含另两处断言）**

运行：`pnpm --filter @openharness/tools exec vitest run`
预期：全绿。若 `operations.test.ts` 或 `environment-path.test.ts` 仍红，说明步骤 1 的断言未改到位，回去修正。

- [ ] **步骤 7：类型检查**

运行：`pnpm --filter @openharness/tools run check-types`
预期：通过。

- [ ] **步骤 8：Commit**

```bash
git add packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts packages/tools/src/file/__test__/operations.test.ts packages/tools/src/file/__test__/environment-path.test.ts
git commit -m "feat(tools): make read output self-describing and bounded"
```

---

### 任务 3：目录尾部提示与路径不存在的建议

**文件：**
- 修改：`packages/tools/src/file/read.ts`（替换 `readDirectoryListing`、新增缺失路径分支）
- 修改：`packages/tools/src/file/__test__/read.test.ts`（追加）

- [ ] **步骤 1：编写失败的测试**

在 `read.test.ts` 的 `describe("fileReadTool", ...)` 内追加：

同时把 `missingPathMessage` 与 `readPathInfo` 加入文件顶部从 `../read.js` 的既有 import。

```ts
it("appends an entry count for a non-empty directory", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dircount-"));
  try {
    await mkdir(join(dir, "app"));
    await writeFile(join(dir, "README.md"), "hello", "utf-8");

    const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("app/");
    expect(text).toContain("(2 entries)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports truncation for a directory listing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dirturnc-"));
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(dir, name), "x", "utf-8");
    }

    const result = await fileReadTool.execute!({ file_path: dir, limit: 2 }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Showing entries 1-2 of 3. Use offset=3 to continue.");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports the shown range when a directory page reaches the end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dirend-"));
  try {
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      await writeFile(join(dir, name), "x", "utf-8");
    }

    const result = await fileReadTool.execute!({ file_path: dir, offset: 2 }, { cwd: dir });

    expect((result.content[0] as { text: string }).text).toContain(
      "Showing entries 2-3 of 3. End of directory.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("caps a large directory listing by bytes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dirbytes-"));
  try {
    const names = Array.from(
      { length: 360 },
      (_, index) => `${String(index).padStart(3, "0")}-${"x".repeat(140)}.txt`,
    );
    for (const name of names) {
      await writeFile(join(dir, name), "x", "utf-8");
    }

    const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });

    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Output capped at 50 KB");
    expect(text).toContain("Use offset=");
    expect(Buffer.byteLength(text.split("\n\n")[0]!, "utf8")).toBeLessThanOrEqual(MAX_READ_BYTES);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports an out-of-range directory offset", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dirrange-"));
  try {
    await writeFile(join(dir, "a.txt"), "x", "utf-8");
    await writeFile(join(dir, "b.txt"), "x", "utf-8");

    const result = await fileReadTool.execute!({ file_path: dir, offset: 5 }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(
      "Offset 5 is out of range for this directory (2 entries)",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps the empty-directory message", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-dirempty-"));
  try {
    const result = await fileReadTool.execute!({ file_path: dir }, { cwd: dir });
    expect((result.content[0] as { text: string }).text).toBe("(empty directory)");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("suggests similar names when the path is missing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-suggest-"));
  try {
    await writeFile(join(dir, "config.ts"), "x", "utf-8");

    // 目标名 "config" 是已存在条目 "config.ts" 的前缀，满足"互相包含"。
    const result = await fileReadTool.execute!({ file_path: join(dir, "config") }, { cwd: dir });

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("File not found:");
    expect(text).toContain("Did you mean one of these?");
    expect(text).toContain("config.ts");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports a plain not-found error when nothing is similar", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-nosuggest-"));
  try {
    const result = await fileReadTool.execute!({ file_path: join(dir, "zzz.ts") }, { cwd: dir });

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toBe(`File not found: ${join(dir, "zzz.ts")}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not list sibling suggestions when sandbox access excludes the parent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-read-suggest-sandbox-"));
  try {
    await writeFile(join(dir, "secret.txt"), "x", "utf-8");
    const result = await fileReadTool.execute!(
      { file_path: join(dir, "secret") },
      {
        cwd: dir,
        settings: {
          model: "m",
          apiFormat: "openai",
          maxTurns: 1,
          permission: { mode: "default" },
          sandbox: {
            enabled: true,
            filesystem: { allowRead: ["secret"], allowWrite: [] },
          },
        },
      },
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Error reading file:");
    expect(text).not.toContain("Did you mean");
    expect(text).not.toContain("secret.txt");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves the stat error when the parent still lists the exact name", () => {
  const file = join("root", "secret.txt");
  const text = missingPathMessage(file, ["secret.txt"], new Error("denied"));
  expect(text).toContain("Error reading file: Error: denied");
  expect(text).not.toContain("File not found");
});

it("preserves POSIX and Windows path namespaces in suggestions", () => {
  const posix = readPathInfo("/workspace/src/app.ts");
  expect(posix.parent).toBe("/workspace/src");
  expect(posix.sibling("config.ts")).toBe("/workspace/src/config.ts");

  const windows = readPathInfo("D:\\repo\\src\\app.ts");
  expect(windows.parent).toBe("D:\\repo\\src");
  expect(windows.sibling("config.ts")).toBe("D:\\repo\\src\\config.ts");
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：FAIL。目录计数、行数截断、字节截断与越界用例失败；普通建议用例失败（缺失路径走外层 catch）；父目录未授权用例会错误泄露 `secret.txt`；`missingPathMessage` 尚未导出。

- [ ] **步骤 3：替换 `readDirectoryListing` 并新增缺失路径分支**

把 `read.ts` 现有的 `node:path` import 改为：

```ts
import { extname, posix, win32 } from "node:path";
```

把任务 2 的临时 `readDirectoryListing` 替换为：

```ts
async function readDirectoryListing(
  operations: FileOperations,
  dir: string,
  offset: number,
  limit: number,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError?: true }> {
  const entries = (await operations.listDir(dir)).sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const total = entries.length;
  if (total === 0) {
    if (offset === 1) return { content: [{ type: "text", text: "(empty directory)" }] };
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (0 entries)` }],
      isError: true,
    };
  }

  if (offset > total) {
    return {
      content: [{ type: "text", text: `Offset ${offset} is out of range for this directory (${total} entries)` }],
      isError: true,
    };
  }

  const formatted = entries.map((entry) => `${entry.name}${entry.isDirectory ? "/" : ""}`);
  const slice = sliceDirectoryEntries(formatted, offset, limit);
  const body = slice.lines.join("\n");
  const remaining = total - (offset - 1) - slice.emitted;
  const first = offset;
  const last = offset + slice.emitted - 1;
  const next = offset + slice.emitted;
  const trailer = slice.byteCapped
    ? `(Output capped at ${MAX_READ_BYTES_LABEL}. Showing entries ${first}-${last} of ${total}. Use offset=${next} to continue.)`
    : remaining > 0
      ? `(Showing entries ${first}-${last} of ${total}. Use offset=${next} to continue.)`
      : offset === 1
        ? `(${total} entries)`
        : `(Showing entries ${first}-${last} of ${total}. End of directory.)`;

  return { content: [{ type: "text", text: `${body}\n\n${trailer}` }] };
}
```

在 `execute` 中，把 `operations.stat(filePath)` 包一层，缺失时走新分支：

```ts
      const operations = fileOperationsFor(context);
      let fileStat: Awaited<ReturnType<FileOperations["stat"]>>;
      try {
        fileStat = await operations.stat(filePath);
      } catch (statError) {
        const parentSandboxError = await sandboxPathError(
          readPathInfo(filePath).parent,
          cwd,
          "read",
          context.settings,
          context.environment,
        );
        if (parentSandboxError) {
          return {
            content: [{ type: "text", text: `Error reading file: ${statError}` }],
            isError: true,
          };
        }
        return await describeMissingPath(operations, filePath, statError);
      }
      if (fileStat.isDirectory) {
        return await readDirectoryListing(operations, filePath, offset, limit);
      }
```

并新增函数：

```ts
export function readPathInfo(filePath: string): {
  name: string;
  parent: string;
  sibling: (name: string) => string;
} {
  const pathApi = /^[a-zA-Z]:[\\/]/.test(filePath) || filePath.includes("\\")
    ? win32
    : posix;
  const parent = pathApi.dirname(filePath);
  return {
    name: pathApi.basename(filePath),
    parent,
    sibling: (name) => pathApi.join(parent, name),
  };
}

export function missingPathMessage(
  filePath: string,
  entryNames: string[],
  statError: unknown,
): string {
  const pathInfo = readPathInfo(filePath);
  if (entryNames.includes(pathInfo.name)) return `Error reading file: ${statError}`;

  const suggestions = suggestSimilarNames(pathInfo.name, entryNames)
    .map(pathInfo.sibling);
  const lines = [`File not found: ${filePath}`];
  if (suggestions.length > 0) {
    lines.push("", "Did you mean one of these?", ...suggestions);
  }
  return lines.join("\n");
}

/** stat 失败后：父目录能列出时给建议，否则保留原始错误。 */
async function describeMissingPath(
  operations: FileOperations,
  filePath: string,
  statError: unknown,
): Promise<{ content: Array<{ type: "text"; text: string }>; isError: true }> {
  let entries: Awaited<ReturnType<FileOperations["listDir"]>>;
  const pathInfo = readPathInfo(filePath);
  try {
    entries = await operations.listDir(pathInfo.parent);
  } catch {
    return {
      content: [{ type: "text", text: `Error reading file: ${statError}` }],
      isError: true,
    };
  }

  return {
    content: [{
      type: "text",
      text: missingPathMessage(filePath, entries.map((entry) => entry.name), statError),
    }],
    isError: true,
  };
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/read.test.ts`
预期：PASS（现有 7 条 + 任务 1 的 10 条 + 任务 2 的 13 条 + 本次 11 条全绿）。

- [ ] **步骤 5：全量测试与类型检查**

运行：`pnpm --filter @openharness/tools exec vitest run`
预期：全绿。

运行：`pnpm --filter @openharness/tools run check-types`
预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/read.ts packages/tools/src/file/__test__/read.test.ts
git commit -m "feat(tools): add directory trailers and missing-path suggestions to read"
```

---

## 自检记录

- **规格覆盖度**：规格「接口」常量与纯函数 → 任务 1；「运行流程·文件读取」→ 任务 2（有限数归一、保留图片、严格解码、二进制、行拆分、越界、切片、trailer）；「运行流程·目录读取」→ 任务 3（行数/字节双上限、超长首项截断、目录越界、五种 trailer、非 1 offset 的范围提示）；「运行流程·文件不存在」→ 任务 3（父目录 sandbox 校验、完全同名保留原错误、稳定建议、POSIX/Windows 路径命名空间）；决策 1/9/10/12 均有直接测试；三处文本精确断言与既有二进制文案在任务 2 同步更新；现有 7 条测试保留，新增任务 1 的 11 条、任务 2 的 13 条、任务 3 的 11 条。
- **占位符扫描**：无 TODO / "待定" / "类似任务 N"；每个代码步骤均含完整可粘贴代码与真实断言。
- **类型一致性**：`DEFAULT_READ_LIMIT`、`MAX_READ_BYTES`、`MAX_READ_BYTES_LABEL`、`MAX_LINE_LENGTH`、`MAX_LINE_SUFFIX`、`BINARY_SAMPLE_CHARS`、`BINARY_CONTROL_RATIO`、`MAX_SUGGESTIONS`、`normalizeReadInteger`、`splitReadLines`、`isBinaryContent`、`truncateReadLine`、`sliceReadLines`、`sliceDirectoryEntries`、`readTrailer`、`suggestSimilarNames`、`readPathInfo`、`missingPathMessage`、`readDirectoryListing`、`describeMissingPath` 在任务 1-3 间命名一致；数组索引按仓库的 `noUncheckedIndexedAccess` 使用边界判断或非空断言。
- **任务边界**：任务 1 只加导出、`execute` 不变；任务 2 完成文件分支并同批更新文本/二进制断言，同时保留全部图片分支；任务 3 只加有界目录输出与缺失路径分支。每个任务结束时目标测试可独立全绿。
- **审查修正**：初稿会用 `readText` 覆盖现有 `readBytes` 图片流程、未限制目录字节数和超长首项、目录分页未报告实际范围、未处理目录越界和非有限入参、用宿主 `path.join` 破坏 WSL 路径、在未授权父目录上生成建议、使用不存在的 `typecheck` 脚本，并遗漏 `noUncheckedIndexedAccess`；本版均已修正并补回归测试。
