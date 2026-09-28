# Write 安全化与 ApplyPatch 设计

> 状态：待实现。

## 目标

把文件修改工具拆成三个职责明确的入口：

- `Write`：创建新文件；只有显式声明时才整体覆盖已有文件。
- `Edit`：继续负责单文件、小范围文本替换。
- `ApplyPatch`：负责一个或多个文件的多段修改、新建和删除。

本阶段重点解决四个问题：整文件误覆盖、基于旧内容写回、写入中断留下半文件，以及模型为了多段修改反复传输完整文件。方案优先复用成熟三方库，只实现项目特有的权限、路径和文件系统适配；不构建通用版本控制或三方合并系统。

## 背景与现状

`packages/tools/src/file/write.ts` 当前流程为：

```text
解析路径 → managed/system/sandbox 校验 → writeText → 返回成功
```

它有以下缺口：

1. 已存在文件会被无条件覆盖，调用方不需要表达覆盖意图。
2. 无法判断内容是否在模型读取后被用户或另一个 agent 修改。
3. `writeText` 直接写目标文件，失败时结果只能标成 `unknown_outcome`。
4. 内容相同仍会写盘，改变 mtime 并制造无意义变更。
5. 多段或多文件修改只能反复调用 `Edit`，或退化为整文件 `Write`。
6. 成功反馈只有路径，没有 create/overwrite/no-op、字节数或内容版本。

现有 `Edit` 已具备精确优先、模糊兜底、歧义拒绝、BOM 与行尾处理，继续保留，不把 patch 逻辑塞进 `Edit`。

## 调研结论

- Codex CLI 以结构化 `apply_patch` 为主要修改入口，应用前解析并验证所有文件和 hunk，再受 sandbox 控制写入。
- Gemini CLI 将 `write_file` 用于新建或整文件覆盖，将 `replace` 用于定点修改，并在批准界面展示 unified diff。
- Cursor 将修改立即落盘，但用完整 diff review、逐文件接受/拒绝和 checkpoint 提供恢复能力。
- Claude Code 区分 Write/Edit，并将权限规则、路径判断和修改 diff 作为统一文件修改边界持续加固。

对 OpenHarness 最合适的组合是：保留小而明确的 `Write` 和 `Edit`，新增以标准 unified diff 为输入的 `ApplyPatch`。不复制 Codex 的私有实现，也不自研 diff 算法。

主要参考：

- [OpenAI Codex `apply_patch` handler](https://github.com/openai/codex/blob/main/codex-rs/core/src/tools/handlers/apply_patch.rs)
- [Gemini CLI file-system tools](https://github.com/google-gemini/gemini-cli/blob/main/docs/tools/file-system.md)
- [Gemini CLI file management](https://github.com/google-gemini/gemini-cli/blob/main/docs/cli/tutorials/file-management.md)
- [Cursor Agent tools](https://docs.cursor.com/en/agent/tools)
- [Cursor diffs and review](https://docs.cursor.com/en/agent/review)
- [Claude Code releases](https://github.com/anthropics/claude-code/releases)

## 设计原则

1. **优先三方库**：统一 diff 的生成、解析和 hunk 应用使用仓库已有的 `diff@7`（jsdiff）；不得自行实现通用 unified diff parser 或 hunk matcher。
2. **不过度设计**：首版只支持 create/update/delete，不支持 rename、文件 mode、二进制 patch、三方合并、模糊 patch 或 Git 完整邮件格式。
3. **默认安全**：创建是默认行为；整体覆盖必须显式 `overwrite: true`。
4. **降低静默冲突**：已有文件整体覆盖时可用 `expected_sha256` 做乐观并发校验；`ApplyPatch` 的上下文和删除行必须精确匹配。普通文件系统没有可移植的“比较 hash 后原子替换”原语，因此不宣称这是严格 CAS。
5. **先验证、后写盘**：多文件 patch 必须先解析、读取、校验并计算全部新内容，任一失败时一个文件也不写。
6. **最小接口扩展**：不增加配置系统、事务管理器、备份目录或自动 merge。
7. **对外反馈结构化**：返回稳定的 execution state 和 compact summary；不把文件正文复制进结果。
8. **不存在不靠猜 message**：Host `ENOENT` 与 WSL 明确的不存在结果统一映射为 `FileNotFoundError`；权限和其它 I/O 错误保持原错误。WSL 目标的多级父目录可以尚不存在，只要最近已存在的祖先是可搜索目录，仍应识别为不存在并进入 exclusive create。Write/ApplyPatch 只捕获该类型来进入 create 分支。
9. **读取前校验读权限**：Write 对已有文件要读取字节来判断 no-op/hash，必须先通过 sandbox read 校验；只有新建文件可仅凭 write 权限执行。

## 工具选择规则

工具 description 和系统提示应明确告诉模型：

| 场景 | 工具 |
|---|---|
| 创建新文件 | `Write` |
| 已有文件的一处或少量文本修改 | `Edit` |
| 多段修改、多文件修改、新建与删除组合 | `ApplyPatch` |
| 明确需要用完整内容替换已有文件 | `Write(overwrite: true)` |

不得让 `Write` 自动猜测并转成 `Edit` 或 `ApplyPatch`。工具失败时应让模型重新读取或改用正确工具，而不是隐藏执行路径。

## 依赖决策

### 使用现有三方库

`packages/tools` 已直接依赖 `diff@7`，本功能复用：

- `parsePatch`：解析标准 unified diff；
- `applyPatch`：对内存中的旧内容严格应用单文件 patch；
- `createTwoFilesPatch`：生成 Write 覆盖前后的预览 diff，供现有 preview/授权层复用。

调用 `applyPatch` 时设置 `fuzzFactor: 0`：上下文和删除行内容必须完全匹配，但 jsdiff 仍可能在声明行号附近搜索并偏移到完全匹配的位置。这是有意接受的三方库语义；不额外自研“固定 oldStart 才能应用”的 matcher。路径和 sandbox 校验仍由 OpenHarness 自己负责，因为这是项目权限模型，三方库无法替代。

### 使用标准库

- `node:crypto` 的 `createHash("sha256")` 计算内容版本。
- Host 的临时文件、rename 和权限操作使用 `node:fs/promises`。

### 不新增原子写第三方库

`write-file-atomic` 一类库只处理宿主文件系统，不能覆盖 `ExecutionEnvironmentHandle.files` 的 WSL/远端实现。为它再维护第二套写入语义反而增加分叉。本阶段在上游 `EnvironmentFileSystem` 增加最小写入原语，并由 Host/WSL 实现；`FileOperations` 继承该契约，不另建一套接口。

## Write 接口

保留现有字段并新增两个可选字段：

```ts
{
  file_path: string;
  content: string;
  overwrite?: boolean;        // 默认 false
  expected_sha256?: string;   // 仅覆盖已有文件时使用
}
```

### 行为

1. 若提供 `expected_sha256`，先校验格式；非法格式立即返回 `invalid_input`，不解析路径或访问文件系统。
2. 目标不存在：若同时提供 `expected_sha256` 则拒绝（不存在可比较的旧版本）；否则用 exclusive create 创建，结果为 `created`。
3. 目标存在且为普通文件时，先校验 sandbox read 权限，再读取现有原始字节；若它与 `TextEncoder().encode(content)` 完全相同，返回成功 no-op，结果为 `unchanged`，不写盘。此时合法格式的 hash 值不再比较，因为没有写入冲突风险。
4. 内容不同时，如提供 `expected_sha256`，比较现有原始字节的 SHA-256；不一致则拒绝。
5. 目标存在、内容不同且 `overwrite !== true`：拒绝，提示使用 `Edit`、`ApplyPatch`，或明确传 `overwrite: true`。
6. `overwrite === true` 且未提供 hash：允许覆盖，但成功反馈标明这是未带版本保护的显式覆盖。
7. 通过检查后使用原子替换写入。

`expected_sha256` 必须是 64 位小写或大写十六进制字符串；其它格式返回 `invalid_input`。hash 对原始文件字节计算，而不是对经过 BOM/行尾转换的字符串计算。

本阶段不修改 `Read` 输出以附带 hash。`expected_sha256` 是提供给已经通过其它受信流程获得 hash 的高级调用方；模型的常规修改流程仍优先使用 `Edit`/`ApplyPatch`。不要为了让该可选字段更常用而扩张 Read 契约。

### 兼容性

这是有意的行为变更：旧调用对已有文件的无条件覆盖会被拒绝。创建新文件的调用保持兼容。调用方如确实需要整体替换，必须新增 `overwrite: true`。

## ApplyPatch 接口

```ts
{
  patch: string;
}
```

采用标准 unified diff，不引入另一套 Codex envelope。示例：

```diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -1,2 +1,2 @@
-const value = 1;
+const value = 2;
 export { value };
```

### 首版支持范围

- 更新文件：`--- a/path` 与 `+++ b/path`。
- 新建文件：旧路径为 `/dev/null`。
- 删除文件：新路径为 `/dev/null`。
- 一个 patch 中包含多个文件和每个文件多个 hunk。

### 明确不支持

- rename/copy 元数据；需要时表达为 delete + create。
- 文件权限 mode 变化。
- 二进制 patch。
- fuzz、上下文猜测和三方合并。
- Git 邮件正文语义。普通 `diff --git` 与 `index` 前导行允许交给 jsdiff 解析；明确拒绝 `GIT binary patch`、`Binary files`、`rename from/to`、`copy from/to`、`old mode/new mode`、`new file mode`、`deleted file mode` 等首版不支持的标记。
- 对同一路径在一个 patch 中声明多次。

### 路径规则

1. 去除标准的 `a/`、`b/` 前缀；`/dev/null` 只用于 create/delete。
2. patch 内路径必须是 workspace 相对路径；拒绝绝对路径、盘符、UNC、NUL、空路径以及 `.`/`..` 路径段，避免不同写法指向同一目标。
3. 每个最终路径都通过 `resolveToolPathInContext` 和现有 managed/system/sandbox 校验。
4. update/delete 同时需要 read 与 write 权限；create 需要 write 权限。
5. 同一路径不能既创建又删除，不能同时作为多个操作的目标。
6. update 要求规范化后的 old path 与 new path 完全相同；不同路径属于 rename，首版拒绝。
7. 每个文件必须至少包含一个 hunk。
8. patch 内路径只接受 POSIX `/` 分隔符，拒绝反斜杠；解析成目标路径后，路径身份按执行环境判断：Windows/盘符路径比较时折叠大小写并统一分隔符，POSIX/WSL 路径保持大小写敏感。重复路径检测使用该 identity，而不是原始 patch 字符串。

## ApplyPatch 运行流程

### 阶段一：纯内存预演

1. 用 `diff.parsePatch(patch)` 解析；解析异常或 0 个文件即返回 `invalid_input`。
2. 将每个文件映射为 `create | update | delete`，规范化并校验路径；update 的 old/new path 必须指向同一 identity。
3. 拒绝 0 hunk、重复路径 identity 和不支持的 patch 结构。
4. 完成所有 managed/system/sandbox 校验。
5. update/delete 读取现有普通文件文本，拒绝符号链接；create 要求目标不存在。
6. update 使用 `diff.applyPatch(oldContent, parsedFile, { fuzzFactor: 0 })`；返回 `false` 即拒绝。允许声明行号发生偏移，只要上下文与删除行完全匹配。
7. create 的旧内容视为 `""` 并严格应用 patch；delete 应得到空内容。create/update 的最终新内容也必须通过 Read 共用的 NUL/控制字符二进制判定，不得只校验旧内容。
8. 记录每个文件的旧内容、新内容、原始字节 hash 和操作类型。

预演失败时返回具体文件和原因，不执行任何写入。

### 阶段二：冲突复核

写盘前重新读取所有 update/delete 文件的原始字节并比较预演时 SHA-256。任何已观察到的变化即整体拒绝。该复核缩小竞争窗口，但从复核到最终 rename 之间仍可能发生变化；本阶段不引入平台锁或事务管理器来假装提供不可移植的严格 CAS。

对 create 不做“先检查、后普通覆盖写”。落盘必须使用 exclusive create：若目标在预演后被并发创建，该文件写入失败且不覆盖新文件。

### 阶段三：落盘

1. create 使用 `createTextExclusive`，update 使用 `writeTextAtomic`。
2. delete 使用现有环境文件系统新增的最小 `removeFile` 原语。
3. 按规范化路径排序执行，保证测试和反馈稳定。

首版承诺“验证阶段全有或全无”，但**不承诺跨多个文件的磁盘级事务回滚**。如果第 N 个写入因磁盘或环境故障失败，返回 `executionState: "unknown"`，列出已完成和未完成文件，提示检查工作区。为实现真正跨文件事务而引入备份、日志和回滚管理器超出本阶段范围。

## 原子文件操作

同步扩展 `packages/environment/src/types.ts` 的 `EnvironmentFileSystem`；`FileOperations` 继续继承它。所有生产实现必须提供：

```ts
createTextExclusive(path: string, content: string): Promise<void>;
writeTextAtomic(path: string, content: string): Promise<void>;
removeFile(path: string): Promise<void>;
```

这三个方法不是可选能力。所有构造完整 `EnvironmentFileSystem` 的实现和测试桩必须同步；使用 `as unknown as ExecutionEnvironmentHandle` 的局部测试 mock 只需补本用例实际走到的方法。不要在工具层静默回退到非原子 `writeText`。

### Host

`writeTextAtomic` 先确保父目录存在，再在目标同目录创建随机临时文件，写完后复制原文件 mode，再 rename 到目标；若无法复制 mode，写入失败并保留旧文件。任何失败都尝试清理已知临时文件。临时名使用固定短前缀加随机值，不得包含完整目标 basename，否则合法长文件名会让临时名单段超长。

`createTextExclusive` 同样先确保父目录存在，在同目录完整写入临时文件，再用不会覆盖已有目标的原子发布方式创建目标；若目标已存在则失败并清理临时文件。Host 可使用 hard link 后删除临时文件；WSL 可使用 `ln`。不得用先 `stat` 再普通 rename 的方式模拟 exclusive create。

### WSL

通过一次受参数保护的 shell 调用，先 `mkdir -p`，再在目标目录创建临时文件、从 stdin 写入，覆盖时用 `chmod --reference` 保留原 mode，再用 `mv -T -f` 将目标强制视为文件路径；若目标变成目录必须失败，不能把临时文件移入该目录。trap 清理临时文件。exclusive create 用 `ln` 发布。路径只能作为位置参数传入，不能插入 shell 脚本文本。WSL 的“不存在”分支向上查找最近已存在的祖先，仅当它是可搜索目录时映射为 `FileNotFoundError`；权限不明确时保留原错误。

`removeFile` 只删除单个已验证为文件的路径，不支持目录和递归删除。

## 行尾、BOM 与编码

- `Write` 按调用方给出的 UTF-8 字符串写入，不自动改变 BOM 或行尾。
- `ApplyPatch` 仅处理严格 UTF-8 文本；复用 `read.ts` 已有的 fatal UTF-8 decode 与 NUL/控制字符比例判定。为避免文件工具互相导入，可把这两个纯函数提取到一个小型 `text-content.ts`，由 Read 与 ApplyPatch 共用；不要复制判定公式。
- patch 参数在解析前也必须能无损编码为 UTF-8；拒绝孤立 UTF-16 surrogate，避免解析器静默替换为 `U+FFFD`。
- update 保留旧文件的主行尾风格：应用 patch 前在内存中按旧文件行尾适配 patch 内容，结果不得无故把整文件 CRLF 改成 LF。
- 原文件有 UTF-8 BOM 时 update 保留 BOM；create 只在 patch 新内容明确含 BOM 时写入。
- 是否保留最终换行由 patch 表达；不能统一强加或删除。

行尾/BOM 适配复用现有 `edit-replacers.ts` 的小函数；不新建第二套实现。

## 结果与错误

### Write 成功

```ts
{
  executionState: "completed";
  compactSummary: "Write created|overwrote|unchanged: {path} ({bytes} bytes, sha256 {shortHash})";
}
```

用户可见文本分别为：

- `Created {path} ({bytes} bytes).`
- `Overwrote {path} ({bytes} bytes).`
- `No write needed: {path} already has the requested content.`

### ApplyPatch 成功

```text
Applied patch to N files: C created, U updated, D deleted.
```

`compactSummary` 加入稳定排序后的文件路径和操作，但不包含文件正文，并且必须不超过 core `toolFeedbackFields` 接受的 1000 字符。路径过多时保留计数、前若干路径并追加 `... +N more`；用户可见正文可以列出完整路径，但仍不得包含文件内容。

### 主要错误

| 场景 | failureKind | executionState |
|---|---|---|
| Write 已存在但未显式 overwrite | `invalid_input` | `not_started` |
| expected_sha256 格式非法或不匹配 | `invalid_input` | `not_started` |
| patch 语法、路径或 hunk 不合法 | `invalid_input` | `not_started` |
| managed/system/sandbox 拒绝 | `policy` | `not_started` |
| 预演后文件发生变化 | `invalid_input` | `not_started` |
| 单文件原子写失败 | `unknown_outcome` | `unknown` |
| 多文件写入中途失败 | `unknown_outcome` | `unknown` |

冲突类错误的 recovery hint 应要求重新 `Read` 后重试；不得建议绕过 hash 或改用 shell 强写。

## 组件与职责

| 文件 | 职责 |
|---|---|
| `packages/tools/src/file/write.ts` | Write 新语义、hash/no-op/overwrite 校验、结果反馈 |
| `packages/tools/src/file/apply-patch.ts` | patch 编排：解析结果校验、权限、预演、冲突复核、落盘 |
| `packages/tools/src/file/patch-path.ts` | 极薄的 patch 路径规范化、命名空间 identity 与安全校验；不含 diff 算法 |
| `packages/tools/src/file/text-content.ts` | Read/ApplyPatch 共用的严格 UTF-8 解码与文本二进制判定（仅在抽取能消除复制时创建） |
| `packages/environment/src/types.ts` | 扩展所有执行环境共享的文件系统能力契约 |
| `packages/tools/src/file/operations.ts` | Host/WSL 的 `createTextExclusive`、`writeTextAtomic` 与 `removeFile` |
| `packages/tools/src/registry.ts`、`src/index.ts` | 注册与导出 `ApplyPatch` |
| 对应 `__test__` 文件 | 纯函数、工具端到端、Host/WSL 操作回归 |

如果实现时 `patch-path.ts` 只有少量代码且没有独立复用价值，可直接并入 `apply-patch.ts`；不要为了与表格一致制造文件。

## 测试要求

### Write

- 新文件创建成功。
- 新建时提供 `expected_sha256` 拒绝；并发创建目标时 exclusive create 失败且不覆盖对方内容。
- 已有文件默认拒绝且内容不变。
- `overwrite: true` 覆盖成功。
- 内容相同返回 unchanged，不调用写入；hash 格式仍须合法，但合法 hash 的值在 no-op 时不比较。
- 正确 hash 覆盖成功；错误 hash 与非法 hash 拒绝。
- 非法 hash 在路径解析前拒绝；已有文件 read 被 sandbox 拒绝时，不读取正文或返回 hash 摘要。
- managed/system/sandbox 既有行为不回归。
- Host 原子写成功，失败时目标旧内容保持完整且临时文件被清理。
- WSL 命令使用位置参数传路径，不发生 shell 注入。
- Host/WSL 创建不存在的父目录行为与现有 `writeText` 一致。
- Host 临时名不受目标 basename 长度影响；WSL 原子覆盖遇到目标变成目录时失败，不在目录内留下文件。

### ApplyPatch

- 单文件单 hunk、多 hunk、多文件成功。
- create/update/delete 成功。
- hunk 不匹配时所有文件不变。
- create/update 的新内容含 NUL 或控制字符比例超限时，在预演阶段拒绝。
- patch 参数含孤立 UTF-16 surrogate 时在解析前拒绝。
- 声明行号偏移但上下文唯一且完全匹配时成功；重复的完全相同上下文行为用测试锁定为 jsdiff 当前结果，不自研二次选择器。
- 重复路径、绝对路径、`..`、盘符、UNC、空路径、二进制文件拒绝。
- `.` 路径段、符号链接目标拒绝；非法路径返回 `invalid_input + not_started`。
- update old/new path 不同、0 hunk、Windows 大小写别名重复时拒绝。
- create 目标已存在、update/delete 目标不存在时拒绝。
- managed/system/sandbox 分别覆盖 create 与 update/delete。
- 预演后内容变化时整体拒绝。
- create 目标在预演后被并发创建时不覆盖新文件。
- CRLF、BOM、最终换行保持。
- 多文件第 N 次落盘失败时返回 unknown，并准确报告已完成文件；不宣称已回滚。

### 工具选择提示

- Write description 明确“创建优先、覆盖需显式声明”。
- Edit description 明确小范围修改。
- ApplyPatch description 明确多段和多文件修改。
- prompt/tool snapshot 测试若存在，随注册同步更新。
- compactSummary 在大量文件时仍不超过 1000 字符，并保留总数与省略计数。

## 分阶段交付

为降低风险，实现计划应拆成两个可独立合并的阶段：

1. **Write 安全化**：overwrite/no-op/hash/原子写；不依赖 ApplyPatch。
2. **ApplyPatch**：复用第一阶段原子写原语，加入 create/update/delete。

不要把 diff review UI、checkpoint 或自动回滚塞进这两个阶段。底层返回足够信息后，再单独设计 UI。

## 不在范围内

- append/chunk 写入模式。
- 自动把 Write 转成其它工具。
- fuzzy patch 或自动三方合并。
- rename/copy、mode、symlink、二进制 patch。
- 跨文件磁盘事务、备份目录和自动回滚。
- Git 暂存、commit 或 branch 操作。
- Cursor 风格 checkpoint 和 diff review UI。
- 针对不同模型暴露不同工具协议。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 默认拒绝覆盖破坏旧调用 | 明确记录为有意兼容性变更；创建行为不变；整体替换显式传 `overwrite: true` |
| patch parser 边界复杂 | 复用 `diff@7`；自有代码只做操作映射和路径安全校验 |
| 路径别名绕过重复检测 | 拒绝 `.` 与 `..` 路径段，分类错误按 `invalid_input + not_started` 返回 |
| Write 的 no-op/hash 读取越过 sandbox | 已有文件必须同时通过 read/write 校验；新建仅需 write |
| patch 修改错误位置 | fuzzFactor 固定为 0，内容不匹配即整体拒绝；接受 jsdiff 对完全匹配上下文的行号偏移语义，并用重复上下文测试记录边界 |
| TOCTOU 并发覆盖 | update/delete 写盘前复核 hash，明确属于 best-effort 乐观保护；create 使用 exclusive publish，绝不覆盖并发创建 |
| 多文件中途失败 | 不虚假承诺事务；返回 unknown 和逐文件进度，后续由调用方检查 |
| 原子写跨环境差异 | 收敛到 `FileOperations.writeTextAtomic`，Host/WSL 各自测试 |
| WSL 新建目标的多级父目录尚不存在 | 缺失判定查找最近已存在的可搜索祖先，之后由 exclusive create 建目录 |
| WSL `mv` 将文件放进并发出现的目录 | 使用 `mv -T -f`，拒绝把目录当目标文件 |
| 长目标名导致 Host 临时名超长 | 同目录固定短前缀 + UUID，不拼完整 basename |
| 大文件仍需整文件读入 | 与现有工具一致；流式 patch 和大文件专用协议暂不引入 |
| 三方库能力不足 | 先用最小真实样例验证 `diff@7` create/update/delete；只在缺口处写薄适配，不替换整库 |
| expected_sha256 对普通模型不可得 | 明确为可选高级能力；不修改 Read 契约，不把它作为常规编辑前置条件 |

## 验收标准

1. `Write` 不再无意覆盖已有不同内容。
2. hash 冲突、patch 冲突和权限拒绝均保证写入未开始。
3. 单文件写入使用原子替换，不留下半文件。
4. `ApplyPatch` 能安全完成 create/update/delete 和多文件预演。
5. 现有 `Read`、`Edit`、图片和环境文件系统行为不回归。
6. 实现只新增必要依赖；优先使用现有 `diff@7`，没有自研通用 diff 引擎。
7. 全部 tools 测试和类型检查通过。

## 待确认

无。已确认采用推荐方案：Write 默认拒绝覆盖，Edit 负责小改，新增 ApplyPatch；实现优先使用三方库且避免过度设计。
