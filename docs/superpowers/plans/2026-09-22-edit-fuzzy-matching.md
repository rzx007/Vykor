# Edit 模糊匹配兜底 实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 让 `Edit` 在 `old_string` 与文件内容存在缩进、空白、行尾、转义差异时仍能正确替换，切断"精确匹配失败 → 模型改用整文件 `Write` → 大文件输出截断 → 分块写入"这条因果链。

**架构：** 把匹配策略抽成独立纯函数模块 `edit-replacers.ts`（9 级 replacer 兜底链 + 吞大段护栏 + 行尾函数 + 可判别的 `EditMatchError`），`edit.ts` 变薄：读 → BOM 处理 → 精确优先 → 兜底 → 写回。工具入参、返回结构、既有文案全部不变。

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
- `identical` 校验必须发生在 `edit.ts` 的**内联精确替换之前**。
- 不新增依赖；Levenshtein 内联实现。
- 不修改 `packages/tools/src/file/operations.ts`、`write.ts`、`read.ts`。
- 不修改 `packages/tools/src/file/__test__/edit.test.ts` 中现有 2 条用例的断言。
- 测试命令：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`（端到端为 `... src/file/__test__/edit.test.ts`）。
- 类型检查：`pnpm --filter @openharness/tools run typecheck`（若该脚本不存在，改用 `pnpm --filter @openharness/tools exec tsc --noEmit`，以 `packages/tools/package.json` 实际脚本为准）。

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

  it("never rejects a single-line oldString", () => {
    expect(isDisproportionateMatch("x".repeat(2000), "x")).toBe(false);
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
  if (oldLines === 1) return false;
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
});

describe("WhitespaceNormalizedReplacer", () => {
  it("matches when inner whitespace run length differs", () => {
    const matches = collect(WhitespaceNormalizedReplacer, "const a   =   1;", "const a = 1;");
    expect(matches.length).toBeGreaterThan(0);
  });
});

describe("IndentationFlexibleReplacer", () => {
  it("matches a block that is indented differently as a whole", () => {
    const content = "    if (x) {\n      go();\n    }";
    const find = "if (x) {\n  go();\n}";
    expect(collect(IndentationFlexibleReplacer, content, find).length).toBeGreaterThan(0);
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
});

describe("TrimmedBoundaryReplacer", () => {
  it("matches when the find string has surrounding blank lines", () => {
    const matches = collect(TrimmedBoundaryReplacer, "target", "\n\ntarget\n\n");
    expect(matches).toContain("target");
  });
});

describe("MultiOccurrenceReplacer", () => {
  it("yields one entry per occurrence", () => {
    expect(collect(MultiOccurrenceReplacer, "a-a-a", "a")).toEqual(["a", "a", "a"]);
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

export const SimpleReplacer: Replacer = function* (_content, find) {
  yield find;
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
      if (originalLines[i + j].trim() !== searchLines[j].trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) continue;

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) {
      matchStartIndex += originalLines[k].length + 1;
    }

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k].length;
      if (k < searchLines.length - 1) {
        matchEndIndex += 1;
      }
    }

    yield content.substring(matchStartIndex, matchEndIndex);
  }
};

export const WhitespaceNormalizedReplacer: Replacer = function* (content, find) {
  const normalizeWhitespace = (text: string) => text.replace(/\s+/g, " ").trim();
  const normalizedFind = normalizeWhitespace(find);

  const lines = content.split("\n");
  for (const line of lines) {
    if (normalizeWhitespace(line) === normalizedFind) {
      yield line;
      continue;
    }
    if (!normalizeWhitespace(line).includes(normalizedFind)) continue;

    const words = find.trim().split(/\s+/);
    if (words.length === 0) continue;
    const pattern = words
      .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("\\s+");
    try {
      const match = line.match(new RegExp(pattern));
      if (match) yield match[0];
    } catch {
      // 无效正则，跳过
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
        return match ? match[1].length : 0;
      }),
    );
    return lines
      .map((line) => (line.trim().length === 0 ? line : line.slice(minIndent)))
      .join("\n");
  };

  const normalizedFind = removeIndentation(find);
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
  if (trimmedFind === find) return;

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
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错 `BlockAnchorReplacer is not exported`。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/tools/src/file/edit-replacers.ts` 末尾追加：

```ts
const SINGLE_CANDIDATE_SIMILARITY_THRESHOLD = 0.65;
const MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD = 0.65;

function levenshtein(a: string, b: string): number {
  if (a === "" || b === "") return Math.max(a.length, b.length);

  const matrix = Array.from({ length: a.length + 1 }, (_, i) =>
    Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  );

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }
  return matrix[a.length][b.length];
}

function blockRangeToSubstring(
  lines: string[],
  startLine: number,
  endLine: number,
): string {
  let matchStartIndex = 0;
  for (let k = 0; k < startLine; k++) {
    matchStartIndex += lines[k].length + 1;
  }
  let matchEndIndex = matchStartIndex;
  for (let k = startLine; k <= endLine; k++) {
    matchEndIndex += lines[k].length;
    if (k < endLine) matchEndIndex += 1;
  }
  return lines.join("\n").substring(matchStartIndex, matchEndIndex);
}

export const BlockAnchorReplacer: Replacer = function* (content, find) {
  const originalLines = content.split("\n");
  const searchLines = find.split("\n");

  if (searchLines.length < 3) return;
  if (searchLines[searchLines.length - 1] === "") searchLines.pop();

  const firstLineSearch = searchLines[0].trim();
  const lastLineSearch = searchLines[searchLines.length - 1].trim();
  const searchBlockSize = searchLines.length;
  const maxLineDelta = Math.max(1, Math.floor(searchBlockSize * 0.25));

  const candidates: Array<{ startLine: number; endLine: number }> = [];
  for (let i = 0; i < originalLines.length; i++) {
    if (originalLines[i].trim() !== firstLineSearch) continue;
    for (let j = i + 2; j < originalLines.length; j++) {
      if (originalLines[j].trim() === lastLineSearch) {
        const actualBlockSize = j - i + 1;
        if (Math.abs(actualBlockSize - searchBlockSize) <= maxLineDelta) {
          candidates.push({ startLine: i, endLine: j });
        }
        break;
      }
    }
  }

  if (candidates.length === 0) return;

  const similarityFor = (startLine: number, endLine: number): number => {
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    if (linesToCheck <= 0) return 1;
    let similarity = 0;
    for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
      const originalLine = originalLines[startLine + j].trim();
      const searchLine = searchLines[j].trim();
      const maxLen = Math.max(originalLine.length, searchLine.length);
      if (maxLen === 0) continue;
      similarity += 1 - levenshtein(originalLine, searchLine) / maxLen;
    }
    return similarity / linesToCheck;
  };

  if (candidates.length === 1) {
    const { startLine, endLine } = candidates[0];
    const actualBlockSize = endLine - startLine + 1;
    const linesToCheck = Math.min(searchBlockSize - 2, actualBlockSize - 2);
    let similarity = 1;
    if (linesToCheck > 0) {
      similarity = 0;
      for (let j = 1; j < searchBlockSize - 1 && j < actualBlockSize - 1; j++) {
        const originalLine = originalLines[startLine + j].trim();
        const searchLine = searchLines[j].trim();
        const maxLen = Math.max(originalLine.length, searchLine.length);
        if (maxLen === 0) continue;
        similarity += (1 - levenshtein(originalLine, searchLine) / maxLen) / linesToCheck;
        if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) break;
      }
    }
    if (similarity >= SINGLE_CANDIDATE_SIMILARITY_THRESHOLD) {
      yield blockRangeToSubstring(originalLines, startLine, endLine);
    }
    return;
  }

  let bestMatch: { startLine: number; endLine: number } | null = null;
  let maxSimilarity = -1;
  for (const candidate of candidates) {
    const similarity = similarityFor(candidate.startLine, candidate.endLine);
    if (similarity > maxSimilarity) {
      maxSimilarity = similarity;
      bestMatch = candidate;
    }
  }
  if (bestMatch && maxSimilarity >= MULTIPLE_CANDIDATES_SIMILARITY_THRESHOLD) {
    yield blockRangeToSubstring(originalLines, bestMatch.startLine, bestMatch.endLine);
  }
};

export const ContextAwareReplacer: Replacer = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length < 3) return;
  if (findLines[findLines.length - 1] === "") findLines.pop();

  const contentLines = content.split("\n");
  const firstLine = findLines[0].trim();
  const lastLine = findLines[findLines.length - 1].trim();

  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i].trim() !== firstLine) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j].trim() !== lastLine) continue;

      const blockLines = contentLines.slice(i, j + 1);
      if (blockLines.length === findLines.length) {
        let matchingLines = 0;
        let totalNonEmptyLines = 0;
        for (let k = 1; k < blockLines.length - 1; k++) {
          const blockLine = blockLines[k].trim();
          const findLine = findLines[k].trim();
          if (blockLine.length > 0 || findLine.length > 0) {
            totalNonEmptyLines++;
            if (blockLine === findLine) matchingLines++;
          }
        }
        if (totalNonEmptyLines === 0 || matchingLines / totalNonEmptyLines >= 0.5) {
          yield blockLines.join("\n");
          return;
        }
      }
      break;
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
});
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit-replacers.test.ts`
预期：FAIL，报错 `replace is not a function`。

- [ ] **步骤 3：编写最少实现代码**

在 `packages/tools/src/file/edit-replacers.ts` 末尾追加：

```ts
const REPLACERS: Replacer[] = [
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

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
  replacers: Replacer[] = REPLACERS,
): string {
  if (oldString === newString) throw new EditMatchError("identical");

  let sawCandidate = false;

  for (const replacer of replacers) {
    for (const search of replacer(content, oldString)) {
      const index = content.indexOf(search);
      if (index === -1) continue;

      sawCandidate = true;
      if (isDisproportionateMatch(search, oldString)) {
        throw new EditMatchError("disproportionate");
      }

      if (replaceAll) {
        return content.replaceAll(search, newString);
      }

      const lastIndex = content.lastIndexOf(search);
      if (index !== lastIndex) continue;

      return content.slice(0, index) + newString + content.slice(index + search.length);
    }
  }

  throw new EditMatchError(sawCandidate ? "ambiguous" : "not_found");
}
```

> `replacers` 参数默认取模块内的 `REPLACERS`，只为测试注入合成 replacer 提供缝（当前 9 个 replacer 在正常输入下不会产出超长候选，护栏无法被真实链路触发）。默认行为不变。

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

在 `packages/tools/src/file/__test__/edit.test.ts` 顶部补充 import：

```ts
import { readFile } from "node:fs/promises";
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
```

- [ ] **步骤 2：运行测试验证失败**

运行：`pnpm --filter @openharness/tools exec vitest run src/file/__test__/edit.test.ts`
预期：FAIL。缩进、CRLF、BOM、`identical`、CRLF 歧义五条新用例均失败（现有 2 条仍通过）。

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

在空 `old_string` 校验之后**立即**加入 `identical` 校验（必须在路径/沙箱校验与内联精确替换之前）：

```ts
    if (!oldString) {
      return {
        content: [{ type: "text", text: "old_string must not be empty." }],
        isError: true,
      };
    }

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
            return { content: [{ type: "text", text: error.message }], isError: true };
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
预期：PASS，现有 2 条 + 新增 5 条全部通过。

- [ ] **步骤 5：跑整个 tools 包测试与类型检查**

运行：`pnpm --filter @openharness/tools exec vitest run`
预期：全绿。

运行：`pnpm --filter @openharness/tools run typecheck`
预期：通过。（若该脚本不存在，改跑 `pnpm --filter @openharness/tools exec tsc --noEmit`。）

- [ ] **步骤 6：Commit**

```bash
git add packages/tools/src/file/edit.ts packages/tools/src/file/__test__/edit.test.ts
git commit -m "feat(tools): use fuzzy matching fallback in the edit tool"
```

---

## 自检记录

- **规格覆盖度**：规格「接口」的 `EditMatchError`/`editMatchMessage`/行尾三函数/护栏/9 个 replacer/`replace`/`REPLACERS` → 任务 1（错误类型+行尾+护栏）、任务 2（7 个基础 replacer）、任务 3（2 个相似度 replacer）、任务 4（`replace` 组合 + 注入缝）；规格「运行流程·`replace()` 算法」→ 任务 4 步骤 3；规格「运行流程·`edit.ts` 调用顺序」8 步 → 任务 5 步骤 3；规格「错误处理」表 → 任务 4（`not_found`/`ambiguous`/`disproportionate`/`identical`）+ 任务 5（CRLF、BOM Host、`identical` 前置、CRLF 归一歧义）；规格「测试」→ 任务 1-4 的纯函数测试 + 任务 5 的端到端 7 条（现有 2 条 + 新增 5 条：缩进/CRLF/BOM/identical/归一歧义）。
- **占位符扫描**：无 TODO / "待定" / "类似任务 N"；每个代码步骤都带完整可粘贴代码；测试均为真实断言。
- **类型一致性**：`EditMatchErrorKind` 四值、`Replacer`、`replace`、`REPLACERS`、`editMatchMessage`、`isDisproportionateMatch`、`normalizeLineEndings`/`detectLineEnding`/`convertToLineEnding`、9 个 replacer 常量名在任务 1-5 中一致；`edit.ts` 导入名与模块导出一致。
- **与规格的显式差异**：规格「接口」写「`edit.ts` 按 `error.kind` 分派」，本计划实现为 `EditMatchError.message` 已由同一张表生成、`edit.ts` 直接返回 `error.message`，并提供 `editMatchMessage(kind)` 供 `identical` 前置校验复用。语义等价，且避免了两处文案表。
- **自查中修正的三处计划缺陷**（初稿写错、已改）：
  1. 吞大段护栏在正常输入下无法被真实 replacer 链触发，故为其加了 `replacers` 注入参数与合成 replacer 测试（规格同步更新）；原先基于"40 行文件 + 4 行 old_string + replace_all"的用例实际会走精确路径并成功，已删除。
  2. `isDisproportionateMatch` 对**单行** `oldString` 恒返回 `false`，原"单行长串应被拒"的断言写反了，已改为多行超长文本用例。
  3. CRLF 歧义用例若 `old_string` 不含换行，会命中精确路径并返回带行号文案而非 `ambiguous`，已改为"含 LF 的两行片段在 CRLF 文件中重复出现"。
