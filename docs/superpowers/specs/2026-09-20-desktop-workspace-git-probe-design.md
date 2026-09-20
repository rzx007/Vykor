# 项目外会话的 git 探测统一与审阅可用性设计

> 状态：待实现。

## 目标

让「不在项目里」的会话，只要它的工作目录本身是一个 git 仓库，也能使用右侧的**审阅**工具和消息里的 diff 统计；同时把「一个目录是不是 git 仓库」这个问题收敛到**唯一一个只读探测出口**，不再让判断分散在两条各干各的 git 调用上。

本次不改变分支选择器的语义，也不把项目外会话注册成项目。

## 背景与现状

### 现象

用户有一个「不在项目进行」的会话（`metadata.desktop.workspaceMode === "outside_project"`），它的 `cwd` 是一个真实 git 仓库（在本机是 `Documents\OpenHarness\2026-09-17\x6`）。该会话里：

- 右侧工具面板没有「审阅」入口（快捷键 `Ctrl+Shift+G` 也打不开）。
- 消息里「已编辑 N 个文件」卡片没有 `+/−` 行数，也不能点进审阅。

而在以项目身份打开同一目录的会话里，这些功能都正常。

### 判定链（当前实现）

1. **事实来源**：`apps/desktop/src/main/features/session/session-operations.ts:80` 的 `inspectProject` 用 `git rev-parse --show-toplevel` 判断目录是不是 git 仓库，返回 `DesktopProjectDetails.git`。
2. **写入 store**：`project-actions.ts:106/147/211` 与 `session-actions.ts:178` 把结果写成 `selectedProjectGit`。
3. **被短路的位置**：`helpers.ts:60` 的 `resolveSessionWorkspace`：

   ```ts
   if (session.workspaceMode === "outside_project" || !session.projectId) {
     return {
       workspaceMode: "outside_project",
       selectedProject: null,
       selectedProjectGit: false,          // ← 无条件 false
       selectedProjectGitCheckedAt: null,
       branch: null,
       branches: [],
     }
   }
   ```

   项目外会话一律 `selectedProjectGit = false`，且**根本不会调用 `inspectProject`**（`refreshSelectedProjectGit` 在 `!selectedProject` 时直接返回 `false`，见 `project-actions.ts:184`）。

4. **消费点**：`selectedProjectGit` 同时驱动三类 UI：
   - `utility-panel.tsx:110`（`availableTools` 是否包含 `review`）、`:121`（过滤 review 标签页）、`:170`（`reviewOpenRequest` 的 gate）、`:189`（不在时强制关闭 review 标签页）、`:639`（传下去的 `canOpenReview`）。
   - `main-layout.tsx:281`（`ConversationPane` 的 `canOpenReview`），进而影响 `assistant-message.tsx:416` 是否查询 git 统计、`:487` 是否把「已编辑文件」当作审阅入口。
   - `new-conversation-start.tsx:150`（`const isGitProject = selectedProjectGit`）决定起始页是否显示**分支选择器**。

### 关键事实

- **审阅链路本来就不依赖「项目记录」**：`ReviewTool` 用的是 `selectedProjectPath`（`review-tool.tsx:88-90`），而右侧面板的路径来自 `selectActiveWorkspaceProject`（`utility-panel.tsx:105`）——它对项目外会话会用**会话 cwd 合成一个 workspace**（`selectors.ts:82-88`）。底层 `git.changes` / `fileDiff` 只需要一个目录（`git-service.ts:22-23` 直接 `resolveDirectory(rootPath)`）。
- **`inspectProject` 有写副作用**：它调用 `client.projects.inspect(path)` → `ProjectRepository.inspect`（`project-repository.ts:36-89`），在路径不存在项目时会 **INSERT 一条 project 记录**。因此项目外会话不能直接复用 `inspectProject`，否则会把托管目录注册成项目。
- **仓库里存在两套 git 探测**：
  | 探测 | 位置 | 命令 | 副作用 |
  |---|---|---|---|
  | A | `session-operations.ts:80` | `git rev-parse --show-toplevel` | **会写数据库**（`projects.inspect`） |
  | B | `git-service.ts:23/66` | `git diff --numstat` 等 | 只读 |

  这正是「判断分散」的根源：回答同一个「是不是仓库」的问题，两条路各有各的实现和错误语义。

## 术语

- **统一探测**：`git:isRepository` 通道，只读回答「该目录是不是 git 仓库」，返回仓库根路径。
- **项目会话**：`session.workspaceMode !== "outside_project"` 且 `session.projectId` 存在的会话。
- **项目外会话**：`workspaceMode === "outside_project"` 的会话，其 cwd 由桌面端在 `Documents\OpenHarness\<date>\xN` 下分配。
- **工作区项目（workspace project）**：右侧面板与对话实际使用的目录，由 `selectActiveWorkspaceProject`（`selectors.ts:76`）给出。项目会话返回 store 里的 `selectedProject`；项目外会话返回由**会话 cwd 合成**的 workspace（`projectFromSession(session)`，其 `path === session.cwd`）。
- **`selectActiveWorkspaceProject` 与 `state.selectedProject` 的区别**：前者对项目外会话非空，后者对项目外会话恒为 `null`。本次多处改动就是把消费点从后者换到前者。
- **`useActiveWorkspaceIsGit`**：新增 hook，返回值类型 `boolean | null`（`null` = 尚未判定）。它内部产出本节所说的 `activeWorkspaceIsGit` 语义。

## 设计决策

1. **统一探测出口，但不删除旧探测。** 新增 `git:isRepository`，与现有 `git:changes` 共用 `git-service` 内部的 `resolveDirectory` + `runGit`，因此错误语义、路径校验一致。`session-operations.ts:80` 的探测**保留**——它还要一并取 branch/branches，属于「项目身份」语义，不属于本次要收敛的「是不是仓库」判断。替换它会把改动扩散进项目注册逻辑，违背最小改动原则。

2. **拆开一个开关，而不是重写它。** `selectedProjectGit` 语义**不变**（项目会话 + 该路径是仓库），继续只服务分支选择器。新增 `activeWorkspaceIsGit` 服务审阅与 diff 统计：
   - 项目会话：直接取 `selectedProjectGit`，不额外探测。
   - 项目外会话：用会话 `cwd` 调 `git:isRepository`，结果带 TTL 缓存。

3. **探测是只读且不抛错的。** `git:isRepository` 对以下情况一律返回 `{ isRepository: false, rootPath: null }`，不抛异常：目录不存在、不是目录、非 git 仓库、git 不可用。理由：这是「能力探测」，探测失败应当表现为「没有该能力」，而不是把 UI 推进错误态。

4. **项目外会话的审阅默认停在「上一轮」。** 审阅面板的四个范围选项与默认值（`review-tool.tsx:45-50`）保持不变，用户可自行切到未提交/未暂存/已暂存，**不为项目外会话增加「禁用其他选项」的逻辑**。这不等于 `review-tool.tsx` 完全不动：它必须把「拿工作区路径」的来源从 `state.selectedProject` 改为 `selectActiveWorkspaceProject`（详见证 7）。

5. **缓存复用现有模式。** TTL 与去重策略参照 `renderer/src/lib/git-changes-query.ts`（`Map` + `inFlight` 去重 + `maxAgeMs`），TTL 取 `1000ms`。缓存键**完全复用** `git-changes-query.ts` 的 `normalizedRootPath` 规则（Windows 盘符/UNC 路径转正斜杠、去尾部斜杠并小写；POSIX 路径保留大小写、仅去尾部斜杠），不引入第二套路径规范化；**缓存键取探测输入路径（会话 cwd），不取返回的 `rootPath`**。`git:isRepository` 返回的 `rootPath` 只用于展示与调试，**绝不被当作 `git.changes` 的 `rootPath`**（否则 cwd 为子目录时会与 `selectedProjectPath` 大小写不一致，破坏 `toProjectRelativePath` 的匹配）。

6. **不写 store。** 探测结果只存在于渲染进程的模块级缓存与 React 状态里，绝不写回 `useDesktopSessionStore`，也不触碰 `projects` 表。

7. **审阅与 diff 统计一律以「工作区项目」为路径来源。** 现状有三处直接读 `state.selectedProject`，对项目外会话会拿到 `null`，即使入口可见也会退化成空态或空统计。本次必须同步改为 `selectActiveWorkspaceProject`：

   | 位置 | 现状 | 改为 |
   |---|---|---|
   | `review-tool.tsx:88,90` | `state.selectedProject` / `.path` | `selectActiveWorkspaceProject` / `.path` |
   | `review-tool.tsx:201` | `if (!selectedProject)` 空态 | 判断改为 `if (!selectedProjectPath)` |
   | `assistant-message.tsx:400` | `state.selectedProject?.path` | `selectActiveWorkspaceProject` 的 `.path` |

   其中 `review-tool.tsx:201` 的空态文案「选择一个项目后可以查看文件 diff。」在项目外会话下已不适用，改为按 `!selectedProjectPath` 触发（工作区目录缺失时才显示），文案同步改为「当前工作目录不可用。」。

## 数据模型

### 共享类型（`apps/desktop/src/shared/git-types.ts`）

```ts
export interface DesktopGitIsRepositoryInput {
  path: string
}

export interface DesktopGitIsRepositoryResult {
  isRepository: boolean
  rootPath: string | null
}
```

### IPC 契约（`apps/desktop/src/shared/ipc-channels.ts`）

```ts
gitIsRepository: "git:is-repository",
```

```ts
[IpcChannels.gitIsRepository]: {
  args: [input: DesktopGitIsRepositoryInput]
  result: DesktopGitIsRepositoryResult
}
```

### preload 与契约（`desktop-api.ts` / `desktop-api-contract.ts`）

```ts
git: {
  changes: ...,
  fileDiff: ...,
  isRepository: (input: DesktopGitIsRepositoryInput) => Promise<DesktopGitIsRepositoryResult>
}
```

## 运行流程

### 主进程

1. 渲染进程发 `git:isRepository({ path })`。
2. `gitService.isRepository` 先 `resolveDirectory(path)` 校验（目录不存在/不是目录 → `false`）。
3. 在该目录跑 `git rev-parse --show-toplevel`。
4. 成功 → `{ isRepository: true, rootPath: stdout.trim() }`；失败 → `{ isRepository: false, rootPath: null }`。

### 渲染进程

1. 组件调用 `useActiveWorkspaceIsGit()`。
2. hook 用 `selectActiveWorkspaceProject(state)` 取当前工作区项目，得到 `path`（项目外会话即 `session.cwd`）。
3. 若为项目会话（`state.selectedProject` 非空）→ 返回 `state.selectedProjectGit`，**不探测**。
4. 若为项目外会话 → 用 `path` 查模块级缓存（TTL 内直接返回），未命中则调 `git:isRepository({ path })` 并写缓存。
5. hook 返回 `boolean | null`（`null` = 尚未判定），调用方按 `=== true` 判断可用性，避免初始渲染时误开。

## 组件与职责

| 单元 | 职责 | 位置 |
|---|---|---|
| `gitService.isRepository` | 只读探测目录是否 git 仓库，共用现有 `resolveDirectory`/`runGit` | `apps/desktop/src/main/features/git/git-service.ts` |
| git IPC 注册 | 把探测通道接到 `gitService` | `apps/desktop/src/main/features/git/ipc.ts` |
| 探测缓存 | TTL + inFlight 去重 + 复用 `normalizedRootPath` | `apps/desktop/src/renderer/src/lib/workspace-git-probe.ts` |
| `useActiveWorkspaceIsGit` | 把「项目会话取 store / 项目外会话探测」合成一个布尔 | `apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.ts` |
| `utility-panel` | 审阅工具出现/保留、review 标签页 gate | 现有文件，改 5 处消费点 |
| `main-layout` | 传给 `ConversationPane` 的 `canOpenReview` | 现有文件，改 2 处 |
| `review-tool` | 工作区路径来源 + 空态判断 | 现有文件，改 3 处（`:88`、`:90`、`:201`） |
| `assistant-message` | diff 统计的路径来源 | 现有文件，改 1 处（`:400`） |

## 不在范围内

- 不修改 `resolveSessionWorkspace`（`helpers.ts`）的返回值。
- 不修改 `new-conversation-start.tsx` 的 `isGitProject`（分支选择器语义保持「仅项目会话」）。
- 不删除或替换 `session-operations.ts:80` 的探测。
- 不修改 `review-tool.tsx` 的范围选项集合与默认值（只改决策 7 列出的路径来源与空态判断）。
- 不修改 `packages/*`（server / services / client）。
- 不给项目外会话自动注册项目，不弹出「添加为项目」引导。

## 错误处理

| 场景 | 表现 |
|---|---|
| 目录不存在 / 不是目录 | `isRepository: false`，审阅入口不出现 |
| 目录存在但不是 git 仓库 | `isRepository: false` |
| git 未安装 / 命令失败 | `isRepository: false`（与现有 `git.changes` 行为一致） |
| 探测进行中 | hook 返回 `null`，审阅入口暂不出现，判定完成后按结果切换 |
| IPC 调用抛错 | `workspace-git-probe` 捕获异常，返回 `false` **且不写缓存**（下次调用重新探测）；hook 把该结果存为 state `false`，不冒泡到错误 UI |
| 项目外会话 cwd 为空 | 直接返回 `false`，不发探测 |

## 测试

1. **`git-service` 探测测试**（`apps/desktop/src/main/features/git/git-service.test.ts`，与实现同目录；若该文件已存在则追加）：真实仓库目录 → `true` 且 `rootPath` 为仓库根；非仓库目录 → `false` 不抛错；空/非法路径 → `false`；仓库内子目录 → `true`（`--show-toplevel` 语义）。
2. **探测缓存测试**（`apps/desktop/src/renderer/src/lib/workspace-git-probe.test.ts`，与实现同目录，不新建 `__test__` 子目录）：TTL 内重复调用只发一次 IPC；不同路径独立缓存；IPC 抛错时返回 `false` 且**不写缓存**（用 spy 断言第二次调用仍会发起 IPC）。
3. **hook 测试**（`apps/desktop/src/renderer/src/hooks/use-active-workspace-is-git.test.ts`，与实现同目录）：项目会话直接用 `selectedProjectGit` 且**不触发** `git:isRepository`；项目外会话 + 探测为真 → `true`；项目外 + 探测为假 → `false`；cwd 为空 → `false`。
4. **`utility-panel` 测试**：项目外会话 + `activeWorkspaceIsGit = true` 时 `review` 出现在工具列表、review 标签页能打开；`false` 时被关闭并移除。现有 fixture（如 `main-layout-project-operation-error.test.ts:170`）需要补充新来源的注入值。
5. **`review-tool` 测试**（`apps/desktop/src/renderer/src/components/desktop/tools/review-tool.git-changes.test.tsx` 追加）：项目外会话（`state.selectedProject = null`，但 `selectActiveWorkspaceProject` 返回合成 workspace）下不再进入「选择一个项目后可以查看文件 diff。」空态，而是按 `selectedProjectPath` 正常加载改动。
6. **`assistant-message` 测试**：项目外会话下 `ChangedFilesSummary` 能拿到工作区路径并查询 git 统计（不再因 `state.selectedProject` 为 `null` 而清空统计）。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| 项目外会话频繁切换导致 git 进程开销 | TTL 缓存 + inFlight 去重 |
| 探测未返回时审阅入口闪烁 | hook 返回 `null`，调用方只在 `=== true` 时显示 |
| 测试 fixture 需要补字段 | 已在测试一节列出，属机械改动 |
| 项目外会话的 `state.selectedProject` 为 `null`，导致入口开了但内容空 | 决策 7 已把 `review-tool` 与 `assistant-message` 的路径来源统一到 `selectActiveWorkspaceProject`，并配了对应测试 |
| 探测缓存键与 `git.changes` 缓存键规范不一致 | 决策 5 要求逐字复用 `normalizedRootPath`，不另写规范化 |
| 未来又有人用 `selectedProjectGit` 做审阅判断 | 在 `selectors.ts` 顶部注释写明两者分工 |

## 待确认

无。设计选项（做法 X、选择 A）与三个实现细节（hook 放 `hooks/`、探测 TTL 与 `git-changes-query.ts` 对齐为 1000ms、不替换旧探测）均已由用户确认。
