# Read 工具的输出感知与安全边界设计

> 状态：待实现。

## 目标

让 `Read` 的输出对模型"自解释"并且不会炸上下文：

1. **知道读到哪了**——输出末尾明确告知总行数、本次读到哪、以及如何继续读。
2. **不会一次读爆**——加字节上限与单行上限。
3. **不把非图片二进制当文本**——支持的图片沿用 image block；其它二进制明确拒绝，而不是返回乱码。
4. **失败信息可行动**——路径不存在时给出相近文件名建议；`offset` 越界时给出总行数。

不改工具入参、不改行号前缀格式（`N: `），只在既有输出后追加尾部提示并新增几类明确的失败。

## 背景与现状

`packages/tools/src/file/read.ts` 当前行为：

- 入参 `file_path`（绝对或相对）、`offset`（1-indexed）、`limit`（默认 2000）。
- 目录：列出条目，目录名带尾斜杠，目录优先排序。
- 文件：`operations.readBytes` → 按内容签名识别 PNG/JPEG/GIF/WebP → 图片返回 image block；非图片用 `TextDecoder(..., { fatal: true })` 严格解码 → `split("\n")` → 切片 → 每行加 `N: ` 前缀。
- 失败：统一 `Error reading file: ${error}`。

四个具体缺陷：

1. **不告诉模型"还有多少"**。读 8000 行文件只给前 2000 行，末尾什么都没有。模型不知道后面还有内容，也不知道用 `offset` 继续。这是最实际的问题。
2. **没有字节上限**。只有行数上限（2000）。一行 500 KB 的压缩产物会整行进入上下文。
3. **没有单行上限**。超长行不截断。
4. **二进制检测不完整且错误不可行动**。图片已有专门返回路径，无效 UTF-8 与 NUL 也会拒绝；但其它可解码的控制字符二进制仍可能作为文本返回，而且错误统一包成 `Error reading file: Error: Unsupported binary file`。

另外两处小问题：

5. **`offset` 越界静默返回空**，模型无法区分"文件是空的"和"offset 写错了"。
6. **路径不存在只说失败**，不给相近名建议，模型只能再去 glob。

### 关键事实

- `FileOperations`（继承 `EnvironmentFileSystem`，`packages/environment/src/types.ts`）提供 `stat`（仅 `isFile`/`isDirectory`，**无 size**）、`listDir`、`readText`、`readBytes`、`writeText`、`writeBytes`、`glob`、`grep`。
- **有三处**测试精确断言了 `fileReadTool` 的文本输出，追加尾部提示会全部破坏，必须同步更新：
  - `packages/tools/src/file/__test__/read.test.ts:37` → `toBe("2: two")`
  - `packages/tools/src/file/__test__/operations.test.ts:17` → `toMatchObject({ text: "1: hello" })`
  - `packages/tools/src/file/__test__/environment-path.test.ts:63` → `toMatchObject({ text: "1: hello" })`

  已全仓 grep 确认没有其它文本格式精确断言点。`read.test.ts` 另有图片、错误图片、无效二进制、sandbox 与目录行为测试，必须保持或按本规格明确更新，不能在重写文件分支时删除。
- 该工具经 `packages/tools/src/registry.ts:92` 注册为内置工具，daemon / CLI / Desktop 共用。
- 本仓库工具的输出文案为英文（`Error reading file: ...`、`old_string not found in file.` 等），本设计沿用英文。

## 术语

- **尾部提示（trailer）**：附在编号行之后的说明块，用空行分隔。
- **字节上限（MAX_READ_BYTES）**：本次文本正文或目录条目正文允许的最大字节数，默认 50 KB。
- **单行上限（MAX_LINE_LENGTH）**：单行内容允许的最大字符数，默认 2000。
- **行数上限（limit）**：入参 `limit`，默认 2000。
- **二进制文件**：除已支持图片外，无法严格按 UTF-8 解码，或解码后仍不适合作为文本呈现的文件。

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

3. **字节上限默认 50 KB**，同时覆盖文件文本正文与目录条目正文，只统计正文及正文内部换行，不含尾部提示。理由：目录也可能包含大量长文件名；尾部提示是控制信息，不应挤占内容预算。

4. **单行上限默认 2000 字符**，适用于文件正文行和目录条目输出行；超出部分截断并追加 ` ... (line truncated to 2000 chars)`。先做单行截断，再做字节计数，确保虚拟/远端文件系统返回异常长的首个目录名称时也不会突破 50 KB。

5. **保留图片能力，并在严格解码后补充文本层二进制检测**，全程复用同一次 `readBytes`，不额外读盘：
   - 先沿用现有 `imageMediaType(bytes)` 与扩展名校验；识别出的 PNG/JPEG/GIF/WebP 继续返回既有 image block，WSL 继续通过 `toHostPath` 转成 provider 可访问路径；
   - 非图片使用 `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes)`；解码失败直接返回 `Cannot read binary file: {path}`；
   - 内容包含 `\u0000`（NUL）→ 判定二进制；
   - 或前 4096 个字符中控制字符（`charCode < 9`，或 `charCode > 13 && charCode < 32`）占比 > 0.3 → 判定二进制；
   - 命中则返回错误 `Cannot read binary file: {path}`，不返回任何内容。

   该公式已核验：`\t`(9)、`\n`(10)、VT(11)、FF(12)、`\r`(13) 均被排除；中文与 emoji 的码元远大于 32，不会被误判。实现时**不要**自行收窄这个区间（例如只排除 9/10/13）。

   这不会比现状更耗内存：当前实现本来就用 `readBytes` 读完整文件，再为文本创建解码字符串。

6. **`offset` 越界报错**：
   - 文件：当 `offset > total` 且不是"空文件 + offset 1"时，返回 `` `Offset ${offset} is out of range for this file (${total} lines)` ``；
   - 目录：当 `offset > total` 且不是"空目录 + offset 1"时，返回 `` `Offset ${offset} is out of range for this directory (${total} entries)` ``。

7. **文件不存在时给出相近名建议**：`stat` 抛错后，先对父目录执行同一套 sandbox read 校验；只有父目录也获准读取时，才尝试 `listDir(parent)` 并筛出最多 3 个"名称互相包含"（忽略大小写）的条目，返回：

   ```
   File not found: {path}

   Did you mean one of these?
   {suggestion1}
   {suggestion2}
   ```

   若父目录未获 sandbox 授权或无法列出，退回既有的 `Error reading file: ${error}`，不得泄露兄弟条目名称。**不依赖错误码分类**（Host 与 WSL 的抛错形态不同），但若父目录列出的条目中存在与目标完全同名的项，说明 `stat` 更可能因权限或环境故障失败，此时也必须返回原始错误，不能误报 `File not found`。建议按名称稳定排序后最多返回 3 条。

   父目录解析和建议路径拼接必须遵循 `filePath` 自身的命名空间：盘符路径或含反斜杠的路径用 `path.win32`，其余绝对 POSIX/WSL 路径用 `path.posix`。不能直接使用宿主平台默认的 `dirname`/`join`，否则 Windows 主进程会把 `/workspace/...` 建议拼成 `\workspace\...`。

8. **目录列表加尾部提示并受字节上限保护**：

   | 情形 | 尾部提示 |
   |---|---|
   | 空目录且 `offset === 1` | `(empty directory)`（**保持现状不变**） |
   | 字节截断 | `(Output capped at 50 KB. Showing entries {first}-{last} of {total}. Use offset={next} to continue.)` |
   | 行数截断 | `(Showing entries {first}-{last} of {total}. Use offset={next} to continue.)` |
   | 从 1 开始且全部读完 | `({total} entries)` |
   | 从中间开始且读到末尾 | `(Showing entries {first}-{last} of {total}. End of directory.)` |

   目录条目本身没有编号，因此所有分页形态必须显式写出 `first`/`last`；不能只写 `Showing {n} of {total}`，否则从非 1 offset 开始时无法判断本次展示的范围。

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

10. **更新工具 `description`**，说明：文本的行号前缀格式、文件和目录的 `offset` 续读、单行/字节截断标注、二进制会被拒绝，同时保留工具可以返回图片的既有事实。

11. **不做行尾归一**（CRLF 原样保留）。理由：Read 显示 `\r` 对模型不可见；模型复述出的 `old_string` 是 LF，由 `Edit` 的行尾归一（见 `2026-09-22-edit-fuzzy-matching-design.md`）负责匹配。两处职责分离。

12. **入参归一**：`offset` 与 `limit` 先归一为有限正整数再使用，避免负数、0、小数、`NaN` 或 `Infinity` 污染切片与尾部提示：
    - 非有限数回退到默认值；
    - 有限数执行 `Math.max(1, Math.trunc(value))`；
    - `offset` 默认 1，`limit` 默认 `DEFAULT_READ_LIMIT`。

    归一后的 `offset` 同时用于切片起点与尾部提示里的 `first`，保证两者一致。

## 接口

工具入参、返回结构不变：文本/目录/错误仍返回 `content: [{ type: "text", text }]`，支持的图片仍返回既有 image block。为便于直接单测，新增模块内导出常量：

```ts
export const DEFAULT_READ_LIMIT = 2000;
export const MAX_READ_BYTES = 50 * 1024;
export const MAX_READ_BYTES_LABEL = "50 KB";
export const MAX_LINE_LENGTH = 2000;
export const MAX_LINE_SUFFIX = ` ... (line truncated to ${MAX_LINE_LENGTH} chars)`;
export const BINARY_SAMPLE_CHARS = 4096;
export const BINARY_CONTROL_RATIO = 0.3;
export const MAX_SUGGESTIONS = 3;
```

## 运行流程

### 文件读取

1. 解析路径、sandbox 校验（不变）。
2. `operations.stat(filePath)`：
   - 抛错 → 进入「文件不存在/不可访问」分支（见决策 7）。
   - `isDirectory` → 目录分支（见下）。
3. `bytes = operations.readBytes(filePath)`；沿用现有图片签名、扩展名与 provider 路径处理，图片直接返回既有 image block。
4. 非图片严格 UTF-8 解码；失败或文本层二进制检测命中（决策 5）→ 返回 `Cannot read binary file: {path}`。
5. 计算行数组（决策 9 的精确规则）；`total = lines.length`。
6. 越界校验（决策 6）。
7. 从 `offset - 1` 开始逐行，直到 `已输出行数 === limit` 或行已耗尽：
   - 单行超过 `MAX_LINE_LENGTH` → 截断并加后缀；
   - 计算 `lineText = "{n}: {line}"` 与其字节数（含换行，首行不加）；
   - 若加上该行会超过 `MAX_READ_BYTES` → 标记 `byteCapped`，停止（不输出该行）；
   - 否则加入输出。
8. 拼接正文，按决策 1 的判定追加尾部提示：`byteCapped` → 字节提示；否则 `remaining > 0` → 行数提示；否则 → 结束提示。

### 目录读取

1. `operations.listDir` → 目录优先、名称排序（不变）。
2. 计算 `total = entries.length` 并做目录 offset 越界校验。
3. 从 `offset - 1` 开始加入条目（目录带 `/`），直到达到 `limit`、条目耗尽或下一项会让目录正文超过 `MAX_READ_BYTES`；字节数包含正文内部换行，不含 trailer。
4. 按实际输出数计算 `first`、`last`、`remaining` 与 `next`，按决策 8 追加尾部提示（空目录 + offset 1 保持 `(empty directory)`）。

### 文件不存在

1. `stat` 抛错。
2. 对父目录执行 sandbox read 校验：拒绝 → 返回原始 `Error reading file: ${error}`。
3. 校验通过后尝试 `listDir(parent)`：
   - 成功且存在完全同名条目 → 返回原始 `Error reading file: ${error}`；
   - 成功且无完全同名条目 → 过滤并稳定排序相近名（决策 7），有结果则返回建议，无结果则返回 `File not found: {path}`。
   - 失败 → 返回既有 `Error reading file: ${error}`。

## 组件与职责

| 单元 | 职责 | 位置 |
|---|---|---|
| `read.ts` | 路径/沙箱校验、既有图片返回、严格文本解码、二进制检测、文件/目录切片与上限、尾部提示、失败建议 | 现有文件，改写 `execute` |
| `read.test.ts` | 输出格式、图片回归、上限、二进制、文件/目录越界、建议、目录提示、非法入参、description | 现有文件，更新既有断言 + 追加 |
| `operations.test.ts` | 同步更新 `:17` 的输出断言 | 现有文件，仅改断言 |
| `environment-path.test.ts` | 同步更新 `:63` 的输出断言 | 现有文件，仅改断言 |

纯逻辑（二进制判定、行切片与字节计数、建议筛选、尾部提示拼接）以模块内小函数形式实现，便于单测。

## 不在范围内

- PDF 与其它二进制格式作为附件返回。现有 PNG/JPEG/GIF/WebP image block 能力必须保留，不属于新增范围。
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
| 目录 `offset` 越界 | `Offset {offset} is out of range for this directory ({total} entries)` |
| 空文件 + `offset` 1 | 正常返回，尾部提示 `(End of file - total 0 lines)` |
| 触发字节上限 | 正常返回已读部分 + 字节提示 |
| 触发单行上限 | 该行截断并加后缀，其余正常 |
| 识别到支持的图片 | 沿用既有 image block、媒体类型、host path 与 `sizeBytes` |
| 图片扩展名与实际内容不符 | 沿用既有 `Error reading file: Error: Invalid image file: ...` |
| sandbox 拒绝 | 既有 sandbox 错误文案（不变） |

## 测试

**必须同步更新的既有断言（三处，见「关键事实」）**：

| 文件 | 位置 | 现状 | 改为 |
|---|---|---|---|
| `read.test.ts` | `:37` | `toBe("2: two")` | 断言以 `2: two` 开头、并包含行数提示 `(Showing lines 2-2 of 3. Use offset=3 to continue.)`（该用例是 `offset=2, limit=1` 读 3 行文件，**第 3 行尚未读**，因此是行数提示而非结束提示） |
| `operations.test.ts` | `:17` | `toMatchObject({ text: "1: hello" })` | 改为断言文本以 `1: hello` 开头并包含结束提示 |
| `environment-path.test.ts` | `:63` | `toMatchObject({ text: "1: hello" })` | 同上 |

**`read.test.ts` 现有 7 条全部保留**：description、attachment URI、PNG image block、错误图片、无效二进制、目录与 sandbox 行为均不能删除。编号文本用例需追加 trailer 断言；无效二进制用例把旧的 `Unsupported binary file` 期望更新为新的 `Cannot read binary file`；其余既有断言保持。

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
13. 非法入参归一：`offset: -5` 与 `limit: 0` 不报错，按 `offset=1, limit=1` 处理；`NaN`/`Infinity` 回退默认值且 trailer 中不出现 `NaN`/`Infinity`（锁定决策 12）。
14. 路径不存在且同目录有相近名 → 返回 `Did you mean one of these?` 且列出该文件。
15. 路径不存在且无相近名 → 只返回 `File not found: {path}`。
16. 目录非空从 1 开始且未截断 → 尾部提示 `(2 entries)`；按 `limit` 截断 → 含明确的 `Showing entries 1-2 of 3`；从中间 offset 读到末尾 → 含范围与 `End of directory`；空目录 → 仍是 `(empty directory)`。
17. 目录字节上限：构造大量长文件名，正文不超过 50 KB，尾部提示含 `Output capped at 50 KB` 与正确的下一 `offset`。
18. 单个目录首项超过 50 KB → 先按 2000 字符截断，正文仍不超过 50 KB 且分页能前进。
19. 目录 offset 越界 → `Offset 5 is out of range for this directory (2 entries)`。
20. `description` 提及图片能力、`offset` 续读与 50 KB 上限（锁定决策 10）。
21. 现有 PNG image block、错误图片、WSL 图片 host-path 与 provider 不可访问错误不回归。
22. sandbox 拒绝与 attachment URI 两条既有行为不回归。
23. 相近名建议顺序稳定且最多 3 条；父目录存在完全同名条目时保留原始 stat 错误。
24. sandbox 只授权缺失目标、未授权父目录时，不列目录、不返回建议或兄弟文件名。
25. 路径命名空间：`/workspace/src/app.ts` 的父目录与建议保持 POSIX 斜杠；`D:\repo\src\app.ts` 保持 Windows 盘符与反斜杠。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 追加尾部提示改变所有 Read 的输出 | 正文格式（`N: `）不变，只加后缀；**已确认全仓库 3 处格式断言**（`read.test.ts:37`、`operations.test.ts:17`、`environment-path.test.ts:63`），全部列入同步更新 |
| 重写文本分支时破坏现有图片返回 | 继续从 `readBytes` 开始，图片签名、扩展名校验、image block 和 WSL host-path 分支原样保留；现有图片测试作为回归门 |
| 二进制误判把正常文本拒了 | 阈值保守（NUL 必判、控制字符占比 > 0.3）；公式已核验排除 `\t\n\v\f\r`；用 `\t`/中文/emoji 做反向用例 |
| 大二进制文件仍被整体读入内存 | 与现状一致，不构成回归；"只读样本"列为后续优化（见不在范围内） |
| 总行数因尾换行算错、空文件算成 1 行 | 决策 9 给出逐字规则（空串 → 0 行；只剥一个尾随 `\n`），并配测试 3 与测试 12 |
| `limit` 恰好读完却提示续读，诱导模型撞越界 | 决策 1 改为按 `remaining` 判定，并配测试 2 锁定 |
| `offset` 越界报错影响既有调用方 | 现状是静默空返回，属缺陷；报错更正确，且已配测试 11 |
| 建议逻辑依赖父目录可列出 | 父目录列不出时退回既有错误文案，不引入新失败模式 |
| 缺失路径建议绕过 sandbox 泄露兄弟文件名 | `stat` 失败后单独校验父目录 read 权限；未授权时不调用 `listDir`，只返回原始错误 |
| Windows 主进程错误拼接 WSL 建议路径 | 根据 `filePath` 形态显式选择 `path.posix` / `path.win32`，并配双命名空间测试 |
| 目录条目过多导致输出超过上下文预算 | 目录正文与文件正文共用 50 KB 上限，并提供字节截断 trailer 与下一 offset |
| `NaN`/`Infinity` 污染切片和提示 | 统一有限正整数归一函数；非有限值回退默认值并配直接调用测试 |

## 待确认

无。范围（尾部提示 + 文件/目录字节上限 + 单行上限 + 二进制检测 + 越界报错 + 路径建议 + 目录提示）已确定；现有图片 image block 明确保留，PDF/其它二进制附件、LSP、instruction 注入明确排除。审查后补充：图片与严格解码现状、3 处文本断言、结束提示边界、空文件特例、控制字符区间、目录字节上限与越界、非有限入参归一、缺失路径误报保护。
