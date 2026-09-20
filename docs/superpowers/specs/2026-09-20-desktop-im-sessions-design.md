# Desktop IM 会话分区设计

## 1. 背景与问题

渠道（当前仅飞书）消息会在 daemon 里创建 durable Session。现状：

- 每个外部会话（私聊 / 群 / 群内话题）按 `connector + accountId + chatId + threadId` 建一个 Session；
- `SessionRepository.create` 会解析项目：有显式 `projectId` 用之，否则 `projects.inspect(cwd)`，**找不到就新建一条项目记录**；都拿不到才抛错（`packages/services/src/sessions/session-repository.ts`）。所以每个会话都有 `projectId`，项目名 = `basename(cwd)`；
- 渠道会话的 `cwd` 是 `~/.openharness-ts/channels/feishu/<sanitize(chatId)>-<hash>`；
- Desktop 侧边栏的「项目」区因此出现一串 `oc_...-hash` 项目，和用户自己的代码项目混在一起；
- 会话标题是 `feishu · <chatId>`，对用户不可读；
- 新建的渠道会话不会自动出现在侧边栏，需要手动刷新。

目标：把渠道会话从「项目」里拿出来，做成独立的「IM 会话」分区，按平台分组展示；标题用第一条消息；工作区放到 Desktop 的"项目外工作区"根目录下。

## 2. 目标与非目标

### 2.1 目标

- 侧边栏新增「IM 会话」分区：按平台（`feishu` 等）分组，组内列出该平台的会话。
- 渠道会话**不出现在「项目」和「最近」**；「IM 会话」**没有内容时整栏（含标题）不渲染**。
- 渠道会话标题 = 第一条消息（可读）；首条为图片/文件等无正文时回退 **`飞书 · <chatId>`**（本地化前缀，与分组标签一致）。
- 渠道工作区改到 `<outsideProjectWorkspaceRoot 或 <文档>/OpenHarness>/channels/<connector>/<sanitize(chatId)>-<hash>`；复用 Desktop 的"项目外工作区"语义（打开按项目外处理）。
- 旧渠道会话（改动前创建）也进「IM 会话」分区，且打开时同样按项目外处理。
- 提供一个**手动刷新入口**，让新建渠道会话在刷新后可见（事件驱动的自动刷新本阶段不做）。

### 2.2 非目标

- **不迁移旧会话/旧工作区**；旧会话保留在原目录。
- **不做事件驱动的"立即刷新"**（后续单独设计）；本阶段用手动刷新兜底。
- **不自动清理遗留项目记录**（用户手动删除）；但 Desktop 会按会话归属隐藏这些项目行（见 §6.4）。
- 不新增平台（仍只有飞书）。
- 不改 `@openharness/protocol` durable 类型。
- 不改渠道运行时的连接/收发逻辑。

## 3. 关键决策

| 决策 | 结论 | 理由 |
|---|---|---|
| 展示位置 | 新增「IM 会话」分区，放「项目」与「最近」之间 | 渠道会话不是项目会话，单独归类 |
| 空分区 | 无渠道会话时整栏不渲染 | 避免占位噪音 |
| 分组 | 按 `connector` 分组；组内 `pinnedAt` 优先、再 `updatedAt` 倒序；组间按各组最新 `updatedAt` 倒序，并列按 connector 字典序 | 未来多平台扩展；排序稳定 |
| 平台显示名 | `feishu → 飞书`、`lark → 飞书（国际）`（为未来保留），未知回退「其他平台」 | 用户可读 |
| 折叠 | 只做分区级折叠（`im`），平台分组不单独折叠；组内超过 5 条时提供「展开显示」 | 保持简单、防长列表 |
| 工作区根 | `resolveChannelWorkspaceRoot({ envDir, outsideProjectWorkspaceRoot, homedir })` | 纯函数便于测试；落在项目外根下 |
| 会话语义 | 新建渠道会话写 `metadata.desktop.workspaceMode = "outside_project"`；**所有**渠道会话（含旧会话）打开时按项目外处理 | 统一 IM 会话的打开行为 |
| 标题 | 第一条消息；空则回退 `飞书 · <chatId>` | 侧边栏可读 |
| 项目记录 | 仍会解析/新建（仓库约束），但 Desktop 按"渠道会话的 cwd"隐藏对应项目行 | 不改成 null，避免动会话模型 |
| 立即刷新 | 本阶段不做事件推送；提供手动「刷新」入口 | 用户要求暂缓 |
| 遗留清理 | 手动删 DB 行；Desktop 仅隐藏显示 | 用户明确 |

## 4. 现状机制（复用的部分）

- 「项目外工作区」判定：`apps/desktop/src/main/features/session/outside-project-workspace.ts` 的 `isOutsideProjectWorkspacePath(path, documentsPath)` = 路径在 `<文档>/OpenHarness` 下；`buildOutsideProjectRoot(documents)` = `<文档>/OpenHarness`。
- Desktop `bootstrap()` 用它过滤项目（`session-service.ts`）：`projectRecords.filter((p) => !isOutsideProjectWorkspacePath(p.path, app.getPath("documents")))`，并返回 `outsideProjectWorkspaceRoot = <文档>/OpenHarness`。
- 会话 `workspaceMode` 由 `toDesktopSessionRecord` 计算：`metadata.desktop.workspaceMode === "outside_project"` 或 cwd 在项目外根下 → `outside_project`。
- 侧边栏「最近」= `workspaceMode === "outside_project"` 的会话（`sidebar.tsx` 的 `recentSessions`）。
- 定时任务 standalone 会话就是这个模式（cwd 在项目外根下 + `metadata.desktop.workspaceMode`）。
- Desktop 内置 daemon 传入精确的 `outsideProjectWorkspaceRoot`（`daemon-connection-service.ts`、`daemon-entry.ts`）；CLI `ohs daemon` 目前**不传**，当前回退 `getChannelWorkspaceRoot()` = `~/.openharness-ts/channels`。
- 会话 metadata 会随 `SessionRecord.metadata` 透传到 Desktop（`DesktopSessionRecord.metadata`）；渠道会话由 `resolveConversation` 写 `source: "channel"` + `externalConversation`（旧会话也有）。
- 打开会话的工作区解析：`resolveSessionWorkspace` 对 `outside_project` 返回 `selectedProject: null`；`selectActiveWorkspaceProject` 用 `projectFromSession` 合成工作区。

## 5. 会话语义改动

### 5.1 工作区根

在 `packages/core/src/config/paths.ts` 新增纯函数（替换/补充 `getChannelWorkspaceRoot`）：

```ts
export function resolveChannelWorkspaceRoot(input: {
  envDir?: string | undefined;
  outsideProjectWorkspaceRoot?: string | undefined;
  homedir?: string | undefined;
}): string {
  if (input.envDir) return input.envDir;
  const base =
    input.outsideProjectWorkspaceRoot ??
    join(input.homedir ?? homedir(), "Documents", "OpenHarness");
  return join(base, "channels");
}
```

- `getChannelWorkspaceRoot()` 改为调用它（`envDir = process.env.OPENHARNESS_CHANNELS_DIR`），默认值因此从 `<配置目录>/channels` 变为 `<homedir>/Documents/OpenHarness/channels`（**语义变更**，见 §10）。
- `DaemonApplication` 构造 `ChannelRuntimeService` 时传：
  `workspaceRoot = resolveChannelWorkspaceRoot({ envDir: process.env.OPENHARNESS_CHANNELS_DIR, outsideProjectWorkspaceRoot: options.outsideProjectWorkspaceRoot, homedir: homedir() })`。
- `scheduled-task-executor` 的 standalone 目录也改为复用同一个 base（可选，保持一处逻辑）。

每个会话目录名不变：`sanitize(chatId)-sha1(connector|accountId|chatId|threadId)[:12]`。

### 5.2 标题

`ChannelApplicationService.resolveConversation` 建会话时 `title = channelSessionTitle(input)`：

- 取 `input.content`，折叠连续空白、去首尾；
- 取第一句（到 `。！？.!?` 为止），再用 `[...str].slice(0, 20)`（按码点）截断；
- 结果为空（图片/文件首条、纯空白/纯标点）→ 回退 `${channelConnectorLabel(connector)} · ${chatId}`，例如 `飞书 · oc_...`。

`channelConnectorLabel` 映射：`feishu → 飞书`、`lark → 飞书（国际）`、空/未知 → `其他平台`。服务端定义于 `packages/server/src/application/channel/channel-connector-labels.ts`；Desktop 渲染端在 `apps/desktop/src/shared/channel-types.ts` 定义同一张表（跨端不能共享运行时值，属**有意重复**，各自加注释）。

只在**新建**会话时设置；已存在会话不改标题（不迁移）。

### 5.3 metadata

```ts
metadata: {
  source: "channel",
  externalConversation: { connector, accountId, workspaceId?, chatId, threadId? },
  desktop: { workspaceMode: "outside_project" },
}
```

`patchSessionRuntimeMetadata` 会展开原 metadata，`desktop` 字段保留。

## 6. 侧边栏「IM 会话」分区

### 6.1 识别与分组

`apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts`：

```ts
export function isChannelSession(session: DesktopSessionRecord): boolean {
  if (session.metadata.fork) return false;                    // fork 出的普通会话不算
  return (
    isRecord(session.metadata.externalConversation) ||        // 主判据：外部会话标记
    session.metadata.source === "channel"                      // 兼容缺 externalConversation 的旧数据
  );
}
```

选择器（`selectors.ts`）：

```ts
export interface DesktopImSessionGroup { connector: string; label: string; sessions: DesktopSessionRecord[] }
export function selectImSessionGroups(state: DesktopSessionState): DesktopImSessionGroup[]
```

- 数据源：**仅 `state.sessions`（未归档）**；归档渠道会话只出现在「已归档」。
- 分组键：`metadata.externalConversation.connector`；缺失回退 `"other"`（标签「其他平台」）。
- 排序：组内 `pinnedAt` 优先、再 `updatedAt` 倒序、并列按 `id`；组间按各组最新 `updatedAt` 倒序、并列按 connector 字典序。

### 6.2 渲染

`sidebar.tsx`：

- `selectImSessionGroups` 非空时，渲染「IM 会话」`SidebarSectionHeader`（可折叠，状态存 `SidebarSectionExpansion.im`，默认展开）；标题右侧放**「刷新」按钮**（见 §6.5）。
- 每个平台组：组头（图标 + `label` + 数量）+ `SessionRow` 列表；组内超过 5 条时提供「展开显示 / 收起」（复用 `ProjectGroup` 的做法）。
- 返回空时**整栏（含标题、刷新按钮）不渲染**。
- 「项目」下每个项目的会话列表过滤掉渠道会话（`!isChannelSession`）。
- 「最近」的 `recentSessions` 过滤掉渠道会话；只有渠道会话的用户会看到空的「最近」，**接受该空态，不改文案**。
- 「已归档」不变。

### 6.3 打开语义（含旧会话）

- `resolveSessionWorkspace`：`isChannelSession(session)` 时直接返回 `outside_project` + `selectedProject: null`（即使旧会话没有 `desktop.workspaceMode`），保证 IM 分区里所有会话打开行为一致。
- `projectFromSession`（合成工作区）：**仅对渠道会话**优先用 `session.title`（非空时），否则回退 `basename(cwd)`；避免右侧工具/文件面板显示 `oc_...-hash`，同时不改变定时 standalone 等既有行为。
- 置顶：对渠道会话仍可用，且在 IM 组内排序生效（§6.1）。
- 归档：归档后离开 IM 分区进入「已归档」；该外部会话的下一条消息会按 `resolveConversation` 新建会话（既有行为）。
- 删除：删除会话后外部会话映射仍在，下一条消息重建会话（既有行为）。
- 从 IM 会话回到「新对话」时 `workspaceMode` 仍是 `outside_project`，会在 `<文档>/OpenHarness/<日期>/xN` 建会话——与定时 standalone 一致，**接受**。

### 6.4 项目隐藏

`bootstrap()` 里项目过滤改为两条并集：

1. 现有：路径在 `<文档>/OpenHarness` 下（覆盖新工作区）；
2. 新增：项目 `normalizedPath` 命中任一**渠道会话的 `cwd`**（用会话 metadata 判定，覆盖 `OPENHARNESS_CHANNELS_DIR` 指到文档目录外、以及旧 `~/.openharness-ts/channels` 项目）。

第 2 条与路径/env 无关，保证 §9 验收 4 在 env 覆盖时也成立。遗留项目记录不删，只是不显示。

### 6.5 刷新入口（本阶段替代事件推送）

- IM 分区标题右侧「刷新」按钮：调用 store 的 `refreshBootstrap()`（已存在），重新拉取 projects + sessions。
- 展开 IM 分区时（`toggleSection("im")` 由 false → true）也触发一次 `refreshBootstrap()`。
- 这两条是本阶段"新建会话可见"的**唯一可达路径**；验收据此判定。

## 7. 明确不做

- 事件驱动的列表刷新：Desktop 目前只有按会话的 `IpcEvents.sessionUpdated`，没有聚合的列表变更事件；`GET /events/stream` 支持全局流但本阶段不接入。后续单独设计。
- 遗留项目记录的删除（用户手动）。
- 旧会话标题/工作区迁移。

## 8. 测试计划

| 范围 | 用例 |
|---|---|
| `packages/core` | `resolveChannelWorkspaceRoot`：envDir 优先 / outsideProjectWorkspaceRoot / homedir 回退；`getChannelWorkspaceRoot` 默认值 |
| `packages/server` | `channel-application-service`：标题=第一条消息；纯空白/纯标点/超长无标点/emoji 截断；空正文回退 `飞书 · chatId`；metadata 含 `desktop.workspaceMode`；已存在会话不改标题 |
| `packages/server` | `channel-connector-labels`：映射与回退 |
| `apps/desktop` main | `bootstrap()` 项目过滤：documents 根下隐藏；`OPENHARNESS_CHANNELS_DIR` 指向文档外时，渠道会话 cwd 对应项目仍隐藏 |
| `apps/desktop` renderer | `isChannelSession`：externalConversation 存在 / 仅 source=channel / **fork 排除** / 两者都无 |
| `apps/desktop` renderer | `selectImSessionGroups`：分组、标签（含缺失 connector）、置顶优先、稳定排序、仅未归档 |
| `apps/desktop` renderer | `sidebar`：有 IM 时渲染分区与分组；无 IM 时**整栏不渲染**；「项目」「最近」不含渠道会话；「刷新」按钮调 `refreshBootstrap`；展开分区触发刷新；组内 >5 条有展开 |
| `apps/desktop` renderer | `sidebar-section-expansion`：`im` 默认/持久化/旧数据兼容 |
| `apps/desktop` renderer | 打开语义：渠道会话（含旧会话）`resolveSessionWorkspace` → outside_project + selectedProject null；`projectFromSession` 展示名用 title |
| 回归 | 现有 sidebar/selectors/server/core/client 测试、`turbo build`、`check-docs`、`git diff --check` |

## 9. 验收标准

1. **新建**一条飞书消息产生会话后，点「IM 会话」的「刷新」（或展开该分区），侧边栏出现「IM 会话 → 飞书」，组内会话标题为第一条消息。
2. 无渠道会话时，侧边栏**不出现**「IM 会话」栏。
3. 渠道会话（含旧会话）不出现在「项目」下的会话列表，也不出现在「最近」。
4. 前提：未设置 `OPENHARNESS_CHANNELS_DIR`（或设置值也由 §6.4 第 2 条覆盖）时，渠道工作区落在 `<文档>/OpenHarness/channels/feishu/...`，且对应项目行不出现在「项目」。旧渠道项目行默认也被隐藏（记录仍在，用户可手动删）。
5. 旧渠道会话出现在「IM 会话」分区，打开时按"项目外"处理（不选中真实项目）。
6. 相关包测试、类型检查、全仓构建、`check-docs`、`git diff --check` 全绿。
7. （已知限制）没有事件推送；新建会话需点「刷新」或展开分区后才出现。

## 10. 风险

| 风险 | 缓解 |
|---|---|
| `getChannelWorkspaceRoot` 默认从配置目录改为文档目录，属**语义变更**；设了 `OPENHARNESS_CONFIG_DIR` 的用户渠道工作区会"搬家" | 不迁移旧数据；spec/文档明确；`OPENHARNESS_CHANNELS_DIR` 仍可显式覆盖 |
| `OPENHARNESS_CHANNELS_DIR` 指到文档目录外时项目不再靠路径隐藏 | §6.4 第 2 条按会话 cwd 隐藏，不依赖路径 |
| fork 会话误判为渠道会话 | `isChannelSession` 排除 `metadata.fork` |
| 旧渠道会话打开时选中遗留项目 | §6.3 统一按 outside_project 处理 |
| 右侧工具显示 `oc_...-hash` 目录名 | §6.3 `projectFromSession` 用 `session.title` |
| 渠道会话工作区文件落在"文档"目录 | 与定时 standalone 一致；可接受 |
| 服务端/渲染端各存一份平台显示名 | 有意重复，各自注释；改动时同步 |
| 手动刷新仍不够"实时" | 明确为已知限制，事件推送后续做 |

## 11. 逐文件改动

| 文件 | 动作 |
|---|---|
| `packages/core/src/config/paths.ts` + `paths.test.ts` | 新增 `resolveChannelWorkspaceRoot`；`getChannelWorkspaceRoot` 改为调用它（默认文档目录） |
| `packages/server/src/application/daemon-application.ts` | 注入 `workspaceRoot = resolveChannelWorkspaceRoot(...)` |
| `packages/server/src/application/channel/channel-connector-labels.ts` | 新增平台显示名映射 |
| `packages/server/src/application/channel/channel-application-service.ts` | 标题=第一条消息；metadata 加 `desktop.workspaceMode` |
| `packages/server/src/application/channel/__test__/channel-application-service.test.ts` | 标题/metadata 用例 |
| `apps/desktop/src/renderer/src/stores/desktop-session/helpers.ts` | `isChannelSession`；`resolveSessionWorkspace` 渠道判定；`projectFromSession` 用 title |
| `apps/desktop/src/renderer/src/stores/desktop-session/selectors.ts` | `selectImSessionGroups` |
| `apps/desktop/src/renderer/src/stores/desktop-session/helpers.test.ts` / `selectors.test.ts` | 用例 |
| `apps/desktop/src/shared/channel-types.ts` | 平台显示名映射（渲染端副本） |
| `apps/desktop/src/main/features/session/session-service.ts` | 项目过滤加"渠道会话 cwd"隐藏 |
| `apps/desktop/src/renderer/.../sidebar-section-expansion.ts` + `.test.ts` | 增加 `im` |
| `apps/desktop/src/renderer/.../sidebar.tsx` | 新分区、刷新按钮、排除渠道会话、空栏不渲染 |
| `apps/desktop/src/renderer/.../sidebar.test.tsx` | 用例 |
| `docs/channels-flow.md` | 工作区路径改为项目外根；补「IM 会话」说明 |
| `docs/superpowers/specs/2026-09-20-desktop-im-sessions-design.md` | 本文件 |

历史 spec/plan/handoff 里的旧路径**不回溯修改**（在文档里注明）。

## 12. 自检

- 是否明确渠道会话不再进「项目/最近」、空时隐藏整栏？是，§6。
- 是否复用现有"项目外工作区"机制？是，§4/§5。
- 是否避免迁移旧数据？是，§2.2/§7。
- 是否有可达的刷新路径？是，§6.5（手动按钮 + 展开分区）。
- 项目隐藏在 env 覆盖下是否仍成立？是，§6.4 第 2 条。
- fork/旧会话/打开语义/展示名是否处理？是，§6.1/§6.3。
- 是否有可执行测试与验收？是，§8/§9。
