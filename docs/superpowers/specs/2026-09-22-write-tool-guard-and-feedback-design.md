# Write 工具的读后写保护与写入反馈设计

> 状态：待实现。

## 目标

1. **防止盲覆盖**：覆盖一个**已存在**的文件前，模型必须在本次会话里先读过它；否则 `Write` 拒绝执行并给出可行动的提示。
2. **保留 BOM**：覆盖带 BOM 的文件时不丢 BOM，也不写进两个 BOM。
3. **写入反馈**：明确区分「新建」与「覆盖」，并回报写入的行数与字节数，让模型知道实际发生了什么。
4. **描述对齐**：`description` 说明 `Write` 是整文件覆盖、覆盖已存在文件前必须先 `Read`。

不改 `Write` 的入参、不改变它「整文件覆盖」的语义。

## 背景与现状

`packages/tools/src/file/write.ts`（约 70 行）：

- 入参 `file_path`、`content`。
- 校验：`resolveToolPathInContext` → managed-persistence → 系统目录 → sandbox 写权限。
- 执行：`fileOperationsFor(context).writeText(filePath, content)`。
- 返回：`Successfully wrote to ${filePath}`。

四个缺口：

1. **没有任何"先读"约束**。模型可以对一个从未读过的文件直接整文件覆盖，把用户的内容清掉。
2. **不处理 BOM**。覆盖带 BOM 的文件会丢 BOM。
3. **不区分新建与覆盖**，也不回报规模。模型无从判断自己覆盖掉了多少内容。
4. **没有测试文件**（`__test__/` 下没有 `write.test.ts`；`Write` 只在 `operations.test.ts` 里被顺带覆盖）。

### 关键事实（已核实）

- `ToolContext`（`packages/core/src/types/tools.ts:45`）有 `sessionId`，**没有任何"读过哪些文件"的追踪**；全仓库也没有 read-tracking 机制。
- `ToolContext` 在 `packages/core/src/engine/query-engine.ts:932` 组装。
- **引擎是会话级生命周期**：daemon 的 `AgentPool` 每个 session 只调一次 loader（`packages/server/src/daemon/daemon-agent.ts:124-132`），因此运行期与 `QueryEngine` 实例随会话存活，跨轮次复用。**所以把读记录放在 `QueryEngine` 实例上即可覆盖整个会话，无需改 daemon。**
- `read.ts` 与 `write.ts` 都用 `resolveToolPathInContext`（`packages/tools/src/file/environment-path.ts:6`）解析出同一个绝对路径，天然可比。
- 已存在「覆盖前看 diff」的基础设施：`packages/tools/src/file/preview.ts` 的 `computeFileChange` 与 `diff.ts` 的 `computeToolDiff`（含 `MAX_DIFF_PAYLOAD_LINES` 截断），但从 `packages/tools/src/index.ts:20` 导出后**在仓库根 `apps/` 与其余 packages 的非 node_modules 源码里没有任何生产消费方**（只有测试）。即：**diff 预览已建好但未接线**，接线属于另一件事。
- `read.ts` 当前实现用 `readBytes` + `new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })`，因此 BOM 会**保留**在解码结果里（`ignoreBOM: true` 表示不剥离）。

## 术语

- **读记录（read registry）**：会话级的「已读文件路径集合」，用于判断某个已存在文件能否被覆盖。
- **已读**：本会话内至少一次成功的文件读取（文本或图片）记录过该路径。
- **BOM**：文件开头的 `\uFEFF`。

## 设计决策

1. **读记录放在 `QueryEngine` 实例上，通过 `ToolContext` 暴露给工具**。理由：引擎是会话级（见关键事实），这是唯一能跨轮次存活、又不必改 daemon 的位置。

2. **`ToolContext` 新增可选字段 `readFiles?: ReadFileRegistry`**，而不是直接暴露一个可变 `Set`。用接口封装，便于测试注入假实现，也避免工具误用集合操作。

   ```ts
   /** 会话级：本会话内已成功读取过的文件路径。 */
   export interface ReadFileRegistry {
     markRead(path: string): void;
     hasRead(path: string): boolean;
   }
   ```

3. **路径归一化由 registry 内部完成**，工具只传 `resolveToolPathInContext` 给出的路径。规则**按路径形状判定**，不按 `process.platform`：

   ```
   forward = path.replace(/\\/g, "/")
   windowsStyle = /^[a-zA-Z]:\//.test(forward) || forward.startsWith("//")   // 盘符或 UNC
   stripped = forward.replace(/\/+$/, "")
   return windowsStyle ? stripped.toLowerCase() : stripped
   ```

   理由：Windows 主机 + WSL 环境下，`resolveToolPathInContext` 返回的是 POSIX 形态（`/mnt/d/...`）。若按 `process.platform` 判定就会把 POSIX 路径整体小写，在大小写敏感的 Linux 语义下把 `/mnt/d/A.txt` 与 `/mnt/d/a.txt` 当成同一路径，造成**误放行**（守卫里比误拒绝更危险）。按路径形状判定与仓库既有约定一致（`git-changes-query.ts:26` 的 `normalizedRootPath`）。

   **已知边界**：POSIX 下以 `//` 开头的路径会被当成 UNC 处理（转小写）。`resolveToolPathInContext` 返回的是规范化绝对路径，这种路径极罕见，可接受，不在本阶段处理。

4. **记录是有界的**：默认最多 `4096` 条，超出按插入顺序淘汰最早的一条（FIFO），防止长会话无界增长。

5. **`Read` 在成功读取文件后记录**，包括文本与图片；**目录列举不记录**，读取失败（二进制、越界、sandbox 拒绝）不记录。

6. **`Write` 只在「目标已存在」时检查**。文件不存在（新建）永远放行，不需要先读。

7. **`context.readFiles` 缺失时一律放行**。这是向后兼容：单元测试、老宿主、以及尚未注入 registry 的调用路径都不受影响。强制只发生在 registry 存在且文件已存在且未读过时。

8. **`Write` 成功后不记录**（不把"刚写的文件"标成已读）。理由：与 opencode 的规则一致（"覆盖已存在文件前必须先用 Read 工具"），语义简单可预测——要覆盖就得先读。

9. **BOM 处理**（算法与语义都要照此实现）：

   - `content` 的前导 BOM **一律丢弃**（`body = content.startsWith("\uFEFF") ? content.slice(1) : content`）；
   - **仅当目标文件原本有 BOM 时**补回一个（`hasBom = exists && before.startsWith("\uFEFF")`；`final = (hasBom ? "\uFEFF" : "") + body`）。

   推论（测试必须按此断言）：
   - 新建文件 → **0 个 BOM**（即使 `content` 自带 BOM，也被丢弃）；
   - 覆盖无 BOM 的已存在文件 → **0 个 BOM**（即使 `content` 自带 BOM）；
   - 覆盖有 BOM 的已存在文件 → **恰好 1 个 BOM**（不论 `content` 是否自带）。

   **环境差异**（与 Edit 规格同源）：Host 的 `readText` 保留 BOM，可检测可补回；WSL 的 `readText` 经 `TextDecoder` 默认剥离 BOM，`hasBom` 恒为 false，因此 **WSL 下不保证保留 BOM**（既有行为，本阶段不修）。

10. **写入反馈**：输出改为区分新建与覆盖，并给出写入规模：

    - 新建：`Created {path} (${lines} lines, ${bytes} bytes)`
    - 覆盖：`Overwrote {path} (${lines} lines, ${bytes} bytes)`

    `lines` 用 `splitReadLines` 同款规则（空内容 0 行；只剥一个尾随 `\n`），`bytes` 用 `Buffer.byteLength(内容, "utf8")`。为复用同一套行数规则，从 `read.ts` 复用已导出的 `splitReadLines`。

11. **拒绝文案**（逐字）：

    ```
    Refusing to overwrite {path} because it has not been read in this session. Read the file first, then write.
    ```

12. **`description` 更新**：明确「整文件覆盖」「覆盖已存在文件前必须先用 Read 读过」「不新增 BOM」。

13. **不把 diff 预览接线进来**。`computeToolDiff` 已存在但未接线，接线需要权限层与 UI 改造，属独立任务（见「不在范围内」）。

## 接口

### `packages/core/src/types/tools.ts`

新增 `ReadFileRegistry`（见决策 2），并在 `ToolContext` 增加：

```ts
  /** 会话级已读文件记录；缺省时 Write 的读后写检查被跳过。 */
  readFiles?: ReadFileRegistry;
```

### `packages/core/src/engine/read-file-registry.ts`（新建）

```ts
export function createReadFileRegistry(options?: { maxEntries?: number }): ReadFileRegistry;
export function normalizeReadPath(path: string): string;
```

### `packages/core/src/engine/query-engine.ts`

- 实例字段：`private readonly readFiles = createReadFileRegistry();`
- 在 `:932` 的 `ToolContext` 字面量中加入 `readFiles: this.readFiles,`。

### `packages/tools/src/file/read.ts`

- 在**文本读取成功**的 `return` 之前、以及**图片读取成功**的 `return` 之前，各加一句 `context.readFiles?.markRead(filePath);`。

### `packages/tools/src/file/write.ts`

- 读入 `const registry = context.readFiles;`
- **用 `operations.stat` 判断目标是否存在**（不读内容）；存在时才 `readText` 取 `before` 用于 BOM 检测。
- 已存在且 `registry && !registry.hasRead(filePath)` → 返回拒绝文案（决策 11），不写盘。
- BOM 与反馈按决策 9/10 处理。

> 存在性判定与读取顺序的完整步骤见「运行流程 · `Write` 执行」。**不要**用 `readText` 探测存在性：那会把「存在但读不了」误判为不存在，从而绕过读后写检查。

## 运行流程

### `Write` 执行

1. 路径解析、managed-persistence、系统目录、sandbox 校验（**全部不变**）。
2. `operations = fileOperationsFor(context)`。
3. **探测目标是否存在用 `stat`**（`EnvironmentFileStat` 只给 `isFile`/`isDirectory`，够用且不读内容）：

   ```
   try { const s = await operations.stat(filePath); exists = s.isFile } catch { exists = false }
   ```

4. 若 `exists && registry && !registry.hasRead(filePath)` → 返回拒绝文案（决策 11，`{path}` 用解析后的绝对路径 `filePath`），**不写盘**。
5. 若 `exists`，再 `before = await operations.readText(filePath)` 仅用于检测 BOM（`catch` 时按无 BOM 处理）。
6. BOM：`hasBom = exists && before.startsWith("\uFEFF")`；`body = content.startsWith("\uFEFF") ? content.slice(1) : content`；`final = (hasBom ? "\uFEFF" : "") + body`。
7. `await operations.writeText(filePath, final)`。
8. 返回 `Created/Overwrote {filePath} ({lines} lines, {bytes} bytes)`（`bytes` 按 `body` 计，不含补回的 BOM）。

> **已知成本**：第 5 步为了检测 BOM 会整体读一遍已存在的目标文件。对超大文件的覆盖写来说这是额外开销。之所以这样：`FileOperations` 没有「只读前几字节」的接口，`stat` 也不返回文件大小，无法廉价界定。列为后续优化（见「不在范围内」）。

### `Read` 记录

1. 目录分支：不记录。
2. 图片分支：成功返回前 `markRead(filePath)`。
3. 文本分支：二进制拒绝、越界、sandbox 拒绝都不记录；正常返回前 `markRead(filePath)`。

## 组件与职责

| 单元 | 职责 | 位置 |
|---|---|---|
| `ReadFileRegistry` 类型 | 会话级读记录接口 | `packages/core/src/types/tools.ts`（修改） |
| `createReadFileRegistry` / `normalizeReadPath` | 归一化、有界记录 | `packages/core/src/engine/read-file-registry.ts`（新建） |
| `QueryEngine` | 构造 registry 并注入 `ToolContext` | `packages/core/src/engine/query-engine.ts`（修改） |
| `read.ts` | 成功读取后 `markRead` | `packages/tools/src/file/read.ts`（修改） |
| `write.ts` | 读后写检查、BOM、写入反馈、description | `packages/tools/src/file/write.ts`（修改） |
| 测试 | registry 单测、Read 记录、Write 拒绝/放行/BOM/反馈、QueryEngine 注入 | 四个测试文件（registry 新建、write 新建、query-engine 新建、read 追加） |

## 不在范围内

- **把 diff 预览接到权限审批**（`computeToolDiff` 已存在但未接线；需权限层 + UI 改造）。
- `Edit` 的读后写强制（本次只做 `Write`；`Edit` 已实现，另议）。
- 写入后的格式化器、LSP 诊断（用户已确认暂不做诊断）。
- `Write` 侧的行尾（CRLF）归一：模型给什么写什么，与 opencode 一致。
- WSL 的 BOM 往返保留（需改 `WslFileOperations` 的全局读写，既有缺陷）。
- **覆盖前只读前几字节判断 BOM**（需要给 `FileOperations` 增加分段读或让 `stat` 返回 size；本阶段接受整体读一遍的成本）。
- 大文件的分段写入（属工具形态问题）。
- 修改 `operations.ts`、`read.ts` 的既有输出格式、`edit.ts`。

## 错误处理

| 场景 | 表现 |
|---|---|
| 覆盖已存在文件但本会话未读过 | 拒绝，返回决策 11 文案，文件不变 |
| 覆盖已存在文件且已读过 | 正常写入，`Overwrote ...` |
| 新建文件（不存在） | 正常写入，`Created ...`，无需先读 |
| `context.readFiles` 缺失 | 跳过检查，正常写入（向后兼容） |
| 覆盖带 BOM 的文件（Host） | BOM 保留（恰好 1 个） |
| 覆盖无 BOM 的文件、或新建文件 | 结果 **0 个** BOM（`content` 自带的 BOM 也丢弃） |
| 覆盖带 BOM 的文件（WSL） | BOM 不保留（既有行为，不在本阶段修） |
| managed-persistence / 系统目录 / sandbox 拒绝 | 既有文案与顺序不变 |

## 测试

### `packages/core/src/engine/read-file-registry.test.ts`（新建）

1. `markRead` 后 `hasRead` 为真。
2. Windows 形态路径：`C:\A\B.txt` 与 `c:/a/b.txt` 视为同一路径（形状判定，无需传平台）。
3. POSIX 形态路径：`/A/B.txt` 与 `/a/b.txt` **不**视为同一路径（大小写保留）。
4. **WSL 语义**：`/mnt/d/A.txt` 与 `/mnt/d/a.txt` **不**视为同一路径（防止在 Windows 主机上误把 POSIX 路径小写化而误放行）。
5. 尾部斜杠与反斜杠等价（`C:\A\` ≡ `c:/a`）。
6. 未记录过的路径 `hasRead` 为假。
7. 超过 `maxEntries` 时最早记录被淘汰（用 `maxEntries: 2` 验证 FIFO）。

### `packages/tools/src/file/__test__/write.test.ts`（新建）

沿用 `operations.test.ts` 的 `mkdtemp`/`roots`/`afterEach` 风格。用一个假的 registry：

```ts
function fakeRegistry(initial: string[] = []) {
  const seen = new Set(initial);
  return { seen, registry: { markRead: (p: string) => seen.add(p), hasRead: (p: string) => seen.has(p) } };
}
```

1. 新建文件 → 返回 `Created {path} (1 lines, 5 bytes)`，磁盘内容正确。
2. 覆盖**已读**文件 → 返回 `Overwrote ...`，内容被替换。
3. 覆盖**未读**文件（registry 存在、未 mark）→ `isError` 为真、文案等于决策 11、**磁盘内容未变**。
4. `readFiles` 缺失（只传 `{ cwd }`）→ 覆盖未读文件仍然成功（向后兼容）。
5. 覆盖带 BOM 的文件（Host）→ 写回后以 `\uFEFF` 开头且**恰好一个** BOM。
6. 覆盖带 BOM 的文件、且 `content` 也自带 BOM → 仍是**恰好一个** BOM。
7. 覆盖**无 BOM** 的已存在文件、且 `content` 自带 BOM → 结果 **0 个** BOM。
8. 空内容写入 → `(0 lines, 0 bytes)`，文件为空。
9. **`Write` 成功后不标记已读**（决策 8，判别式要精确）：对一个**不存在**的文件 A 首次 `Write`（新建 → 放行）；紧接着对 A 再 `Write` 一次——此时 A 已存在，而 registry 从始至终没有 A（初始为空，且首次 `Write` **也不 mark**）→ 断言**被拒绝**（决策 11 文案）。若首次 `Write` 曾把 A 标记为已读，第二次就会被放行，因此这条能真正判别决策 8。**不要**用"先读后写、再写一次"来测——那样 A 本来就在 registry 里，测不到任何东西。
10. `description` 含「overwrite」「Read」等关键词（决策 12）。
11. managed-persistence / 系统目录 / sandbox 三条既有拒绝行为不回归。

### `packages/tools/src/file/__test__/read.test.ts`（追加）

1. 成功读取文件后 registry 中有该路径（传入 fake registry，断言 `hasRead` 为真）。
2. 目录列举后 registry 中**没有**该路径。
3. 二进制拒绝后 registry 中**没有**该路径。
4. 图片读取成功后 registry 中有该路径（决策 5）。

### `packages/core/src/engine/query-engine-read-files.test.ts`（新建，覆盖决策 1）

沿用 `packages/core/src/engine/goal-context.test.ts` 的 `new QueryEngine(...)` 构造方式，注册一个**捕获 `ToolContext` 的假工具**，跑一轮后断言：

1. 传给工具的 `context.readFiles` 已定义（非 undefined），且是 `ReadFileRegistry` 形状（`markRead`/`hasRead` 均为函数）。
2. **跨轮次共享（行为断言）**：第一次调用中 `markRead(X)`，第二次调用中 `hasRead(X)` 为真。断言**行为**而非对象同一性，避免与"registry 挂在引擎实例上"这一实现方式耦合。
3. （可选附加）两次调用拿到的是同一个 registry 对象。

### 集成验证

跑 `pnpm --filter @vykor/tools exec vitest run` 与 `pnpm --filter @vykor/core exec vitest run`，确认既有 `operations.test.ts`、`edit.test.ts`、`query-engine` 相关测试不回归。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 强制先读打断既有流程 | 仅在「registry 存在 + 文件已存在 + 未读过」三条同时成立时拒绝；`readFiles` 缺失一律放行 |
| 路径大小写/斜杠不一致导致误判为未读 | 归一化集中在 registry，Windows 小写、斜杠统一；配 registry 单测 |
| 长会话记录无界增长 | `maxEntries` 默认 4096，FIFO 淘汰 |
| 覆盖前多读一次文件的开销 | 只有目标**已存在**时才读，用于 BOM 检测；超大文件的额外开销已记为已知成本与后续优化 |
| WSL 下 BOM 仍丢失 | 已在决策 9 显式声明为既有行为、不在本阶段修 |
| diff 预览被误以为已接线 | 规格显式列为不在范围内，并说明 `computeToolDiff` 现状 |
| 引擎复用导致记录跨会话泄漏 | 引擎是会话级（AgentPool 每 session 一个）；会话结束随 runtime 释放 |
| **记录会因 warm agent 重建而清空** | `invalidateWarmAgents`（软设置变更）、daemon 重启/热加载、以及子代理各自的引擎都会重建，registry 随之丢失，已读文件需要重读。这是**偏向安全**的失效方向（最多多要求一次 Read），本阶段接受；如需严格持久，需把 registry 挂到更长寿的对象（另议） |

## 待确认

无。范围已由用户确认为「含跨包的先读后写（改 core 类型）」；实现细节（registry 归一到 core、有界 4096、`readFiles` 缺失时放行、`Write` 成功后不标记已读、BOM 只对 Host 承诺）为设计内决定。
