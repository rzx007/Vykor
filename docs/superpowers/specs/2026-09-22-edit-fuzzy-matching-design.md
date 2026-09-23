# Edit 模糊匹配兜底设计

> 状态：待实现。

## 目标

让 `Edit` 工具在 `old_string` 与文件实际内容存在**缩进、空白、行尾、转义**差异时仍能正确替换。当前 `Edit` 是精确子串匹配，差一个空格或换行就直接失败；失败后模型往往改用 `Write` 整文件重写，而整文件重写在大文件上会触发"单次输出截断 → 分多次写入 → 向用户解释分段原因"的连锁反应。修复匹配健壮性即切断这条因果链。

本阶段只改匹配策略。工具的入参、返回结构、既有错误文案与成功文案全部不变。

## 背景与现状

`packages/tools/src/file/edit.ts` 的匹配核心只有一行：

```ts
if (!content.includes(oldString)) {
  return { content: [{ type: "text", text: "old_string not found in file." }], isError: true };
}
```

它的三个脆弱点：

1. **精确匹配，零容错**。缩进、空白、行尾任一不同即失败。
2. **不处理行尾**。文件是 CRLF、模型给 LF 的 `old_string` 时必然失败。`HostFileOperations.readText`（`packages/tools/src/file/operations.ts:51`）用 `readFile(path, "utf-8")`，不做任何行尾归一。
3. **不处理 BOM**。`readFile(path, "utf-8")` 不剥离 BOM，`\uFEFF` 留在内容开头，编辑首行容易失败。

现有行为细节（必须保留）：

- 空 `old_string` → `"old_string must not be empty."`
- 未命中 → `"old_string not found in file."`
- 命中多处且未开 `replace_all` → `"Found N matches at lines .... Make old_string more specific or use replace_all to replace all."`（`findMatchLines` 计算行号；`packages/tools/src/file/__test__/edit.test.ts:30` 精确断言了这条文案）
- 成功 → `"Successfully edited ${filePath}"`

## 术语

- **replacer**：一个 `(content, find) => Generator<string>` 函数，产出所有候选匹配片段。产出 0 个表示该策略不适用。
- **匹配位置（span）**：候选片段在原内容中的一个 `[start, end)` 区间。同一个候选片段出现多次时会展开成多个位置。
- **唯一匹配**：当前策略最终只解析出一个去重后的位置。不能仅凭某个候选片段自身只出现一次就认定唯一，因为同一策略可能同时产出多个不同片段。
- **兜底链**：按固定优先级依次尝试的 replacer 列表。第一个解析出有效位置的策略决定结果：非 `replaceAll` 时一个位置才替换，多个位置立即报歧义；`replaceAll` 时替换该策略解析出的全部不重叠位置。
- **吞大段（disproportionate match）**：模糊匹配到的片段远大于 `old_string`，说明匹配跑偏，必须拒绝。

## 设计决策

1. **匹配逻辑抽成独立纯函数模块** `packages/tools/src/file/edit-replacers.ts`，`edit.ts` 变薄。理由：9 级策略各自需要独立单测，混在工具执行流程里无法单独验证。

2. **移植 opencode 的 9 级兜底链**，顺序即优先级：精确 → 逐行 trim → 首尾锚点(Levenshtein ≥0.65) → 空白归一 → 缩进无关 → 转义还原 → 边界 trim → 上下文行(≥50%) → 多 occurrence。该链路源自 cline / gemini-cli 的实践，opencode 已在多供应商环境验证。全部为纯函数。锚点策略只扫描可能满足块长度约束的结尾：`BlockAnchorReplacer` 限定为目标行数 ±25%，`ContextAwareReplacer` 直接检查固定结尾，不能对每个首锚点遍历文件剩余部分。

3. **不新增依赖**。Levenshtein 距离内联实现（opencode 亦如此）；不需要 `diff` 包（该包只用于产出 patch 供 UI/授权展示，本阶段不做）。

4. **保留现有精确匹配的歧义语义**。精确命中多处且未开 `replaceAll` 时，仍返回带行号的原文案。模糊策略只在其后兜底，不改变精确路径的既有行为。

5. **吞大段护栏必须存在**。模糊匹配（尤其锚点与上下文策略）可能匹配到"另一段相似代码"。命中前先过 `isDisproportionateMatch`，超限直接拒绝替换并报错，不做静默选择。

   **关于可测性**：当前 9 个 replacer 在正常输入下都不会产出"远超 `oldString`"的候选——只有病态输入（例如单行内数百个连续空格）才可能触发。因此 `replace` 的 `replacers` 参数默认取模块内的 `REPLACERS`，允许测试注入一个"故意产出超长候选"的合成 replacer 来精确验证护栏接线。这是依赖注入式测试缝，不改变默认行为。

6. **空候选永远无效**。replacer 产出的 `""` 不得进入 `indexOf` / `replaceAll`，否则 JavaScript 会把新文本插入每个字符边界。组合层统一丢弃空候选；BOM 剥离后若 `desiredOld` 变为空串，`edit.ts` 返回既有的 `"old_string must not be empty."`，不读写文件。纯空白 `old_string` 仍可走精确匹配，但模糊策略不得通过 trim 把它退化为空候选。

7. **行尾在文本层归一**。读取原内容后探测其行尾，把 `oldString`/`newString` 先归一成 LF、再转成文件自身行尾，然后匹配/替换；写回保持文件原行尾。不修改 `operations.readText`/`writeText`，避免波及 Read 工具等全局读取路径。

8. **BOM 在文本层处理，且只对 Host 环境承诺往返保留**。读取后检测前导 `\uFEFF`，剥离后参与匹配；`old_string`/`new_string` 也剥一次前导 BOM，保证两侧一致；写回时按原样补回。

   **环境差异（必须明确，否则实现与测试会踩空）**：
   - Host（`HostFileOperations`）用 `readFile(path, "utf-8")`，`\uFEFF` 会留在内容里 → 可检测、可补回 → **BOM 往返保留成立**。
   - WSL（`WslFileOperations`）用 `new TextDecoder().decode(...)`，默认 `ignoreBOM: false` 即**已把 BOM 剥离**；`writeText` 用 `TextEncoder` 不写 BOM。因此 `hasBom` 恒为 `false`，写回不会补回 → **WSL 下编辑带 BOM 文件会丢 BOM**。
   - 该 WSL 行为是**既有缺陷**：当前 `edit.ts` 同样经 `readText`/`writeText` 读写，WSL 今天就已丢 BOM。本阶段不使其变差，也不修复它（修复需改 `WslFileOperations` 的全局读写，超出范围）。
   - 因此：本阶段的 BOM 往返保证**仅对 Host 生效**；WSL 沿用现状，并在测试中明确区分。

9. **安全校验优先于无改动校验**。`oldString === newString` 仍须发生在任何替换之前，但放在路径解析、managed persistence、系统目录和 sandbox 校验之后，避免改变受保护路径的既有错误优先级。该检查不需要读取文件。

10. **不做严格模式开关**。靠吞大段护栏 + 多命中报错兜底即可，不引入额外配置（YAGNI）。

## 接口

### 新模块 `packages/tools/src/file/edit-replacers.ts`

```ts
export type Replacer = (content: string, find: string) => Generator<string, void, unknown>;

export function replace(
  content: string,
  oldString: string,
  newString: string,
  replaceAll?: boolean,
  replacers?: Replacer[],
): string;

export const REPLACERS: Replacer[];

export function isDisproportionateMatch(search: string, oldString: string): boolean;
export function normalizeLineEndings(text: string): string;
export function detectLineEnding(text: string): "\n" | "\r\n";
export function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string;

export const SimpleReplacer: Replacer;
export const LineTrimmedReplacer: Replacer;
export const BlockAnchorReplacer: Replacer;
export const WhitespaceNormalizedReplacer: Replacer;
export const IndentationFlexibleReplacer: Replacer;
export const EscapeNormalizedReplacer: Replacer;
export const TrimmedBoundaryReplacer: Replacer;
export const ContextAwareReplacer: Replacer;
export const MultiOccurrenceReplacer: Replacer;
```

`replace` 用**单一可判别错误类型**表达失败，避免靠 message 字符串判断：

```ts
export type EditMatchErrorKind =
  | "identical"        // oldString === newString
  | "not_found"        // 全链都没有产出任何候选
  | "ambiguous"        // 当前策略解析出多个位置或 replaceAll 位置互相重叠
  | "disproportionate"; // 候选片段远大于 oldString

export class EditMatchError extends Error {
  constructor(kind: EditMatchErrorKind);
  readonly kind: EditMatchErrorKind;
}
```

四类的映射（`edit.ts` 按 `error.kind` 分派）：

| kind | `edit.ts` 返回的文案 | 新旧 |
|---|---|---|
| `identical` | `"No changes to apply: oldString and newString are identical."` | 新增 |
| `not_found` | `"old_string not found in file."` | **沿用既有** |
| `ambiguous` | `"Found multiple matches for oldString. Provide more surrounding context to make the match unique."` | 新增 |
| `disproportionate` | `"Refusing replacement because the matched span is much larger than oldString. Re-read the file and provide the full exact oldString for the intended replacement."` | 新增 |

**精确路径的多命中不走这里**：`edit.ts` 第 5 步在调用 `replace` 之前就用既有带行号文案处理了精确多命中，因此 `ambiguous` 只可能来自模糊策略，两者互不影响。

### `edit.ts` 保持不变的对外契约

- 入参：`file_path`、`old_string`、`new_string`、`replace_all`。
- **既有**错误/成功文案逐字不变（空 `old_string`、精确多命中带行号、未找到、成功、sandbox、系统目录、managed persistence）。
- 本阶段新增三条错误文案：`identical`、`ambiguous`、`disproportionate`（见上表）。
- 沙箱校验、系统目录校验、managed persistence 校验顺序不变。
- `findMatchLines` 仍留在 `edit.ts`，用于精确匹配的歧义报错。

## 运行流程

### `replace()` 算法

1. 若 `oldString === newString` → 抛 `EditMatchError("identical")`。
2. 按顺序遍历兜底链；对每个 replacer：
   1. 收集并去重它产出的**非空**候选片段；空候选直接丢弃。
   2. 在原内容中展开每个候选的全部匹配位置（包括同一候选自身重叠的位置），按 `[start, end)` 去重；没有位置则继续下一策略。
   3. `replaceAll !== true`：
      - 多于一个位置 → 立即抛 `EditMatchError("ambiguous")`，不得继续让更宽松的策略静默挑选位置；
      - 恰好一个位置 → 对其候选做 `isDisproportionateMatch`，超限则抛 `disproportionate`，否则按该区间替换。
   4. `replaceAll === true`：
      - 所有候选先过 `isDisproportionateMatch`；任一超限即抛 `disproportionate`；
      - 若不同位置发生部分重叠，抛 `ambiguous`，避免重复消费原文；
      - 按位置从后向前替换全部区间，保证位置基于原内容且 `newString` 不会被后续步骤再次匹配。
3. 全链结束仍无位置 → 抛 `EditMatchError("not_found")`。

> **吞大段护栏在 `replaceAll` 与否两种分支下都生效**。非 `replaceAll` 先确认位置唯一，再检查唯一候选；`replaceAll` 检查该策略的全部候选。

`edit.ts` 的调用顺序：

1. 空 `old_string` 校验 → 既有文案。
2. 路径解析、managed persistence、系统目录、sandbox 读/写校验 → 全部不变。
3. **`oldString === newString` 校验 → `identical` 文案**。它位于安全校验之后、任何读取或替换之前。
4. `content = operations.readText(filePath)`；探测并剥离 BOM，得到 `body`，记录 `hasBom`；`oldString`/`newString` 各剥一次前导 BOM。若剥离后的 `desiredOld` 为空，返回既有空 `old_string` 文案。
5. **精确路径优先，以保留歧义语义**：若 `body.includes(desiredOld)`：
   - 统计出现次数；
   - 次数 > 1 且未开 `replaceAll` → 返回既有带行号文案（`findMatchLines`）；
   - 否则替换（`replaceAll` 全替换，否则替换首个）→ 进入第 7 步。
6. 精确未命中 → **保持 `body` 原行尾不动**，仅把 `oldString`/`newString` 归一后传入 `replace(body, ...)`，按 `EditMatchError.kind` 分派：
   - `not_found` → 既有文案 `"old_string not found in file."`；
   - `ambiguous` → 上表 `ambiguous` 文案；
   - `disproportionate` → 上表 `disproportionate` 文案；
   - `identical` → 上表 `identical` 文案；
   - 成功 → 进入第 7 步。
7. 写回：`(hasBom ? "\uFEFF" : "") + updated`，`operations.writeText`。
8. 返回既有成功文案。

> 说明：第 5 步刻意在 `edit.ts` 内先做一次精确判定，是为了让"多命中报行号"这条既有行为与文案完全不受兜底链影响。第 6 步的 `replace()` 内部同样以精确匹配开头，因此非歧义场景不会多走一次模糊策略。
>
> `identical` 校验**必须在第 5 步之前**，但不应抢在路径与 sandbox 校验之前：第 5 步是内联精确替换，若 `old_string === new_string` 且该串在文件中存在，第 5 步会直接替换并返回成功文案。`replace()` 内部的同名检查保留作纵深防御（供直接调用 `replace()` 的单测使用）。
>
> **有意行为**：若文件是 CRLF、`old_string` 是 LF，且**归一后**该串在文件中出现多处，则第 5 步的精确判定（用原始 `old_string`）不命中，进入第 6 步；`replace()` 的 SimpleReplacer 将该候选展开为多个位置，最终返回 `ambiguous` 文案而非既有带行号文案。这是有意取舍：该场景下"有歧义"的结论正确，且归一后无法稳定复现原始行号。

## 组件与职责

| 单元 | 职责 | 位置 |
|---|---|---|
| `edit-replacers.ts` | 9 级匹配策略、`EditMatchError`（含 `kind`）、吞大段护栏、行尾三函数 | 新建 |
| `edit.ts` | 路径/沙箱校验、BOM 处理、精确歧义判定、按 `kind` 映射错误、写回 | 改薄 |
| `edit-replacers.test.ts` | 每个 replacer 单测 + 护栏 + 行尾函数 + `EditMatchError.kind` | 新建 |
| `edit.test.ts` | 端到端行为（含 CRLF / BOM / 空候选 / 校验顺序 / 歧义回归） | 追加 |

## 不在范围内

- `apply_patch` 工具（V4A 格式）的引入。
- 按模型/供应商切换编辑工具集。
- 编辑后的 LSP 诊断回传、格式化器调用。
- "必须先 Read 才能 Edit" 的强制约束。
- `write.ts` 的任何改动。
- 严格模式开关。
- `operations.readText` / `writeText` 的全局行为改动。
- **WSL 的 BOM 往返保留**（需改 `WslFileOperations` 的全局读写，既有缺陷，本阶段不修）。

## 错误处理

| 场景 | 表现 |
|---|---|
| 空 `old_string` | 既有文案 `"old_string must not be empty."` |
| 精确命中多处且未开 `replace_all` | 既有带行号文案（不变） |
| 全链未命中 | 既有文案 `"old_string not found in file."` |
| 模糊策略仅产出非唯一候选 | 模糊路径专用歧义文案（新增） |
| 模糊匹配片段远大于 `old_string` | 拒绝替换并报错，提示重新读取文件后给出完整精确的 `old_string` |
| `oldString === newString` | 报错，不做任何写入（相对现状为新增校验）；校验发生在第 5 步内联替换之前，因此无论该串是否存在于文件都会报错 |
| 文件是 CRLF、`old_string` 是 LF | 归一后正常匹配，写回仍是 CRLF |
| 文件有 BOM、编辑首行（Host） | 剥离后正常匹配，写回保留 BOM |
| 文件有 BOM（WSL） | 读入时 BOM 已被 `TextDecoder` 剥离，编辑正常匹配；写回不补回（既有行为，本阶段不修） |
| 沙箱拒绝读/写 | 既有 sandbox 错误文案（不变） |

## 测试

### `packages/tools/src/file/__test__/edit-replacers.test.ts`（纯函数）

- 9 个 replacer 各至少一条：命中与不命中。
- 空候选：纯空白查找不得让任何模糊策略产出可替换的空串；`replaceAll` 不得向字符边界插入内容。
- `isDisproportionateMatch`：正向（远超阈值）与反向（正常长度）。
- `normalizeLineEndings` / `detectLineEnding` / `convertToLineEnding`：LF 与 CRLF 两态、混合内容取 CRLF。
- `replace()`：唯一位置才应用；非 `replaceAll` 遇到多个位置立即报歧义；`replaceAll` 全量替换不重叠位置。
- `replace()` 错误类型：`not_found` / `ambiguous` / `identical` 各一条，断言 `EditMatchError.kind`。
- **`replace()` 的吞大段护栏**：注入一个合成 replacer（产出远超 `oldString` 的候选），分别断言 `replaceAll` 为 `false` 与 `true` 时都抛 `disproportionate`（护栏在两个分支都生效）。
- 多个不同的模糊候选：非 `replaceAll` 抛 `ambiguous`；`replaceAll` 替换全部不重叠位置；重叠位置抛 `ambiguous`。
- 同一候选自身重叠：例如 `"aaa"` 中的 `"aa"` 必须展开成两个位置，非 `replaceAll` 与 `replaceAll` 都抛 `ambiguous`。
- 同一行多个空白变体：包括互相重叠的变体都要产出；非 `replaceAll` 多位置报歧义，`replaceAll` 只替换全部不重叠位置，存在重叠则报歧义。
- 重复锚点：验证候选结果正确，并用宽松上限防止固定大小的上下文策略退化为全文件成对扫描。

### `packages/tools/src/file/__test__/edit.test.ts`（端到端，追加）

保留现有 2 条（歧义报行号、sandbox 拒绝），并让端到端测试覆盖以下行为；其中第 6 项已由现有歧义行号用例覆盖，其余为新增用例：

1. 缩进不符可恢复（`old_string` 少一层缩进仍成功）。
2. 空白数量不符可恢复。
3. **CRLF 文件 + LF `old_string`** 可恢复，且写回后文件仍是 CRLF。
4. **BOM 文件编辑首行**（Host 环境）可恢复，且写回后 BOM 仍存在。
5. 转义还原（`old_string` 里是字面 `\n`）可恢复。
6. 多命中仍报带行号文案（回归，文案逐字一致）。
7. `replace_all` 全量替换。
8. 无命中报错文案不变。
9. 模糊路径仅产出非唯一候选时报歧义文案，且文件未被修改。
10. `old_string === new_string` 时报错且不做任何读取或写入；用例使用文件中确实存在的串，并断言内容不变。
11. CRLF 文件 + LF `old_string`，且归一后多处命中时报 `ambiguous` 文案（锁定上面声明的有意行为）。
12. 纯空白 `old_string` 未精确命中时，即使开启 `replace_all` 也不修改文件。
13. `old_string` 只有 BOM、剥离后为空时返回既有空字符串文案，且文件不变。
14. 受 sandbox 拒绝的路径即使 `old_string === new_string`，仍优先返回 sandbox 错误。

> 吞大段护栏不单列端到端用例：正常输入下真实 replacer 链无法触发它（见设计决策 5），其接线由 `replace()` 的注入式单测覆盖。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 模糊匹配改错位置 | 每个策略必须产出全部候选位置；非 `replaceAll` 遇到多个位置立即报歧义；两种分支都过吞大段护栏；精确路径优先级最高 |
| 锚点策略（Levenshtein）误配到相似代码块 | 相似度阈值 0.65；多个合格块不会静默选最高分，而是交由组合层报歧义或按显式 `replaceAll` 全部替换 |
| 常见 `{` / `}` / 空行锚点导致大文件卡顿 | `BlockAnchorReplacer` 只扫描目标大小 ±25% 的结尾；`ContextAwareReplacer` 只检查固定结尾，不创建无效区间副本 |
| 空候选导致 `replaceAll("", ...)` 扩张文件 | BOM 剥离后重新校验查找串；组合层丢弃所有空候选；纯空白与仅 BOM 输入有回归测试 |
| 行尾归一后写回改变了文件行尾 | 归一只作用于 `oldString`/`newString`；未触及的原内容字节不变，新插入文本使用 `detectLineEnding` 选出的文件行尾（混合文件按既定规则选 CRLF） |
| BOM 处理破坏二进制或非 UTF-8 文件 | 仅在文本层检测前导 `\uFEFF`；非文本路径不走此逻辑（`edit.ts` 本就是文本工具） |
| WSL 下 BOM 被 `TextDecoder` 剥离导致往返丢失 | 已在设计决策 8 与「不在范围内」显式声明：本阶段只对 Host 承诺，WSL 沿用既有行为，测试按环境区分 |
| 既有测试文案被改动 | 精确路径与错误文案逐字保留；`edit.test.ts` 现有断言作为回归护栏 |

## 待确认

无。四项取舍已由用户确认：全量 9 级兜底链、包含行尾归一、包含 BOM 处理、不做严格模式开关。BOM 的环境差异（Host 承诺往返、WSL 沿用现状）为审查后补充的明确化说明。
