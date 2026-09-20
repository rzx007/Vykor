# Desktop IM 会话分区实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。
> 设计与契约以 `docs/superpowers/specs/2026-09-20-desktop-im-sessions-design.md` 为准。

**目标：** 在 Desktop 侧边栏新增「IM 会话」分区（按平台分组、空时不渲染），渠道会话从「项目/最近」移出；标题=第一条消息；渠道工作区改到 `<outsideProjectWorkspaceRoot 或 homedir/Documents/OpenHarness>/channels`；提供手动刷新入口。

**架构：** daemon 侧只改两件事——工作区根（纯函数 `resolveChannelWorkspaceRoot` + `DaemonApplication` 注入）和建会话时的标题/metadata。Desktop 侧：`bootstrap()` 按"渠道会话 cwd"隐藏对应项目；渲染层新增 `isChannelSession` / `selectImSessionGroups` 与「IM 会话」分区，并从「项目/最近」排除渠道会话。

**技术栈：** TypeScript、Vitest、React、Zustand、pnpm workspace。

## Global Constraints

- 不迁移旧会话/旧工作区；不自动删除遗留项目记录（用户手动）。
- 不做事件驱动刷新；只提供手动刷新入口（按钮 + 展开分区）。
- 不改 `@openharness/protocol` durable 类型。
- 不改渠道运行时连接/收发逻辑。
- 渠道会话识别：`metadata.externalConversation` 存在或 `metadata.source === "channel"`，且 `metadata.fork` 为空。
- 标题只在**新建**会话时设置；空正文回退 `飞书 · <chatId>`。
- 每个任务一个 commit；严格 TDD（先红后绿）。

---

## 文件结构

| 文件 | 职责 | 动作 |
|---|---|---|
| `packages/core/src/config/paths.ts` + `paths.test.ts` | `resolveChannelWorkspaceRoot`；`getChannelWorkspaceRoot` 改为调用它 | 修改 |
| `packages/server/src/application/daemon-application.ts` | 注入渠道 `workspaceRoot` | 修改 |
| `packages/server/src/application/channel/channel-connector-labels.ts` | 平台显示名映射 | 新建 |
| `packages/server/src/application/channel/channel-application-service.ts` | 标题=第一条消息；metadata 加 `desktop.workspaceMode` | 修改 |
| `apps/desktop/src/main/features/session/session-service.ts` | bootstrap 项目过滤加"渠道会话 cwd"隐藏 | 修改 |
| `apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts` | `isChannelSession`；打开语义；合成工作区展示名 | 修改 |
| `apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts` | `selectImSessionGroups` | 修改 |
| `apps/desktop/src/shared/channel-types.ts` | 渲染端平台显示名映射 | 修改 |
| `apps/desktop/src/renderer/.../sidebar-section-expansion.ts` + `.test.ts` | 增加 `im` | 修改 |
| `apps/desktop/src/renderer/.../sidebar.tsx` + `sidebar.test.tsx` | 新分区、刷新按钮、排除、空栏不渲染 | 修改 |
| `docs/channels-flow.md` | 工作区路径与 IM 分区说明 | 修改 |

---

## 任务 1：`resolveChannelWorkspaceRoot`（core）

**文件：** `packages/core/src/config/paths.ts`、`packages/core/src/config/paths.test.ts`、`packages/core/src/index.ts`

**Interfaces：**
- Produces：`resolveChannelWorkspaceRoot(input: { envDir?: string; outsideProjectWorkspaceRoot?: string; homedir?: string }): string`

- [ ] **步骤 1：编写失败的测试**（`paths.test.ts`）

```ts
it("resolves the channel workspace root from env, outside root, then homedir", () => {
  expect(resolveChannelWorkspaceRoot({ envDir: resolve("/tmp/env"), outsideProjectWorkspaceRoot: resolve("/tmp/out"), homedir: resolve("/tmp/home") })).toBe(resolve("/tmp/env"));
  expect(resolveChannelWorkspaceRoot({ outsideProjectWorkspaceRoot: resolve("/tmp/out"), homedir: resolve("/tmp/home") })).toBe(join(resolve("/tmp/out"), "channels"));
  expect(resolveChannelWorkspaceRoot({ homedir: resolve("/tmp/home") })).toBe(join(resolve("/tmp/home"), "Documents", "OpenHarness", "channels"));
});
it("getChannelWorkspaceRoot defaults under Documents and honors OPENHARNESS_CHANNELS_DIR", () => {
  // env 覆盖 + 默认值（默认值用 homedir，测试里只断言以 Documents/OpenHarness/channels 结尾）
});
```

- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/core test -- --run src/config/paths.test.ts`
- [ ] **步骤 3：实现**：新增纯函数；`getChannelWorkspaceRoot()` 改为 `resolveChannelWorkspaceRoot({ envDir: process.env.OPENHARNESS_CHANNELS_DIR })`；`index.ts` 导出。
- [ ] **步骤 4：通过 + Commit**

```bash
pnpm --filter @openharness/core test -- --run
git add packages/core/src/config/paths.ts packages/core/src/config/paths.test.ts packages/core/src/index.ts
git commit -m "feat(core): resolve channel workspace under the outside-project root"
```

---

## 任务 2：daemon 注入渠道 workspaceRoot

**文件：** `packages/server/src/application/daemon-application.ts`（测试：任务 1 的纯函数已覆盖逻辑；本任务为一行接线，靠现有 daemon 装配测试与人工验收覆盖）

- [ ] **步骤 1：实现**

在构造 `ChannelRuntimeService` 处传入：

```ts
workspaceRoot: resolveChannelWorkspaceRoot({
  envDir: process.env.OPENHARNESS_CHANNELS_DIR,
  outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot,
  homedir: homedir(),
}),
```

（`homedir` 从 `node:os` 引入；`resolveChannelWorkspaceRoot` 从 `@openharness/core` 引入。）

- [ ] **步骤 2：类型检查 + Commit**

```bash
pnpm --filter @openharness/server check-types
pnpm --filter @openharness/server test -- --run src/application/__test__/daemon-channel-assembly.test.ts
git add packages/server/src/application/daemon-application.ts
git commit -m "feat(server): place channel workspaces under the outside-project root"
```

---

## 任务 3：平台显示名 + 会话标题/metadata

**文件：**
- 新建：`packages/server/src/application/channel/channel-connector-labels.ts`
- 修改：`packages/server/src/application/channel/channel-application-service.ts`
- 测试：`packages/server/src/application/channel/__test__/channel-application-service.test.ts`

**Interfaces：**
- Produces：`channelConnectorLabel(connector: string): string`、`channelSessionTitle(input: DurableChannelMessageInput): string`

- [ ] **步骤 1：编写失败的测试**
  - 标题：第一条消息（含多行折叠、第一句、超长无标点、emoji/CJK 按码点截断）。
  - 空正文（`content: ""`）→ `飞书 · <chatId>`。
  - 纯空白/纯标点 → 回退。
  - 新建会话 metadata 含 `desktop.workspaceMode === "outside_project"`。
  - 已存在会话（`findConversation` 命中且未归档）不改标题。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/server test -- --run src/application/channel/__test__/channel-application-service.test.ts`
- [ ] **步骤 3：实现**

```ts
// channel-connector-labels.ts
const LABELS: Record<string, string> = { feishu: "飞书", lark: "飞书（国际）" };
export function channelConnectorLabel(connector: string): string {
  return LABELS[connector.trim().toLowerCase()] ?? "其他平台";
}
```

`resolveConversation` 里：

```ts
title: channelSessionTitle(input),
metadata: {
  source: "channel",
  externalConversation: { connector, accountId, workspaceId?, chatId, threadId? },
  desktop: { workspaceMode: "outside_project" },
},
```

`channelSessionTitle`：折叠空白 → 取第一句 → `[...str].slice(0, 20)`；空则 `${channelConnectorLabel(connector)} · ${chatId}`。

- [ ] **步骤 4：通过 + Commit**

```bash
pnpm --filter @openharness/server test -- --run
pnpm --filter @openharness/server check-types
git add packages/server/src/application/channel
git commit -m "feat(server): title channel sessions from the first message"
```

---

## 任务 4：Desktop bootstrap 按渠道会话隐藏项目

**文件：** `apps/desktop/src/main/features/session/session-service.ts`（测试：`session-service.test.ts` 或新增 `session-service.channel-project.test.ts`）

- [ ] **步骤 1：编写失败的测试**：构造 sessions（一个渠道会话 `metadata.externalConversation` + cwd 在文档外）与 projectRecords（其 path = 该 cwd），断言 `bootstrap()` 返回的 `projects` 不含它；同时文档根下的项目仍被隐藏；普通项目保留。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/desktop exec vitest run src/main/features/session/session-service.channel-project.test.ts`
- [ ] **步骤 3：实现**：`bootstrap()` 里先算 `channelCwds = new Set(sessions.filter(isChannelMetadata).map(normalize(cwd)))`，项目过滤为 `!isOutsideProjectWorkspacePath(path) && !channelCwds.has(normalize(path))`。渠道判定用 `metadata.externalConversation != null || metadata.source === "channel"`（不排除 fork 也无妨，但保持一致可排除）。
- [ ] **步骤 4：通过 + Commit**

```bash
pnpm --filter @openharness/desktop exec vitest run src/main/features/session/session-service.channel-project.test.ts
git add apps/desktop/src/main/features/session/session-service.ts apps/desktop/src/main/features/session/session-service.channel-project.test.ts
git commit -m "feat(desktop): hide channel projects by session ownership"
```

---

## 任务 5：渲染层渠道识别与打开语义

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts`
- 测试：`helpers.test.ts`

- [ ] **步骤 1：编写失败的测试**
  - `isChannelSession`：有 `externalConversation` → true；只有 `source:"channel"` → true；两者都无 → false；带 `fork` → false。
  - `resolveSessionWorkspace`：渠道会话（含无 `desktop.workspaceMode` 的旧会话）→ `workspaceMode:"outside_project"`、`selectedProject:null`。
  - `projectFromSession`：渠道/项目外会话展示名优先 `session.title`（非空），否则 `basename(cwd)`。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/stores/desktop-session/helpers.test.ts`
- [ ] **步骤 3：实现**（`isChannelSession` 见 spec §6.1；`resolveSessionWorkspace` 开头加 `isChannelSession` 判定；`projectFromSession` 名字回退顺序调整）
- [ ] **步骤 4：通过 + Commit**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts apps/desktop/src/renderer/src/stores/desktop-session/helpers.test.ts
git commit -m "feat(desktop): treat channel sessions as outside-project"
```

---

## 任务 6：`selectImSessionGroups`

**文件：**
- 修改：`apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts`
- 修改：`apps/desktop/src/shared/channel-types.ts`（渲染端平台显示名映射）
- 测试：`selectors.test.ts`

- [ ] **步骤 1：编写失败的测试**：分组、标签（feishu→飞书、缺失 connector→其他平台）、置顶优先、`updatedAt` 倒序、组间排序与并列 tie-break、仅未归档（归档渠道会话不入选）。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/stores/desktop-session/selectors.test.ts`
- [ ] **步骤 3：实现**

```ts
export interface DesktopImSessionGroup { connector: string; label: string; sessions: DesktopSessionRecord[] }
export function selectImSessionGroups(state: DesktopSessionState): DesktopImSessionGroup[]
```

数据源 `state.sessions`；connector 取 `metadata.externalConversation.connector`（缺失 `"other"`）；label 用 `@shared/channel-types` 的映射。

- [ ] **步骤 4：通过 + Commit**

```bash
git add apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts apps/desktop/src/renderer/src/stores/desktop-session/selectors.test.ts apps/desktop/src/shared/channel-types.ts
git commit -m "feat(desktop): group channel sessions by platform"
```

---

## 任务 7：侧边栏「IM 会话」分区

**文件：**
- 修改：`apps/desktop/src/renderer/.../sidebar-section-expansion.ts` + `.test.ts`
- 修改：`apps/desktop/src/renderer/.../sidebar.tsx` + `sidebar.test.tsx`

- [ ] **步骤 1：编写失败的测试**
  - `sidebar-section-expansion`：`im` 默认 true、持久化、旧数据（无 `im`）兼容。
  - `sidebar`：有 IM 会话 → 渲染「IM 会话」+ 分组 + 会话；无 IM 会话 → **整栏不渲染**（标题/刷新都不出现）。
  - 「项目」下会话列表不含渠道会话；「最近」不含渠道会话。
  - 「刷新」按钮调用 `refreshBootstrap`；展开分区（`im` false→true）触发刷新。
  - 组内 >5 条有「展开显示」。
- [ ] **步骤 2：运行确认失败**：`pnpm --filter @openharness/desktop exec vitest run src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx src/renderer/src/components/desktop/layout/main-layout/sidebar-section-expansion.test.ts`
- [ ] **步骤 3：实现**
  - `SidebarSectionExpansion` 加 `im: boolean`（默认 true）+ parse 兼容。
  - `sidebar.tsx`：`imGroups = selectImSessionGroups(state)`；非空时渲染分区（含刷新按钮），空则整段不渲染；`recentSessions` 与项目会话过滤排除 `isChannelSession`；`toggleSection("im")` 展开时调 `refreshBootstrap()`。
- [ ] **步骤 4：通过 + Commit**

```bash
pnpm --filter @openharness/desktop typecheck
git add apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.test.tsx apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-section-expansion.ts apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar-section-expansion.test.ts
git commit -m "feat(desktop): add the IM sessions sidebar section"
```

---

## 任务 8：文档同步

**文件：** `docs/channels-flow.md`（顶层当前文档，需保留 `> 状态：当前…`，源码路径必须存在）

- [ ] **步骤 1：更新**：工作区路径改为 `<outsideProjectWorkspaceRoot 或 <文档>/OpenHarness>/channels/...`；补「IM 会话」分区与"渠道会话不进项目/最近"说明；说明 `getChannelWorkspaceRoot` 默认变更。
- [ ] **步骤 2：校验 + Commit**

```bash
pnpm check-docs
git diff --check
git add docs/channels-flow.md
git commit -m "docs: document the IM sessions section and channel workspace root"
```

---

## 任务 9：阶段完整验证

- [ ] **步骤 1：相关包全量测试**

```bash
pnpm --filter @openharness/core test -- --run
pnpm --filter @openharness/server test -- --run
pnpm --filter @openharness/desktop test
```

- [ ] **步骤 2：类型与构建**

```bash
pnpm --filter @openharness/desktop typecheck
pnpm exec turbo build --output-logs=errors-only
pnpm check-docs
git diff --check
```

- [ ] **步骤 3：人工验收**（按 spec §9）
  1. 发一条飞书消息 → 点「IM 会话」的「刷新」→ 出现「IM 会话 → 飞书」，标题=第一条消息；
  2. 该会话不在「项目」「最近」；
  3. 无渠道会话时整栏不显示；
  4. 工作区落在 `<文档>/OpenHarness/channels/feishu/...`，对应项目不显示；
  5. 旧渠道会话也在「IM 会话」，打开按项目外处理。

---

## 阶段完成标准

- 「IM 会话」分区按 spec §6 工作：分组、空栏不渲染、排除项目/最近、手动刷新入口可用。
- 渠道会话标题=第一条消息；工作区在项目外根下；打开按项目外处理。
- 相关包测试、类型检查、全仓构建、`check-docs`、`git diff --check` 全绿。
- 未做：事件驱动自动刷新、遗留项目自动清理、旧数据迁移（按 spec §7）。
