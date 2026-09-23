# Read 工具的输出感知与安全边界设计

> 状态：待实现。

## 目标

让 `Read` 的输出对模型"自解释"并且不会炸上下文：

1. **知道读到哪了**——输出末尾明确告知总行数、本次读到哪、以及如何继续读。
2. **不会一次读爆**——加字节上限与单行上限。
3. **不把二进制当文本**——检测到二进制时明确拒绝，而不是返回乱码。
4. **失败信息可行动**——路径不存在时给出相近文件名建议；`offset` 越界时给出总行数。

不改工具入参、不改行号前缀格式（`N: `），只在既有输出后追加尾部提示并新增几类明确的失败。

## 背景与现状

`packages/tools/src/file/read.ts`（共 72 行）当前行为：

- 入参 `file_path`（绝对或相对）、`offset`（1-indexed）、`limit`（默认 2000）。
- 目录：列出条目，目录名带尾斜杠，目录优先排序。
- 文件：`operations.readText` → `split("\n")` → 切片 → 每行加 `N: ` 前缀。
- 失败：统一 `Error reading file: ${error}`。

四个具体缺陷：

1. **不告诉模型"还有多少"**。读 8000 行文件只给前 2000 行，末尾什么都没有。模型不知道后面还有内容，也不知道用 `offset` 继续。这是最实际的问题。
2. **没有字节上限**。只有行数上限（2000）。一行 500 KB 的压缩产物会整行进入上下文。
3. **没有单行上限**。超长行不截断。
4. **没有二进制检测**。读 `.exe`/`.png` 会把 UTF-8 解码结果当文本返回。

另外两处小问题：

5. **`offset` 越界静默返回空**，模型无法区分"文件是空的"和"offset 写错了"。
6. **路径不存在只说失败**，不给相近名建议，模型只能再去 glob。

### 关键事实

- `FileOperations`（继承 `EnvironmentFileSystem`，`packages/environment/src/types.ts`）提供 `stat`（仅 `isFile`/`isDirectory`，**无 size**）、`listDir`、`readText`、`readBytes`、`writeText`、`writeBytes`、`glob`、`grep`。
- **有三处**测试精确断言了 `fileReadTool` 的输出文本，追加尾部提示会全部破坏，必须同步更新：
  - `packages/tools/src/file/__test__/read.test.ts:37` → `toBe("2: two")`
  - `packages/tools/src/file/__test__/operations.test.ts:17` → `toMatchObject({ text: "1: hello" })`
  - `packages/tools/src/file/__test__/environment-path.test.ts:61` → `toMatchObject({ text: "1: hello" })`

  已全仓 grep 确认没有其它断言点。（`packages/*/node_modules/@openharness/tools/...` 下的同名文件是 pnpm 链接出的副本，不是独立源码。附件工具的 `attachment-read-tool.test.ts` 有自己独立的编号逻辑，不受影响。）
- 该工具经 `packages/tools/src/registry.ts:92` 注册为内置工具，daemon / CLI / Desktop 共用。
- 本仓库工具的输出文案为英文（`Error reading file: ...`、`old_string not found in file.` 等），本设计沿用英文。

## 术语

- **尾部提示（trailer）**：附在编号行之后的说明块，用空行分隔。
- **字节上限（MAX_BYTES）**：本次输出允许的最大字节数，默认 50 KB。
- **单行上限（MAX_LINE_LENGTH）**：单行内容允许的最大字符数，默认 2000。
- **行数上限（limit）**：入参 `limit`，默认 2000。
- **二进制文件**：按 UTF-8 解码后不适合作为文本呈现的文件。

## 设计决策

1. **尾部提示始终追加**（三种形态互斥），沿用 opencode 的措辞风格，让模型随时知道自己在文件中的位置：

   | 情形 | 尾部提示 |
   |---|---|
   | 触发字节上限 | `(Output capped at 50 KB. Showing lines {first}-{last}. Use offset={next} to continue.)` |
   | 触发行数上限 | `(Showing lines {first}-{last} of {total}. Use offset={next} to continue.)` |
   | 读到文件末尾 | `(End of file - total {total} lines)` |

   其中 `first = offset`，`last = offset + 已输出行数 - 1`，`next = last + 1`。

   **「行数上限」与「结束」的判定必须基于"是否还有剩余行"，而不是"是否撞到 limit"**：
   - 循环结束后计算 `remaining = total - (offset - 1) - 已输出行数`；
   - `byteCapped` 为真 → 字节提示（优先级最高）；
   - 否则 `remaining > 0` → 行数提示；
   - 否则 → 结束提示。

   这样当 `limit` 恰好等于剩余行数（例如 `offset=1, limit=3, total=3`）时给出的是**结束提示**，不会产生"已读完却提示 `offset=4` 续读"这种错误，也就不会让模型下一步撞上越界报错。

2. **行号前缀格式不变**（`N: `）。只追加尾部提示，不改变模型已经熟悉的正文形态，把行为变更面压到最小。

3. **字节上限默认 50 KB**，只统计**正文**（编号行及其换行），不含尾部提示。理由：尾部提示是控制信息，不应挤占内容预算。

4. **单行上限默认 2000 字符**，超出部分截断并追加 ` ... (line truncated to 2000 chars)`。先做单行截断，再做字节计数。

5. **二进制检测在文本层完成**，复用已读到的内容，不额外读盘：
   - 内容包含 `\u0000`（NUL）→ 判定二进制；
   - 或前 4096 个字符中控制字符（`charCode < 9`，或 `charCode > 13 && charCode < 32`）占比 > 0.3 → 判定二进制；
   - 命中则返回错误 `Cannot read binary file: {path}`，不返回任何内容。

   该公式已核验：`\t`(9)、`\n`(10)、VT(11)、FF(12)、`\r`(13) 均被排除；中文与 emoji 的码元远大于 32，不会被误判。实现时**不要**自行收窄这个区间（例如只排除 9/10/13）。

   这不会比现状更耗内存：当前实现本来就用 `readText` 读整个文件。

6. **`offset` 越界报错**：当 `offset > total` 且不是"空文件 + offset 1"时，返回 `` `Offset ${offset} is out of range for this file (${total} lines)` ``。

7. **文件不存在时给出相近名建议**：`stat` 抛错后，尝试 `listDir(dirname(path))`；若能列出，则在同名目录中筛出最多 3 个"名称互相包含"（忽略大小写）的条目，返回：

   ```
   File not found: {path}

   Did you mean one of these?
   {suggestion1}
   {suggestion2}
   ```

   若父目录也列不出来，退回既有的 `Error reading file: ${error}`。**不依赖错误码分类**（Host 与 WSL 的抛错形态不同），只用"父目录能否列出"来判断。

8. **目录列表加尾部提示**：

   | 情形 | 尾部提示 |
   |---|---|
   | 空目录（`total === 0`） | `(empty directory)`（**保持现状不变**） |
   | 截断 | `(Showing {n} of {total} entries. Use offset={offset + n} to read beyond entry {offset + n})` |
   | 未截断且非空 | `({total} entries)` |

9. **行数统计规则（含空文件）**，精确定义如下，实现必须逐字照此：

   ```
   lines = content === "" ? [] : (content.endsWith("\n") ? content.slice(0, -1) : content).split("\n")
   total = lines.length
   ```

   推论：
   - `""` → **0 行**（这是必须显式规定的特例；若照"先 strip 再 split"的自然写法会得到 `[""]` = 1 行，与错误处理表和测试 10 冲突）；
   - `"\n"` → **1 行**（非空，剥一个尾随 `\n` 得 `""`，`split` 得 `[""]`）；不要与"空串 0 行"混淆；
   - `"a\nb\n"` → 2 行；`"a\nb"` → 2 行；
   - `"a\r\n"` → 1 行（只剥一个尾随 `\n`，行内 `\r` 保留，符合决策 11 不做行尾归一）。

10. **更新工具 `description`**，说明：行号前缀格式、`offset` 续读、单行/字节截断标注、二进制会被拒绝。

11. **不做行尾归一**（CRLF 原样保留）。理由：Read 显示 `\r` 对模型不可见；模型复述出的 `old_string` 是 LF，由 `Edit` 的行尾归一（见 `2026-09-22-edit-fuzzy-matching-design.md`）负责匹配。两处职责分离。

12. **入参归一**：`offset` 与 `limit` 先归一为整数再使用，避免非法值污染切片与尾部提示：
    - `offset = Math.max(1, Math.trunc(input.offset ?? 1))`；
    - `limit = Math.max(1, Math.trunc(input.limit ?? DEFAULT_LIMIT))`。

    归一后的 `offset` 同时用于切片起点与尾部提示里的 `first`，保证两者一致。

## 接口

工具入参、返回结构不变（`content: [{ type: "text", text }]`）。新增模块内常量：

```ts
const DEFAULT_LIMIT = 2000;
const MAX_BYTES = 50 * 1024;
const MAX_BYTES_LABEL = "50 KB";
const MAX_LINE_LENGTH = 2000;
const MAX_LINE_SUFFIX = ` ... (line truncated to ${MAX_LINE_LENGTH} chars)`;
const BINARY_SAMPLE_CHARS = 4096;
const BINARY_CONTROL_RATIO = 0.3;
const MAX_SUGGESTIONS = 3;
```

## 运行流程

### 文件读取

1. 解析路径、sandbox 校验（不变）。
2. `operations.stat(filePath)`：
   - 抛错 → 进入「文件不存在/不可访问」分支（见决策 7）。
   - `isDirectory` → 目录分支（见下）。
3. `content = operations.readText(filePath)`。
4. 二进制检测（决策 5）→ 命中即返回 `Cannot read binary file: {path}`。
5. 计算行数组（决策 9 的精确规则）；`total = lines.length`。
6. 越界校验（决策 6）。
7. 从 `offset - 1` 开始逐行，直到 `已输出行数 === limit` 或行已耗尽：
   - 单行超过 `MAX_LINE_LENGTH` → 截断并加后缀；
   - 计算 `lineText = "{n}: {line}"` 与其字节数（含换行，首行不加）；
   - 若加上该行会超过 `MAX_BYTES` → 标记 `byteCapped`，停止（不输出该行）；
   - 否则加入输出。
8. 拼接正文，按决策 1 的判定追加尾部提示：`byteCapped` → 字节提示；否则 `remaining > 0` → 行数提示；否则 → 结束提示。

### 目录读取

1. `operations.listDir` → 目录优先、名称排序（不变）。
2. 按 `offset`/`limit` 切片，`total = entries.length`，`remaining = total - (offset - 1) - 已列出数`。
3. 输出条目（目录带 `/`），按决策 8 追加尾部提示（空目录保持 `(empty directory)`）。

### 文件不存在

1. `stat` 抛错。
2. 尝试 `listDir(dirname(filePath))`：
   - 成功 → 过滤相近名（决策 7），有结果则返回建议，无结果则返回 `File not found: {path}`。
   - 失败 → 返回既有 `Error reading file: ${error}`。

## 组件与职责

| 单元 | 职责 | 位置 |
|---|---|---|
| `read.ts` | 路径/沙箱校验、二进制检测、切片与上限、尾部提示、失败建议 | 现有文件，改写 `execute` |
| `read.test.ts` | 输出格式、上限、二进制、越界、建议、目录提示、非法入参、description | 现有文件，更新 1 条 + 追加 |
| `operations.test.ts` | 同步更新 `:17` 的输出断言 | 现有文件，仅改断言 |
| `environment-path.test.ts` | 同步更新 `:61` 的输出断言 | 现有文件，仅改断言 |

纯逻辑（二进制判定、行切片与字节计数、建议筛选、尾部提示拼接）以模块内小函数形式实现，便于单测。

## 不在范围内

- 图片 / PDF 作为附件返回（需要 MIME 嗅探与附件管线；且会改变工具返回结构，影响 daemon / CLI 调用方）。
- LSP 预热。
- AGENTS.md / instruction 注入（本仓库有独立的 memory / instruction 机制）。
- 工具内权限询问（本仓库由 permissions 层负责）。
- Read 侧行尾（CRLF）归一。
- `stat` 增加文件大小（大文件"只读样本再判定"的优化）。
- 修改 `operations.ts`、`write.ts`、`edit.ts`。

## 错误处理

| 场景 | 表现 |
|---|---|
| 路径不存在、父目录可列出、有相近名 | `File not found: {path}` + `Did you mean one of these?` + 最多 3 条 |
| 路径不存在、父目录可列出、无相近名 | `File not found: {path}` |
| 路径不存在、父目录不可列出 | 既有 `Error reading file: ${error}` |
| 二进制文件 | `Cannot read binary file: {path}`，不返回内容 |
| `offset` 越界 | `Offset {offset} is out of range for this file ({total} lines)` |
| 空文件 + `offset` 1 | 正常返回，尾部提示 `(End of file - total 0 lines)` |
| 触发字节上限 | 正常返回已读部分 + 字节提示 |
| 触发单行上限 | 该行截断并加后缀，其余正常 |
| sandbox 拒绝 | 既有 sandbox 错误文案（不变） |

## 测试

**必须同步更新的既有断言（三处，见「关键事实」）**：

| 文件 | 位置 | 现状 | 改为 |
|---|---|---|---|
| `read.test.ts` | `:37` | `toBe("2: two")` | 断言以 `2: two` 开头、并包含行数提示 `(Showing lines 2-2 of 3. Use offset=3 to continue.)`（该用例是 `offset=2, limit=1` 读 3 行文件，**第 3 行尚未读**，因此是行数提示而非结束提示） |
| `operations.test.ts` | `:17` | `toMatchObject({ text: "1: hello" })` | 改为断言文本以 `1: hello` 开头并包含结束提示 |
| `environment-path.test.ts` | `:61` | `toMatchObject({ text: "1: hello" })` | 同上 |

**`read.test.ts` 保留**：现有 5 条中，description 用例（改了 description 后仍不含 `attachment://`）、attachment URI 用例（走 `Error reading file`，`toContain` 仍成立）、sandbox 用例、目录用例（`toContain` 不受尾部提示影响）均无需改断言；仅 `:37` 需改。

**`read.test.ts` 追加**：

1. 读完整个文件（`offset=1` 且文件行数 < `limit`）→ 尾部提示 `(End of file - total 3 lines)`。
2. `limit` 恰好等于剩余行数（`offset=1, limit=3, total=3`）→ 结束提示，**不是**行数提示（锁定决策 1 的边界）。
3. 文件带尾换行（`"a\nb\n"`）→ 总行数为 2。
4. 行数截断 → `(Showing lines 1-1 of 3. Use offset=2 to continue.)`。
5. 字节上限截断 → 尾部提示含 `Output capped at 50 KB` 与正确的 `offset=`（构造 30 行、每行 **1990 个 ASCII 字符**的内容：单行低于 2000 不触发单行截断，累计字节在约第 25 行越过 50 KB；用 ASCII 避免多字节导致阈值漂移）。
6. 字节上限截断时尾部提示仍然出现 → 顺带证明尾部提示不计入字节预算（决策 3）。
7. 单行超 2000 字符 → 该行被截断且含 `(line truncated to 2000 chars)`。
8. 含 NUL 的文件 → `Cannot read binary file`，且不返回文件内容。
9. 控制字符占比超阈值的文件 → 同上。
10. 正常文本（含 `\t`、中文、emoji）**不**被误判为二进制。
11. `offset` 越界 → `Offset 5 is out of range for this file (3 lines)`。
12. 空文件 + `offset` 1 → 正常返回 + `(End of file - total 0 lines)`。
13. 非法入参归一：`offset: -5` 与 `limit: 0` 不报错，按 `offset=1, limit=1` 处理（锁定决策 12）。
14. 路径不存在且同目录有相近名 → 返回 `Did you mean one of these?` 且列出该文件。
15. 路径不存在且无相近名 → 只返回 `File not found: {path}`。
16. 目录非空未截断 → 尾部提示 `(2 entries)`；目录截断 → 含 `Showing ... of ... entries`；空目录 → 仍是 `(empty directory)`。
17. `description` 提及 `offset` 续读（锁定决策 10）。
18. sandbox 拒绝与 attachment URI 两条既有行为不回归。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 追加尾部提示改变所有 Read 的输出 | 正文格式（`N: `）不变，只加后缀；**已确认全仓库 3 处格式断言**（`read.test.ts:37`、`operations.test.ts:17`、`environment-path.test.ts:61`），全部列入同步更新 |
| 二进制误判把正常文本拒了 | 阈值保守（NUL 必判、控制字符占比 > 0.3）；公式已核验排除 `\t\n\v\f\r`；用 `\t`/中文/emoji 做反向用例 |
| 大二进制文件仍被整体读入内存 | 与现状一致，不构成回归；"只读样本"列为后续优化（见不在范围内） |
| 总行数因尾换行算错、空文件算成 1 行 | 决策 9 给出逐字规则（空串 → 0 行；只剥一个尾随 `\n`），并配测试 3 与测试 12 |
| `limit` 恰好读完却提示续读，诱导模型撞越界 | 决策 1 改为按 `remaining` 判定，并配测试 2 锁定 |
| `offset` 越界报错影响既有调用方 | 现状是静默空返回，属缺陷；报错更正确，且已配测试 11 |
| 建议逻辑依赖父目录可列出 | 父目录列不出时退回既有错误文案，不引入新失败模式 |

## 待确认

无。范围（尾部提示 + 字节/单行上限 + 二进制检测 + 越界报错 + 路径建议 + 目录提示）已按用户"Read 也写文档"的指示确定；图片/PDF、LSP、instruction 注入明确排除。审查后补充：3 处既有断言的完整清单、行数上限与结束提示的边界判定、空文件行数特例、控制字符区间说明、空目录行为保持、非法入参归一。
