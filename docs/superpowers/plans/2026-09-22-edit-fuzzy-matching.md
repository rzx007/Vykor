# Edit 模糊匹配兜底 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `Edit` 在 `old_string` 与文件内容存在缩进、空白、行尾、转义差异时仍能正确替换，切断"精确匹配失败 → 模型改用整文件 `Write` → 大文件输出截断 → 分块写入"这条因果链。

**架构：** 把匹配策略抽成独立纯函数模块 `edit-replacers.ts`（9 级 replacer 兜底链 + 候选位置展开与歧义判断 + 吞大段护栏 + 行尾函数 + 可判别的 `EditMatchError`），`edit.ts` 变薄：安全校验 → 读 → BOM 处理 → 精确优先 → 兜底 → 写回。工具入参、返回结构、既有文案全部不变。

**技术栈：** TypeScript、Vitest、pnpm workspace。

**规格：** `docs/superpowers/specs/2026-09-22-edit-fuzzy-matching-design.md`

## 全局约束

- 新模块路径固定为 `packages/tools/src/file/edit-replacers.ts`，测试在 `packages/tools/src/file/__test__/edit-replacers.test.ts`。
- 导出名固定：`Replacer`、`replace`、`EditMatchError`、`EditMatchErrorKind`、`editMatchMessage`、`isDisproportionateMatch`、`normalizeLineEndings`、`detectLineEnding`、`convertToLineEnding`，以及 9 个 replacer 常量（`SimpleReplacer`、`LineTrimmedReplacer`、`BlockAnchorReplacer`、`WhitespaceNormalizedReplacer`、`IndentationFlexibleReplacer`、`EscapeNormalizedReplacer`、`TrimmedBoundaryReplacer`、`ContextAwareReplacer`、`MultiOccurrenceReplacer`）。
- `EditMatchErrorKind` 精确为 `"identical" | "not_found" | "ambiguous" | "disproportionate"`。
- 四类错误文案（逐字，不得改动）：
  - `identical`：`No changes to apply: oldString and newString are identical.`
  - `not_found`：`old_string not found in file.`
  - `ambiguous`：`Found multiple matches for oldString. Provide more surrounding context to make the match unique.`
  - `disproportionate`：`Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.`
- **既有文案逐字不变**：空 `old_string` → `old_string must not be empty.`；精确多命中 → `` `Found ${n} matches at lines ${lines}. Make old_string more specific or use replace_all to replace all.` ``；成功 → `` `Successfully edited ${filePath}` ``。
- 吞大段护栏在 `replaceAll` 为真/假两种分支下**都**生效。
- 空候选不得进入 `indexOf` / `replaceAll`；BOM 剥离后为空的 `desiredOld` 返回既有空字符串文案。
- 每个 replacer 必须产出全部合格候选；非 `replaceAll` 时，只要当前策略解析出多个位置就返回 `ambiguous`，不得静默选最高分或第一个。
- 同一候选自身重叠的位置也必须全部展开；`replaceAll` 遇到重叠位置返回 `ambiguous`。
- 锚点策略只扫描可能满足块长度的结尾，不得对每个首锚点遍历文件剩余部分。
- `identical` 校验必须发生在 `edit.ts` 的**内联精确替换之前**，但在路径、managed persistence、系统目录和 sandbox 校验之后。
- 不新增依赖；Levenshtein 内联实现。
- 不修改 `packages/tools/src/file/operations.ts`、`write.ts`、`read.ts`。
- 不修改 `packages/tools/src/file/__test__/edit.test.ts` 中现有 2 条用例的断言。
- 测试命令：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`（端到端为 `... src/file/__test__/edit.test.ts`）。
- 类型检查：`pnpm --filter @openharness/tools run check-types`。

---

### 任务 1：错误类型、行尾函数与吞大段护栏

**文件：**
- 创建：`packages/tools/src/file/edit-replacers.ts`
- 创建：`packages/tools/src/file/__test__/edit-replacers.test.ts`

- [ ] **步骤 1：编写失败的测试**

创建 `packages/tools/src/file/__test__/edit-replacers.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  EditMatchError,
  convertToLineEnding,
  detectLineEnding,
  editMatchMessage,
  isDisproportionateMatch,
  normalizeLineEndings,
} from "../edit-replacers.js";

describe("line endings", () => {
  it("normalizes CRLF to LF", () => {
    expect(normalizeLineEndings("a\r\nb\r\n")).toBe("a\nb\n");
  });

  it("detects the file line ending", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb\n")).toBe("\r\n");
  });

  it("converts LF to the target ending", () => {
    expect(convertToLineEnding("a\nb\n", "\n")).toBe("a\nb\n");
    expect(convertToLineEnding("a\nb\n", "\r\n")).toBe("a\r\nb\r\n");
  });
});

describe("isDisproportionateMatch", () => {
  it("accepts a search of comparable size", () => {
    expect(isDisproportionateMatch("const a = 1;\nconst b = 2;", "const a = 1;\nconst b = 2;")).toBe(
      false,
    );
  });

  it("rejects a search spanning far more lines than oldString", () => {
    const oldString = "line1\nline2";
    const search = Array.from({ length: 20 }, (_, index) => `line${index}`).join("\n");
    expect(isDisproportionateMatch(search, oldString)).toBe(true);
  });

  it("rejects a multi-line search whose text is far longer than oldString", () => {
    const spaces = " ".repeat(600);
    expect(isDisproportionateMatch(`a${spaces}b\nc${spaces}d`, "a b\nc d")).toBe(true);
  });

  it("rejects a single-line candidate that is far longer than oldString", () => {
    expect(isDisproportionateMatch("x".repeat(2000), "x")).toBe(true);
  });
});

describe("EditMatchError", () => {
  it("carries a discriminating kind and the matching message", () => {
    const error = new EditMatchError("ambiguous");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EditMatchError");
    expect(error.kind).toBe("ambiguous");
    expect(error.message).toBe(editMatchMessage("ambiguous"));
  });

  it("exposes one distinct message per kind", () => {
    const kinds = ["identical", "not_found", "ambiguous", "disproportionate"] as const;
    const messages = kinds.map((kind) => editMatchMessage(kind));
    expect(new Set(messages).size).toBe(kinds.length);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错无法解析模块 `../edit-replacers.js`。

- [ ] **步骤 3：编写最少实现代码**

创建 `packages/tools/src/file/edit-replacers.ts`：

```ts
// 匹配策略移植自 opencode 的 edit 工具（MIT），其实现又源自 cline（Apache-2.0）
// 与 gemini-cli（Apache-2.0）的 diff-apply / editCorrector。

export type EditMatchErrorKind =
  | "identical"
  | "not_found"
  | "ambiguous"
  | "disproportionate";

const EDIT_MATCH_MESSAGES: Record<EditMatchErrorKind, string> = {
  identical: "No changes to apply: oldString and newString are identical.",
  not_found: "old_string not found in file.",
  ambiguous:
    "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
  disproportionate:
    "Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement.",
};

export function editMatchMessage(kind: EditMatchErrorKind): string {
  return EDIT_MATCH_MESSAGES[kind];
}

export class EditMatchError extends Error {
  readonly kind: EditMatchErrorKind;

  constructor(kind: EditMatchErrorKind) {
    super(EDIT_MATCH_MESSAGES[kind]);
    this.name = "EditMatchError";
    this.kind = kind;
  }
}

export function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n");
}

export function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

export function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text;
  return text.replaceAll("\n", "\r\n");
}

export function isDisproportionateMatch(search: string, oldString: string): boolean {
  const oldLines = oldString.split("\n").length;
  const searchLines = search.split("\n").length;
  if (searchLines >= Math.max(oldLines + 3, oldLines * 2)) return true;
  return (
    search.trim().length > Math.max(oldString.trim().length + 500, oldString.trim().length * 4)
  );
}
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：PASS，全部用例通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/edit-replacers.ts packages/tools/src/file/__test__/edit-replacers.test.ts
git commit -m "feat(tools): add edit match error, line-ending helpers and guard"
```

---

### 任务 2：基础 replacer 策略

**文件：**
- 修改：`packages/tools/src/file/edit-replacers.ts`
- 修改：`packages/tools/src/file/__test__/edit-replacers.test.ts`

- [ ] **步骤 1：编写失败的测试**

在 `packages/tools/src/file/__test__/edit-replacers.test.ts` 的 import 中加入 `SimpleReplacer`、`LineTrimmedReplacer`、`WhitespaceNormalizedReplacer`、`IndentationFlexibleReplacer`、`EscapeNormalizedReplacer`、`TrimmedBoundaryReplacer`、`MultiOccurrenceReplacer`，并追加：

```ts
const collect = (replacer: Replacer, content: string, find: string): string[] => [
  ...replacer(content, find),
];

describe("SimpleReplacer", () => {
  it("yields the exact find string", () => {
    expect(collect(SimpleReplacer, "hello world", "world")).toEqual(["world"]);
  });

  it("yields nothing when content does not contain the find string", () => {
    expect(collect(SimpleReplacer, "hello", "missing")).toEqual([]);
  });
});

describe("LineTrimmedReplacer", () => {
  it("matches when only indentation differs", () => {
    const content = "function f() {\n    return 1;\n}";
    const find = "function f() {\n  return 1;\n}";
    const matches = collect(LineTrimmedReplacer, content, find);
    expect(matches).toContain("function f() {\n    return 1;\n}");
  });

  it("yields nothing when content differs", () => {
    expect(collect(LineTrimmedReplacer, "a\nb", "x\ny")).toEqual([]);
  });

  it("does not yield an empty line for a whitespace-only find", () => {
    expect(collect(LineTrimmedReplacer, "a\n\nb", "   ")).toEqual([]);
  });
});

describe("WhitespaceNormalizedReplacer", () => {
  it("matches when inner whitespace run length differs", () => {
    const matches = collect(WhitespaceNormalizedReplacer, "const a   =   1;", "const a = 1;");
    expect(matches.length).toBeGreaterThan(0);
  });

  it("yields nothing when normalized text differs", () => {
    expect(collect(WhitespaceNormalizedReplacer, "const a = 1;", "const b = 2;")).toEqual([]);
  });

  it("never turns a whitespace-only find into an empty candidate", () => {
    expect(collect(WhitespaceNormalizedReplacer, "a\n\nb", "   ")).toEqual([]);
  });

  it("yields every differently-spaced match on the same line", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(collect(WhitespaceNormalizedReplacer, content, "const a = 1;")).toEqual([
      "const a   = 1;",
      "const a\t= 1;",
    ]);
  });

  it("yields overlapping differently-spaced matches on the same line", () => {
    expect(collect(WhitespaceNormalizedReplacer, "a  a\t a", "a a")).toEqual([
      "a  a",
      "a\t a",
    ]);
  });
});

describe("IndentationFlexibleReplacer", () => {
  it("matches a block that is indented differently as a whole", () => {
    const content = "    if (x) {\n      go();\n    }";
    const find = "if (x) {\n  go();\n}";
    expect(collect(IndentationFlexibleReplacer, content, find).length).toBeGreaterThan(0);
  });

  it("yields nothing when block content differs", () => {
    expect(collect(IndentationFlexibleReplacer, "  a\n  b", "a\nc")).toEqual([]);
  });
});

describe("EscapeNormalizedReplacer", () => {
  it("matches when the find string carries literal escape sequences", () => {
    const content = "const a = 1;\nconst b = 2;";
    const find = "const a = 1;\\nconst b = 2;";
    expect(collect(EscapeNormalizedReplacer, content, find)).toContain(
      "const a = 1;\nconst b = 2;",
    );
  });

  it("yields nothing when the unescaped text is absent", () => {
    expect(collect(EscapeNormalizedReplacer, "alpha", "beta\\ngamma")).toEqual([]);
  });
});

describe("TrimmedBoundaryReplacer", () => {
  it("matches when the find string has surrounding blank lines", () => {
    const matches = collect(TrimmedBoundaryReplacer, "target", "\n\ntarget\n\n");
    expect(matches).toContain("target");
  });

  it("yields nothing when trimming would produce an empty candidate", () => {
    expect(collect(TrimmedBoundaryReplacer, "a\n\nb", "  \n  ")).toEqual([]);
  });
});

describe("MultiOccurrenceReplacer", () => {
  it("yields one entry per occurrence", () => {
    expect(collect(MultiOccurrenceReplacer, "a-a-a", "a")).toEqual(["a", "a", "a"]);
  });

  it("yields nothing when the text is absent or find is empty", () => {
    expect(collect(MultiOccurrenceReplacer, "abc", "z")).toEqual([]);
    expect(collect(MultiOccurrenceReplacer, "abc", "")).toEqual([]);
  });
});
```

同时在文件顶部补类型导入：`import type { Replacer } from "../edit-replacers.js";`

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错 `SimpleReplacer is not exported` / 无法解析导出。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/tools/src/file/edit-replacers.ts` 末尾追加：

```ts
export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export const SimpleReplacer: Replacer = function* (content, find) {
  if (find.length > 0 && content.includes(find)) yield find;
};

export const LineTrimmedReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") {
    searchLines.pop();
  }

  for (let i = 0; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      const originalLine = originalLines[i + j];
      const searchLine = searchLines[j];
      if (originalLine === undefined || searchLine === undefined || originalLine.trim() !== searchLine.trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) {
      matchStartIndex += originalLines[k]!.length + 1;
    }

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k]!.length;
      if (k < searchLines.length - 1) {
        matchEndIndex += 1;
      }
    }

    const candidate = content.substring(matchStartIndex, matchEndIndex);
    if (candidate.length > 0) yield candidate;
  }
};

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);
  if (normalizedFind.length === 0) return;

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalizeWhitespace(line).includes(normalizedFind)) continue;

    const words = find.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const pattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    for (const match of line.matchAll(new RegExp(`(?=(${pattern}))`, "g"))) {
      const candidate = match[1];
      if (candidate) yield candidate;
    }
  }

  const findLines = find.split("\n");
  if (findLines.length > 1) {
    for (let i = 0; i <= lines.length - findLines.length; i++) {
      const block = lines.slice(i, i + findLines.length);
      if (normalizeWhitespace(block.join("\n")) === normalizedFind) {
        yield block.join("\n");
      }
    }
  }
};

export const IndentationFlexibleReplacer: Replacer = function* (content, find) {
  const removeIndentation = (text: string) => {
    const lines = text.split("\n");
    const nonEmptyLines = lines.filter((line) => line.trim().length > 0);
    if (nonEmptyLines.length === 0) return text;
    const minIndent = Math.min(
      ...nonEmptyLines.map((line) => {
        const match = line.match(/^(\s*)/);
        return match?.[1]?.length ?? 0;
      }),
    );
    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(find);
  if (normalizedFind.length === 0) return;
  const contentLines = content.split("\n");
  const findLines = find.split("\n");

  for (let i = 0; i <= contentLines.length - findLines.length; i++) {
    const block = contentLines.slice(i, i + findLines.length).join("\n");
    if (removeIndentation(block) === normalizedFind) {
      yield block;
    }
  }
};

export const EscapeNormalizedReplacer: Replacer = function* (content, find) {
  const unescapeString = (str: string): string =>
    str.replace(/\\(n|t|r|'|"|`|\\|\n|\$)/g, (match, capturedChar: string) => {
      switch (capturedChar) {
        case "n":
          return "\n";
        case "t":
          return "\t";
        case "r":
          return "\r";
        case "'":
          return "'";
        case '"':
          return '"';
        case "`":
          return "`";
        case "\\":
          return "\\";
        case "\n":
          return "\n";
        case "$":
          return "$";
        default:
          return match;
      }
    });

  const unescapedFind = unescapeString(find);
  if (unescapedFind.length === 0) return;
  if (content.includes(unescapedFind)) {
    yield unescapedFind;
  }

  const lines = content.split("\n");
  const findLines = unescapedFind.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (unescapeString(block) === unescapedFind) {
      yield block;
    }
  }
};

export const TrimmedBoundaryReplacer: Replacer = function* (content, find) {
  const trimmedFind = find.trim();
  if (trimmedFind.length === 0 || trimmedFind === find) return;

  if (content.includes(trimmedFind)) {
    yield trimmedFind;
  }

  const lines = content.split("\n");
  const findLines = find.split("\n");
  for (let i = 0; i <= lines.length - findLines.length; i++) {
    const block = lines.slice(i, i + findLines.length).join("\n");
    if (block.trim() === trimmedFind) {
      yield block;
    }
  }
};

export const MultiOccurrenceReplacer: Replacer = function* (content, find) {
  if (find.length === 0) return;
  let startIndex = 0;
  while (true) {
    const index = content.indexOf(find, startIndex);
    if (index === -1) break;
    yield find;
    startIndex = index + find.length;
  }
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/edit-replacers.ts packages/tools/src/file/__test__/edit-replacers.test.ts
git commit -m "feat(tools): add basic edit replacer strategies"
```

---

### 任务 3：相似度类 replacer（锚点与上下文）

**文件：**
- 修改：`packages/tools/src/file/edit-replacers.ts`
- 修改：`packages/tools/src/file/__test__/edit-replacers.test.ts`

- [ ] **步骤 1：编写失败的测试**

在测试文件 import 中加入 `BlockAnchorReplacer`、`ContextAwareReplacer`，并追加：

```ts
describe("BlockAnchorReplacer", () => {
  it("matches a block whose middle differs slightly", () => {
    const content = [
      "function f() {",
      "  const a = 1;",
      "  return a;",
      "}",
    ].join("\n");
    const find = ["function f() {", "  const a = 2;", "  return a;", "}"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toContain(content);
  });

  it("yields nothing for blocks shorter than three lines", () => {
    expect(collect(BlockAnchorReplacer, "a\nb", "a\nb")).toEqual([]);
  });

  it("yields nothing when the middle is too dissimilar", () => {
    const content = ["start", "totally different middle", "end"].join("\n");
    const find = ["start", "another unrelated middle", "end"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toEqual([]);
  });

  it("yields every block that passes the similarity threshold", () => {
    const content = [
      "head", "return alpha;", "tail", "gap",
      "head", "return alphi;", "tail",
    ].join("\n");
    const find = ["head", "return alphx;", "tail"].join("\n");
    expect(collect(BlockAnchorReplacer, content, find)).toHaveLength(2);
  });

  it("limits end-anchor scanning to the allowed block-size window", () => {
    const content = Array.from({ length: 30_000 }, () => "}").join("\n");
    const startedAt = performance.now();
    expect(collect(BlockAnchorReplacer, content, ["}", "missing", "}"].join("\n")))
      .toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});

describe("ContextAwareReplacer", () => {
  it("matches a block with matching anchors and mostly matching middle", () => {
    const content = ["head", "body line", "tail"].join("\n");
    const find = ["head", "body line", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toContain(content);
  });

  it("yields nothing for fewer than three lines", () => {
    expect(collect(ContextAwareReplacer, "a", "a")).toEqual([]);
  });

  it("yields nothing when fewer than half of the middle lines match", () => {
    const content = ["head", "one", "two", "three", "tail"].join("\n");
    const find = ["head", "x", "y", "three", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toEqual([]);
  });

  it("yields every block that satisfies the context threshold", () => {
    const content = [
      "head", "shared", "one", "tail", "gap",
      "head", "shared", "two", "tail",
    ].join("\n");
    const find = ["head", "shared", "expected", "tail"].join("\n");
    expect(collect(ContextAwareReplacer, content, find)).toHaveLength(2);
  });

  it("does not scan every possible end anchor for a fixed-size block", () => {
    const content = Array.from({ length: 3_000 }, () => "}").join("\n");
    const startedAt = performance.now();
    expect(collect(ContextAwareReplacer, content, ["}", "missing", "}"].join("\n")))
      .toEqual([]);
    expect(performance.now() - startedAt).toBeLessThan(500);
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错 `BlockAnchorReplacer is not exported`。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/tools/src/file/edit-replacers.ts` 末尾追加：

```ts
const BLOCK_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);

  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);

  for (let i = 1; i <= a.length; i++) {
    const current = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1,
        current[j - 1]! + 1,
        previous[j - 1]! + cost,
      );
    }
    previous = current;
  }
  return previous[b.length]!;
}

function blockRangeToSubstring(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  return lines.slice(startLine, endLine + 1).join("\n");
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines[searchLines.length - 1] === "") searchLines.pop();
  if (searchLines.length < 3) return;

  const firstLineSearch = searchLines[0]!.trim();
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) continue;
    const expectedEndLine = i + searchBlockSize - 1;
    const minEndLine = Math.max(i + 2, expectedEndLine - maxLineDelta);
    const maxEndLine = Math.min(originalLines.length - 1, expectedEndLine + maxLineDelta);
    for (let j = minEndLine; j <= maxEndLine; j++) {
      if (originalLines[j]!.trim() !== lastLineSearch) continue;
      candidates.push({ startLine: i, endLine: j });
    }
  }

  if (candidates.length === 0) return;

  const similarityFor = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1;
    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j]!.trim();
      const searchLine = searchLines[j]!.trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) continue;
      similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
    }
    return similarity / linesToCheck;
  };

  for (const candidate of candidates) {
    const similarity = similarityFor(candidate.startLine, candidate.endLine);
    if (similarity >= BLOCK_SIMILARITY_THRESHOLD) {
      yield blockRangeToSubstring(originalLines, candidate.startLine, candidate.endLine);
    }
  }
};

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines[findLines.length - 1] === "") findLines.pop();
  if (findLines.length < 3) return;

  const contentLines = content.split("\n");
  const firstLine = findLines[0]!.trim();
  const lastLine = findLines[findLines.length - 1]!.trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstLine) continue;
    const endLine = i + findLines.length - 1;
    if (endLine >= contentLines.length || contentLines[endLine]!.trim() !== lastLine) continue;

    const blockLines = contentLines.slice(i, endLine + 1);
    let matchingLines = 0;
    let totalNonEmptyLines = 0;
    for (let k = 1; k < blockLines.length - 1; k++) {
      const blockLine = blockLines[k]!.trim();
      const findLine = findLines[k]!.trim();
      if (blockLine.length > 0 || findLine.length > 0) {
        totalNonEmptyLines++;
        if (blockLine === findLine) matchingLines++;
      }
    }
    if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
      yield blockLines.join("\n");
    }
  }
};
```

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：PASS。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/edit-replacers.ts packages/tools/src/file/__test__/edit-replacers.test.ts
git commit -m "feat(tools): add similarity-based edit replacers"
```

---

### 任务 4：`replace()` 组合算法

**文件：**
- 修改：`packages/tools/src/file/edit-replacers.ts`
- 修改：`packages/tools/src/file/__test__/edit-replacers.test.ts`

- [ ] **步骤 1：编写失败的测试**

在测试文件 import 中加入 `replace` 与类型 `Replacer`，并追加：

```ts
describe("replace", () => {
  it("applies an exact unique match", () => {
    expect(replace("a b c", "b", "X")).toBe("a X c");
  });

  it("recovers when only indentation differs", () => {
    const content = "function f() {\n    return 1;\n}";
    const find = "function f() {\n  return 1;\n}";
    expect(replace(content, find, "function f() {\n  return 2;\n}")).toContain("return 2;");
  });

  it("throws identical when oldString equals newString", () => {
    expect(() => replace("abc", "b", "b")).toThrowError(EditMatchError);
    try {
      replace("abc", "b", "b");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("identical");
    }
  });

  it("throws not_found when nothing matches", () => {
    try {
      replace("abc", "zzz", "X");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("not_found");
    }
  });

  it("throws ambiguous when candidates are not unique", () => {
    try {
      replace("same\nother\nsame", "same", "X");
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("ambiguous");
    }
  });

  it("replaces every occurrence when replaceAll is true", () => {
    expect(replace("a-a-a", "a", "b", true)).toBe("b-b-b");
  });

  it("rejects multiple different fuzzy locations instead of selecting the first", () => {
    const synthetic: Replacer = function* () {
      yield "alpha";
      yield "beta";
    };
    expect(() => replace("alpha / beta", "target", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("replaces all non-overlapping fuzzy locations when replaceAll is true", () => {
    const synthetic: Replacer = function* () {
      yield "alpha";
      yield "beta";
    };
    expect(replace("alpha / beta", "target", "X", true, [synthetic])).toBe("X / X");
  });

  it("rejects differently-spaced matches on the same line as ambiguous", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(() => replace(content, "const a = 1;", "X"))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("replaces every differently-spaced match on the same line", () => {
    const content = "const a   = 1; / const a\t= 1;";
    expect(replace(content, "const a = 1;", "X", true)).toBe("X / X");
  });

  it("rejects overlapping differently-spaced matches", () => {
    expect(() => replace("a  a\t a", "a a", "X"))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping differently-spaced replaceAll matches", () => {
    expect(() => replace("a  a\t a", "a a", "X", true))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping replaceAll locations", () => {
    const synthetic: Replacer = function* () {
      yield "ab";
      yield "bc";
    };
    expect(() => replace("abc", "target", "X", true, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping locations produced by one candidate", () => {
    const synthetic: Replacer = function* () {
      yield "aa";
    };
    expect(() => replace("aaa", "target", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("rejects overlapping replaceAll locations produced by one candidate", () => {
    const synthetic: Replacer = function* () {
      yield "aa";
    };
    expect(() => replace("aaa", "target", "X", true, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });

  it("ignores empty candidates in both branches", () => {
    const synthetic: Replacer = function* () {
      yield "";
    };
    for (const replaceAll of [false, true]) {
      expect(() => replace("abc", "   ", "X", replaceAll, [synthetic]))
        .toThrowError(expect.objectContaining({ kind: "not_found" }));
    }
  });

  it("throws disproportionate when a candidate spans far more than oldString", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    try {
      replace(search, "a\nb", "X", false, [synthetic]);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("disproportionate");
    }
  });

  it("applies the disproportionate guard in the replaceAll branch too", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    try {
      replace(search, "a\nb", "X", true, [synthetic]);
      throw new Error("expected throw");
    } catch (error) {
      expect((error as EditMatchError).kind).toBe("disproportionate");
    }
  });

  it("reports ambiguity before checking a non-unique disproportionate candidate", () => {
    const search = Array.from({ length: 10 }, (_, index) => `line${index}`).join("\n");
    const synthetic: Replacer = function* () {
      yield search;
    };
    const content = `${search}\nseparator\n${search}`;
    expect(() => replace(content, "a\nb", "X", false, [synthetic]))
      .toThrowError(expect.objectContaining({ kind: "ambiguous" }));
  });
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错 `replace is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/tools/src/file/edit-replacers.ts` 末尾追加：

```ts
export const REPLACERS: Replacer[] = [
  SimpleReplacer,
  LineTrimmedReplacer,
  BlockAnchorReplacer,
  WhitespaceNormalizedReplacer,
  IndentationFlexibleReplacer,
  EscapeNormalizedReplacer,
  TrimmedBoundaryReplacer,
  ContextAwareReplacer,
  MultiOccurrenceReplacer,
];

interface MatchSpan {
  start: number;
  end: number;
  search: string;
}

function collectMatchSpans(content: string, searches: string[]): MatchSpan[] {
  const spans = new Map<string, MatchSpan>();
  for (const search of searches) {
    let start = content.indexOf(search);
    while (start !== -1) {
      const span = { start, end: start + search.length, search };
      spans.set(`${span.start}:${span.end}`, span);
      start = content.indexOf(search, start + 1);
    }
  }
  return [...spans.values()].sort((left, right) => left.start - right.start || left.end - right.end);
}

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  replacers: Replacer[] = REPLACERS,
): string {
  if (oldString === newString) throw new EditMatchError("identical");

  for (const replacer of replacers) {
    const searches = [...new Set(replacer(content, oldString))].filter(
      (search) => search.length > 0,
    );
    const spans = collectMatchSpans(content, searches);
    if (spans.length === 0) continue;

    if (!replaceAll) {
      if (spans.length > 1) throw new EditMatchError("ambiguous");
      const span = spans[0]!;
      if (isDisproportionateMatch(span.search, oldString)) {
        throw new EditMatchError("disproportionate");
      }
      return content.slice(0, span.start) + newString + content.slice(span.end);
    }

    if (spans.some((span) => isDisproportionateMatch(span.search, oldString))) {
      throw new EditMatchError("disproportionate");
    }
    for (let index = 1; index < spans.length; index++) {
      if (spans[index]!.start < spans[index - 1]!.end) {
        throw new EditMatchError("ambiguous");
      }
    }

    let updated = content;
    for (const span of [...spans].reverse()) {
      updated = updated.slice(0, span.start) + newString + updated.slice(span.end);
    }
    return updated;
  }

  throw new EditMatchError("not_found");
}
```

> `REPLACERS` 按规格导出。`replacers` 参数默认取该列表，同时为候选歧义、空候选、重叠位置和吞大段护栏提供合成策略测试缝。组合层只在原内容上计算位置，再从后向前写回，避免新文本被后续匹配再次消费。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：PASS，全部用例通过。

- [ ] **步骤 5：Commit**

```bash
git add packages/tools/src/file/edit-replacers.ts packages/tools/src/file/__test__/edit-replacers.test.ts
git commit -m "feat(tools): add the edit replacer fallback chain"
```

---

### 任务 5：接入 `edit.ts`

**文件：**
- 修改：`packages/tools/src/file/edit.ts`
- 修改：`packages/tools/src/file/__test__/edit.test.ts`

- [ ] **步骤 1：编写失败的测试**

把 `packages/tools/src/file/__test__/edit.test.ts` 顶部的 `node:fs/promises` import 改为：

```ts
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
```

并在 `describe("fileEditTool", ...)` 内追加（沿用文件里现有的 `settings` 构造方式）：

```ts
const settings = {
  model: "m",
  apiFormat: "openai" as const,
  maxTurns: 1,
  permission: { mode: "default" as const },
  sandbox: { enabled: false },
};

it("recovers an edit when only indentation differs", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-indent-"));
  try {
    const file = join(dir, "code.ts");
    await writeFile(file, "function f() {\n    return 1;\n}\n", "utf-8");

    const result = await fileEditTool.execute!(
      {
        file_path: file,
        old_string: "function f() {\n  return 1;\n}",
        new_string: "function f() {\n  return 2;\n}",
      },
      { cwd: dir, settings },
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf-8")).toContain("return 2;");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers an edit when the file is CRLF and old_string is LF", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-crlf-"));
  try {
    const file = join(dir, "win.txt");
    await writeFile(file, "alpha\r\nbeta\r\ngamma\r\n", "utf-8");

    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "beta\ngamma", new_string: "BETA\nGAMMA" },
      { cwd: dir, settings },
    );

    expect(result.isError).toBeFalsy();
    const after = await readFile(file, "utf-8");
    expect(after).toContain("BETA\r\nGAMMA");
    expect(after).not.toContain("BETA\nGAMMA");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("preserves a UTF-8 BOM when editing the first line", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-bom-"));
  try {
    const file = join(dir, "bom.txt");
    await writeFile(file, "\uFEFFtitle\nbody\n", "utf-8");

    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "title", new_string: "TITLE" },
      { cwd: dir, settings },
    );

    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf-8")).toBe("\uFEFFTITLE\nbody\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects an edit when old_string equals new_string even if the text exists", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-same-"));
  try {
    const file = join(dir, "same.txt");
    await writeFile(file, "keep me\n", "utf-8");

    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "keep me", new_string: "keep me" },
      { cwd: dir, settings },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "No changes to apply: oldString and newString are identical.",
    );
    expect(await readFile(file, "utf-8")).toBe("keep me\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("reports ambiguous when a CRLF file has multiple normalized matches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-ambig-crlf-"));
  try {
    const file = join(dir, "multi.txt");
    await writeFile(file, "alpha\r\nbeta\r\nother\r\nalpha\r\nbeta\r\n", "utf-8");

    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "alpha\nbeta", new_string: "ALPHA\nBETA" },
      { cwd: dir, settings },
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers an edit when whitespace run lengths differ", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-whitespace-"));
  try {
    const file = join(dir, "spacing.ts");
    await writeFile(file, "const value   =   1;\n", "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "const value = 1;", new_string: "const value = 2;" },
      { cwd: dir, settings },
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf-8")).toBe("const value = 2;\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("recovers an edit when old_string contains literal escapes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-escape-"));
  try {
    const file = join(dir, "escaped.txt");
    await writeFile(file, "alpha\nbeta\n", "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "alpha\\nbeta", new_string: "ALPHA\nBETA" },
      { cwd: dir, settings },
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf-8")).toBe("ALPHA\nBETA\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("replaces every exact occurrence when replace_all is true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-all-"));
  try {
    const file = join(dir, "all.txt");
    await writeFile(file, "old / old / old", "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "old", new_string: "new", replace_all: true },
      { cwd: dir, settings },
    );
    expect(result.isError).toBeFalsy();
    expect(await readFile(file, "utf-8")).toBe("new / new / new");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps the existing not-found message and does not modify the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-missing-"));
  try {
    const file = join(dir, "missing.txt");
    await writeFile(file, "original\n", "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "absent", new_string: "new" },
      { cwd: dir, settings },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "old_string not found in file.",
    );
    expect(await readFile(file, "utf-8")).toBe("original\n");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("rejects multiple different fuzzy locations and leaves the file unchanged", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-fuzzy-ambiguous-"));
  try {
    const file = join(dir, "ambiguous.ts");
    const before = [
      "if (ready) {", "    run();", "}",
      "if (ready) {", "      run();", "}",
    ].join("\n");
    await writeFile(file, before, "utf-8");
    const result = await fileEditTool.execute!(
      {
        file_path: file,
        old_string: "if (ready) {\n  run();\n}",
        new_string: "if (ready) {\n  stop();\n}",
      },
      { cwd: dir, settings },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "Found multiple matches for oldString. Provide more surrounding context to make the match unique.",
    );
    expect(await readFile(file, "utf-8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("does not expand a whitespace-only fuzzy search when replace_all is true", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-empty-candidate-"));
  try {
    const file = join(dir, "blank.txt");
    const before = "alpha\n\nbeta\n";
    await writeFile(file, before, "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "   ", new_string: "X", replace_all: true },
      { cwd: dir, settings },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "old_string not found in file.",
    );
    expect(await readFile(file, "utf-8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("treats an old_string containing only BOM as empty after BOM normalization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-bom-only-"));
  try {
    const file = join(dir, "bom-only.txt");
    const before = "\uFEFFtitle\n";
    await writeFile(file, before, "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "\uFEFF", new_string: "X", replace_all: true },
      { cwd: dir, settings },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text).toBe(
      "old_string must not be empty.",
    );
    expect(await readFile(file, "utf-8")).toBe(before);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

it("keeps sandbox denial ahead of the identical-string check", async () => {
  const dir = await mkdtemp(join(tmpdir(), "oh-edit-identical-sandbox-"));
  try {
    const file = join(dir, "secret.txt");
    await writeFile(file, "same", "utf-8");
    const result = await fileEditTool.execute!(
      { file_path: file, old_string: "same", new_string: "same" },
      {
        cwd: dir,
        settings: {
          ...settings,
          sandbox: {
            enabled: true,
            filesystem: { allowRead: ["."], denyRead: ["secret.txt"], allowWrite: ["."] },
          },
        },
      },
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { type: string; text: string }).text)
      .toContain("denied by sandbox rule");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit.test.ts`
预期：FAIL。至少缩进、空白、CRLF、BOM、转义、`identical` 与模糊歧义用例失败；既有精确路径、未命中、纯空白保护和 sandbox 优先级用例可继续通过。

- [ ] **步骤 3：改写 `edit.ts` 的匹配与写回部分**

在 `packages/tools/src/file/edit.ts` 顶部补充 import：

```ts
import {
  EditMatchError,
  convertToLineEnding,
  detectLineEnding,
  editMatchMessage,
  normalizeLineEndings,
  replace as replaceFuzzy,
} from "./edit-replacers.js";
```

保留现有空 `old_string` 校验。完成路径解析、managed persistence、系统目录以及 sandbox 读写校验后，在 `const operations = fileOperationsFor(context);` 之前加入 `identical` 校验：

```ts
    if (oldString === newString) {
      return {
        content: [{ type: "text", text: editMatchMessage("identical") }],
        isError: true,
      };
    }
```

把原来"读文件 → 精确匹配 → 写回"的那一段（从 `const operations = fileOperationsFor(context);` 到 `await operations.writeText(filePath, updated);`）替换为：

```ts
      const operations = fileOperationsFor(context);
      const content = await operations.readText(filePath);

      const hasBom = content.startsWith("\uFEFF");
      const body = hasBom ? content.slice(1) : content;
      const desiredOld = oldString.startsWith("\uFEFF") ? oldString.slice(1) : oldString;
      const desiredNew = newString.startsWith("\uFEFF") ? newString.slice(1) : newString;

      if (desiredOld.length === 0) {
        return {
          content: [{ type: "text", text: "old_string must not be empty." }],
          isError: true,
        };
      }

      let updated: string;
      if (body.includes(desiredOld)) {
        const occurrences = body.split(desiredOld).length - 1;
        if (occurrences > 1 && !replaceAll) {
          const lines = findMatchLines(body, desiredOld);
          return {
            content: [
              {
                type: "text",
                text: `Found ${occurrences} matches at lines ${lines.join(", ")}. Make old_string more specific or use replace_all to replace all.`,
              },
            ],
            isError: true,
          };
        }
        updated = replaceAll
          ? body.replaceAll(desiredOld, desiredNew)
          : body.replace(desiredOld, desiredNew);
      } else {
        const ending = detectLineEnding(body);
        const normalizedOld = convertToLineEnding(normalizeLineEndings(desiredOld), ending);
        const normalizedNew = convertToLineEnding(normalizeLineEndings(desiredNew), ending);
        try {
          updated = replaceFuzzy(body, normalizedOld, normalizedNew, replaceAll);
        } catch (error) {
          if (error instanceof EditMatchError) {
            return {
              content: [{ type: "text", text: editMatchMessage(error.kind) }],
              isError: true,
            };
          }
          throw error;
        }
      }

      await operations.writeText(filePath, (hasBom ? "\uFEFF" : "") + updated);

      return {
        content: [{ type: "text", text: `Successfully edited ${filePath}` }],
      };
```

保持 `findMatchLines` 函数原样不动。

- [ ] **步骤 4：运行测试验证通过**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit.test.ts`
预期：PASS，现有 2 条 + 新增 13 条全部通过。

- [ ] **步骤 5：跑整个 tools 包测试与类型检查**

运行：`pnpm --filter @openharness/tools exec vitest run`
预期：全绿。

运行：`pnpm --filter @openharness/tools run check-types`
预期：通过。

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/edit.ts packages/tools/src/file/__test__/edit.test.ts
git commit -m "feat(tools): use fuzzy matching fallback in the edit tool"
```

---

## 自检记录

- **规格覆盖度**：规格「接口」的 `EditMatchError`/`editMatchMessage`/行尾三函数/护栏/9 个 replacer/`replace`/`REPLACERS` → 任务 1（错误类型+行尾+护栏）、任务 2（7 个基础 replacer）、任务 3（2 个相似度 replacer）、任务 4（位置展开、空候选过滤、歧义、重叠检测、从后向前替换）；规格「运行流程·`edit.ts` 调用顺序」→ 任务 5 步骤 3；规格「错误处理」与安全校验优先级 → 任务 4-5；规格「测试」→ 任务 1-4 的纯函数测试 + 任务 5 的现有 2 条与新增 13 条端到端测试。
- **占位符扫描**：无 TODO / "待定" / "类似任务 N"；每个代码步骤都带完整可粘贴代码；测试均为真实断言。
- **类型一致性**：`EditMatchErrorKind` 四值、`Replacer`、`replace`、`REPLACERS`、`editMatchMessage`、`isDisproportionateMatch`、`normalizeLineEndings`/`detectLineEnding`/`convertToLineEnding`、9 个 replacer 常量名在任务 1-5 中一致；`edit.ts` 导入名与模块导出一致。
- **规格一致性**：`edit.ts` 使用 `error.kind` 调用 `editMatchMessage`；`REPLACERS` 按接口导出；`identical` 位于安全校验之后、读取和替换之前；类型检查命令与 `packages/tools/package.json` 的 `check-types` 脚本一致。
- **自查中修正的十处计划缺陷**（初稿写错、已改）：
  1. 吞大段护栏在正常输入下无法被真实 replacer 链触发，故为其加了 `replacers` 注入参数与合成 replacer 测试（规格同步更新）；原先基于"40 行文件 + 4 行 old_string + replace_all"的用例实际会走精确路径并成功，已删除。
  2. 初稿让 `isDisproportionateMatch` 对单行 `oldString` 恒返回 `false`，会放过单行内数百个连续空格；现统一应用字符长度阈值，并补单行回归测试。
  3. CRLF 歧义用例若 `old_string` 不含换行，会命中精确路径并返回带行号文案而非 `ambiguous`，已改为"含 LF 的两行片段在 CRLF 文件中重复出现"。
  4. 空候选可能触发 `replaceAll("", newString)`，现由 BOM 后二次校验、各策略防御和组合层统一过滤三层阻断。
  5. 锚点/上下文策略原先会静默挑选第一个或最高分候选，现改为产出全部合格候选，由组合层按位置数量判歧义。
  6. 初稿未适配仓库的 `noUncheckedIndexedAccess`，现有数组索引均通过边界分支、局部变量或非空断言明确证明。
  7. 初稿遗漏多项规格测试并写错类型检查脚本名，现补齐端到端矩阵并改用 `check-types`。
  8. 同一候选原先按候选长度跳步，遗漏自身重叠的位置；现按一个字符推进并覆盖 `replaceAll` 两个分支。
  9. 空白归一策略原先只产出同一行的第一个非重叠正则命中；现用零宽前瞻的全局 `matchAll` 产出全部空白变体，包括互相重叠的位置。
  10. 两个锚点策略原先会扫描每个首锚点后的全部行；现按允许的块长度限定结尾，并加入重复锚点性能回归。
