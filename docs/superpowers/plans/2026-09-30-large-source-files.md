# 超长源码整理与分阶段拆分计划

> 状态：盘点与实施计划；阶段 1 持续进行，client 命令及四处桌面界面文件已拆分。统计日期：2026-09-30。

**目标：** 降低超长源码的阅读和修改成本，同时保持现有功能、公开导出、持久化格式和事件顺序。

**范围：** 仓库中超过 600 个物理行的非测试 TypeScript、TSX、JavaScript 和样式文件。排除测试、测试夹具、构建产物、依赖目录、JSON 数据、迁移快照及 API 契约。

**统计结果：** 48 个文件。其中 Desktop 19 个，Frontend 1 个，其余包 28 个。行数只是发现线索，不是必须把每个文件压到 600 行以下的指标。

## 实施约束

- 按运行职责拆分，保留原有入口；不要为了行数增加单一实现的接口、工厂或转发层。
- 优先抽出纯转换、格式化、解析和已有的独立子组件。拥有运行状态的对象先留在原模块；需要移动状态时单独安排并验证生命周期。
- 同一职责的源码、类型和定向测试放在同一现有领域目录。新建子目录须能容纳至少两个紧密相关的文件，避免一文件一文件夹。
- 仅改变文件位置和内部组织时，保持命令输出、错误文字、事件顺序、数据库事务边界、UI 可见行为和公开导出路径。
- 每批修改前重新查看 `git status`，保留并避开其他工作中的修改；特别是当前已修改的 `main.css`、`ipc-channels.ts`、`daemon-application.ts` 和未跟踪的 `github-activity.tsx`。
- 每批只做一个可独立检查的职责拆分，先运行所在包的定向测试与类型检查；只有跨包导出、协议或应用装配变化才扩大检查范围。下文测试命令是未来实施指引，不代表已经运行。

## 建议的目录归纳

| 现有位置 | 拆分后代码应放的位置 | 边界 |
|---|---|---|
| `packages/client/src/commands/` | 同级的 `session-commands-*.ts`，原 `session-commands.ts` 保留命令入口和公开类型 | 按命令用途分组；展示函数随对应命令走，不另建通用展示框架 |
| `packages/core/src/engine/` | 同级的 `query-tool-execution.ts`、`compact-messages.ts` 等明确职责文件 | `QueryEngine` 和 `CompactService` 继续拥有运行状态及对外入口 |
| `packages/services/src/session-runtime/` | 同级的所有权、保留、投影结算、任务持久化文件；现有 `store-state.ts` 继续放状态类型 | `SessionStore` 保留外部 API；迁移文件与数据库表定义不因本计划移动 |
| `packages/server/src/application/agent/`、`session/` | 事件映射留在 `agent/`，运行准入、目标、执行与交互留在 `session/` | 不把服务端逻辑搬到 `daemon/` 或通用 `utils/` |
| `apps/desktop/src/renderer/src/components/desktop/` | 放入各页面或工具已有目录，如 `layout/main-layout/`、`tools/terminal/`、`conversation-page/`、`settings-page/` | 子组件贴近其唯一使用页面；共享组件仅在确有多个使用者时进入 `components/ui/` |
| `apps/desktop/src/renderer/src/stores/desktop-session/` | 沿用现有 `prompt-actions.ts`、`goal-actions.ts`、`session-view-actions.ts` 等同级文件 | Store 状态仍由现有入口持有；不再增加第二套状态容器 |
| `apps/desktop/src/main/features/` 与 `apps/desktop/src/shared/` | 浏览器逻辑留在 `browser/`，会话操作留在 `session/`，IPC 类型按功能留在 `shared/` | 原 IPC 常量和类型的公开导入路径保持稳定 |
| `packages/{memory,prompts,mcp,skills}/src/` | 领域内的解析、加载、存储、连接等同级文件；`index.ts` 只保留需要公开的导出 | 不用 `index.ts` 转发尚未被外部使用的私有实现 |

## 阶段 1：命令和界面的低风险拆分

先处理边界明显、已有定向测试的文件。建议第一批是 `packages/client/src/commands/session-commands.ts`：按命令用途提取处理函数，`dispatchSessionCommand` 继续作为唯一分发入口；保持 `SessionCommandHost`、`SessionCommandOutcome`、`parseSlashLine` 等导出。移动一组后运行 `packages/client/src/commands/__test__/session-commands.test.ts` 及 client 类型检查，再移动下一组。

随后处理桌面文件树、侧栏、终端及设置页。只移动真正独立的子组件及其局部状态，页面组件仍负责组合和交互。`session-actions.ts` 已有多个同级动作文件，应先检查能否将剩余动作归入这些文件，不新建一套 actions 目录。当前未跟踪的 `github-activity.tsx` 等其所属工作完成后再评估。

| 文件 | 行数 | 建议归纳 |
|---|---:|---|
| `packages/client/src/commands/session-commands.ts` | 1079 | 命令组留在 `commands/` 同级文件 |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/sidebar.tsx` | 1054 | 会话列表、项目组、归档列表留在 `main-layout/` |
| `apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx` | 1013 | 文件树、搜索、右键菜单留在 `tools/`；若相关文件持续增加，再建 `tools/files/` |
| `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts` | 950 | 导航、提示词、视图等动作归入现有同级文件 |
| `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx` | 852 | 终端生命周期与菜单子组件留在 `terminal/` |
| `apps/frontend/src/hooks/useServerSync.ts` | 801 | 沿用现有 `hooks/sync-submodules/` 拆订阅与状态同步 |
| `apps/desktop/src/renderer/src/components/desktop/conversation-page/conversation-page.tsx` | 776 | 滚动控制与消息展示留在 `conversation-page/` |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/provider-settings.tsx` | 774 | 提供商表单和列表子组件留在 `settings-page/` |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/plugin-settings.tsx` | 694 | 设置区子组件留在 `settings-page/` |
| `apps/desktop/src/renderer/src/components/desktop/settings-page/attachment-storage-settings.tsx` | 694 | 诊断、修复与展示留在 `settings-page/` |
| `apps/desktop/src/renderer/src/components/desktop/layout/main-layout/utility-panel/utility-panel.tsx` | 691 | 面板内容和控制留在 `utility-panel/` |
| `apps/desktop/src/renderer/src/components/desktop/tools/review-tool.tsx` | 669 | 审查展示与数据转换留在 `tools/` |
| `apps/desktop/src/renderer/src/components/desktop/plugin-page/mcp-manager.tsx` | 660 | 连接操作与列表留在 `plugin-page/` |
| `apps/desktop/src/renderer/src/components/ui/gridreveal.tsx` | 654 | 先确认内部是否有独立职责；单一组件可保留 |
| `apps/desktop/src/renderer/src/components/ui/github-activity.tsx` | 630 | 当前未跟踪；完成所属开发后再评估 |
| `apps/desktop/src/renderer/src/components/desktop/plugin-page/plugin-manager.tsx` | 624 | 管理操作与展示留在 `plugin-page/` |

## 阶段 2：运行引擎和长生命周期服务

这些文件含共享状态、取消、重试或资源清理。每次只移动一个无状态步骤，检查入口到结果的完整流程，再决定是否需要移动状态。重点保持：工具只执行一次、取消能及时生效、子 Agent 预算不被重建绕过、进程退出后按原顺序结算。

| 文件 | 行数 | 首个可拆边界与目录 |
|---|---:|---|
| `packages/core/src/engine/query-engine.ts` | 1530 | 工具执行及结果预算，留在 `engine/`；`submitMessage` 的轮次状态留原类 |
| `packages/core/src/engine/compact-service.ts` | 1247 | 消息截断、配对保护及 token 估算，留在 `engine/`；压缩决策留原类 |
| `packages/agent-runtime/src/child-agent.ts` | 1091 | 预算和活动事件转换，留在 `agent-runtime/src/`；子代理记录的生命周期留原管理器 |
| `packages/tools/src/agent/workflow/tool.ts` | 983 | 输入解析、时间线格式化放入现有 `agent/workflow/` |
| `packages/services/src/executions/detached-process-supervisor.ts` | 824 | 进程信号、stdin 编码等纯步骤留在 `executions/` |
| `apps/desktop/src/main/features/browser/browser-agent-service.ts` | 871 | 页面操作与开发诊断留在 `browser/` |
| `apps/desktop/src/main/features/browser/browser-developer-inspector.ts` | 780 | 诊断结果清理和敏感字段处理留在 `browser/` |
| `packages/server/src/daemon/channel-runtime-service.ts` | 724 | 通道配置、启停、投递结果处理留在 `daemon/` 或现有 `application/channel/` 所属一侧，不复制状态 |
| `packages/server/src/application/session/session-goal-service.ts` | 652 | 外部等待观察与目标动作留在 `session/` |
| `packages/mcp/src/index.ts` | 633 | 连接管理留在 `src/` 独立文件，`index.ts` 保留公开导出 |

## 阶段 3：持久化、投影和应用装配

这批风险最高，按存储事务和事件顺序逐步拆。`SessionStore` 的入口负责打开数据库、所有权检查及事务协调；具体读写可按所有权租约、保留策略、投影结算、会话任务整理到 `session-runtime/` 同级文件。不能把一个原子事务拆成多个独立提交。事件投影继续由一个入口接收 Agent 事件，纯映射与失败补偿分开放置；补偿必须沿用现有结算记录。应用装配可按现有服务域提取创建函数，但启动与关闭顺序仍由 `DaemonApplication` 明确控制。

| 文件 | 行数 | 建议归纳 |
|---|---:|---|
| `packages/services/src/session-runtime/store.ts` | 1487 | 租约、保留、投影结算、任务持久化留在 `session-runtime/` |
| `packages/server/src/application/daemon-application.ts` | 1208 | 按现有 `application/` 服务域整理装配，保留应用入口 |
| `packages/server/src/application/agent/daemon-agent-event-projector.ts` | 1063 | 事件转换和失败补偿留在 `application/agent/` |
| `packages/services/src/conversations/conversation-transactions.ts` | 972 | 提示词准入、转录替换、会话树操作留在 `conversations/` |
| `packages/server/src/application/session/run-admission-service.ts` | 709 | 准入、steer、持久化运行留在 `application/session/` |
| `packages/server/src/jobs/daemon-job-service.ts` | 671 | Job 数据展示转换与运行操作留在 `jobs/` |
| `packages/server/src/application/auto-review/git-run-change-inspector.ts` | 668 | Git 输出解析与变更组装留在 `auto-review/` |
| `packages/coordinator/src/workflow/store.ts` | 637 | Workflow 记录读写留在 `workflow/` |
| `packages/server/src/application/session/transcript-projection.ts` | 625 | 转录事件转换留在 `application/session/` |
| `packages/server/src/application/session/session-run-executor.ts` | 619 | 自动评审步骤与运行收尾留在 `application/session/` |
| `packages/server/src/application/session/session-interaction-service.ts` | 605 | 按交互入口整理，仍留在 `application/session/` |

## 阶段 4：定义、资源入口与样式

这些文件的长主要来自声明和样式，拆分收益需结合查找体验判断。不强求拆分：如果按概念定位已经清楚，保留原文件更简单。确需拆分时，保持原公开导出，并用类型检查及公开 API 检查确认兼容。

| 文件 | 行数 | 建议归纳 |
|---|---:|---|
| `packages/memory/src/index.ts` | 958 | 文件格式解析、存储和检索放同包文件，入口只导出公共 API |
| `packages/prompts/src/index.ts` | 939 | 个人提示词文件检查与系统提示词组装放同包文件 |
| `apps/desktop/src/renderer/src/assets/main.css` | 934 | 按现有页面样式归类；先核对选择器覆盖及加载顺序 |
| `apps/desktop/src/shared/ipc-channels.ts` | 925 | IPC 常量与调用映射按现有功能域归类，保留原导出 |
| `packages/protocol/src/session.ts` | 835 | 会话、运行、事件类型按概念分文件；协议语义不变 |
| `packages/core/src/types/runtime.ts` | 738 | 请求配置、子代理、事件类型按概念分文件 |
| `apps/desktop/src/main/features/session/session-operations.ts` | 726 | 项目操作与会话操作留在 `features/session/` |
| `packages/client/src/types/index.ts` | 690 | 按资源或请求类型归类，保留对外类型入口 |
| `packages/services/src/session-runtime/schema.ts` | 685 | 数据库表定义可以保留；如拆分，迁移产物及表名不能改变 |
| `packages/skills/src/index.ts` | 638 | 注册、解析、加载放同包文件，保留公共导出 |
| `packages/tools/src/file/operations.ts` | 628 | 按文件操作类别整理，仍留在 `file/` |

## 每批的验收方法

1. 记录原文件的公开导出、调用者和定向测试；确认工作区未提交改动是否与本批重叠。
2. 移动一个完整职责，保持旧入口和外部调用不变。比较变更前后的输出、错误、事件和状态写入顺序。
3. 运行该模块定向测试及包类型检查。涉及客户端公开类型时加 `pnpm check:client-api`；涉及持久化或跨模块事件时加对应集成测试。
4. 复查 diff 中是否只有组织变化；若出现行为变化，将其作为独立任务处理。更新本文阶段状态和实际目录。

本计划不以删除固定行数为目标，也不在没有调用证据时声称代码可删。ponytail 的收敛顺序是：先看能否沿用现有模块，再考虑纯函数抽取，最后才增加新文件或目录。

## 执行记录

### 2026-09-30：阶段 1，client 命令

- `packages/client/src/commands/session-commands.ts` 从盘点时的 1079 行降至 527 行，保留 `dispatchSessionCommand` 和原公开类型、函数。
- Job、记忆与环境事实、诊断、配置命令分别归入同一 `commands/` 目录下的 `job-commands.ts`、`knowledge-commands.ts`、`diagnostic-commands.ts`、`settings-commands.ts`。展示回调仍由原入口提供，避免改变各宿主的呈现方式。
- 验证：client 包 Vitest 共 12 个文件、132 条测试通过；client `tsc --noEmit` 通过；`git diff --check` 无空白错误。client 的公开 API 契约测试包含在上述测试中。
- 阶段 1 的桌面界面文件仍按上表逐批处理，尤其避开当前工作区正在修改的文件。

### 2026-09-30：阶段 1，桌面文件工具

- `apps/desktop/src/renderer/src/components/desktop/tools/files-tool.tsx` 从盘点时的 1013 行降至 540 行，仍负责文件加载、选择预览和页面组合。
- 文件树及其右键菜单、面包屑路径、文件内搜索控件分别放在同级 `tools/files/` 目录的 `project-file-tree.tsx`、`file-breadcrumb.tsx`、`file-search-controls.tsx`。组件内部逻辑与外部属性保持原样。
- 验证：桌面 Web 类型检查通过；桌面 Vitest 共 207 个文件、1319 条测试通过。现有测试没有直接覆盖 `FilesTool` 的完整交互，本批属于代码原样搬移，未改变其状态管理。

### 2026-09-30：阶段 1，桌面侧栏与提供商设置

- `sidebar.tsx` 从 1054 行降至 553 行；会话／项目列表归入同目录 `sidebar-session-groups.tsx`，导航控件归入 `sidebar-controls.tsx`。侧栏入口仍负责读取 Store 状态、页面组合与弹窗。
- `provider-settings.tsx` 从 774 行降至 376 行；供应商列表、更多供应商弹窗和展示辅助函数归入同目录 `provider-settings-list.tsx`。认证和保存状态仍在原页面。
- 验证：相关交互测试 4 个文件、27 条通过；桌面 Web 类型检查通过。初次类型检查发现两处跨文件引用遗漏，补齐导出与导入后重新检查通过。

### 2026-09-30：阶段 1，附件存储与插件设置

- `attachment-storage-settings.tsx` 从 694 行降至 394 行；概览、健康检查与维护行归入同目录 `attachment-storage-view.tsx`。扫描、修复、清理和反馈状态仍在原页面。
- `plugin-settings.tsx` 从 694 行降至 375 行；插件行、详情弹窗与展示辅助函数归入同目录 `plugin-settings-content.tsx`。原 `PluginDetailsDialog` 导出路径保持可用。
- 验证：桌面 Web 类型检查通过；附件设置与插件管理测试共 2 个文件、27 条通过。
- `terminal-tool.tsx` 的主要行数来自一个共享大量生命周期状态的组件；只抽出右键菜单不能有效降低理解成本。继续处理它之前，应先明确终端事件、附着与清理的状态边界。

### 2026-09-30：阶段 1，代码审查工具

- `review-tool.tsx` 从 669 行降至 294 行，保留 Git 改动读取、范围选择和当前文件状态；列表、diff 视图及展示辅助函数归入同目录 `review-tool-view.tsx`。
- 验证：桌面 Web 类型检查通过；代码审查工具交互测试 2 条通过。

### 2026-09-30：阶段 2，工作流工具

- `packages/tools/src/agent/workflow/tool.ts` 从 983 行降至 540 行，继续负责动作分发、运行及仓库访问。输入解析与校验移到同目录 `input.ts`，时间线、历史、模板和校验结果的格式化移到 `presentation.ts`。
- 拆分时发现原 `secondsToMs` 函数没有调用者，已删除。首次检查发现 `parsePermissionMode` 跨文件导入遗漏，补齐后重新验证通过。
- 验证：tools 包类型检查通过；完整 Vitest 共 37 个文件，444 条通过、1 条原有跳过。

### 2026-09-30：记忆模块的独立整理

- `packages/memory/src/index.ts` 从 958 行降至 579 行，继续提供 `MemoryManager` 和原公开导出。类型、常量、分词、签名、Markdown 记录解析／渲染、记录与元数据转换及 `MEMORY.md` 截断归入同包 `memory-format.ts`。
- 这项原列在阶段 4；因格式处理与管理器之间已有清楚的纯函数边界，提前独立执行，没有改动数据格式或存储顺序。
- 验证：memory 包类型检查通过；完整 Vitest 共 3 个文件、59 条通过。

### 2026-10-01：个人提示词文件

- `packages/prompts/src/index.ts` 从 939 行降至 547 行，保留系统提示词组装及全部原公开导出。个人提示词文件的扫描、初始化、读取、追加及待批准更新归入同包 `personal-prompt-files.ts`。
- 验证：prompts 包类型检查通过；完整 Vitest 共 2 个文件、54 条通过。

### 2026-10-01：技能 Markdown 解析

- `packages/skills/src/index.ts` 从 638 行降至 469 行；Frontmatter 和正文元数据解析归入同包 `parse-skill-markdown.ts`，原函数和类型继续从 `index.ts` 导出。注册表、目录加载与来源覆盖顺序保持在原文件。
- 验证：skills 包类型检查通过；完整 Vitest 共 1 个文件、50 条通过。

### 2026-10-01：压缩服务的确定性消息处理

- `packages/core/src/engine/compact-service.ts` 从 1247 行降至 896 行；工具结果清理、文本折叠、按轮截断、工具调用配对切分、图片占位、边界标记和 token 估算归入同目录 `compact-messages.ts`。原公开方法保留，服务类继续控制压缩顺序、摘要模型调用和检查点。
- 删除两个没有调用者的旧工具 ID 辅助函数。抽取中修复了一处多行返回类型的机械搬移错误，随后重新验证。
- 验证：core 包类型检查通过；完整 Vitest 共 31 个文件、306 条通过。

### 2026-10-01：服务端 Job 结果转换

- `packages/server/src/jobs/daemon-job-service.ts` 从 671 行降至 422 行，保留列表、读取、等待、发送和取消的入口。终端／任务／工作流快照及输出转换归入 `jobs/job-snapshots.ts`，持久化子任务活动读取归入 `jobs/child-activity.ts`。
- `readPersistedChildActivity` 和 `ChildActivityReader` 仍从原模块导出，保持已有调用路径。
- 验证：server 包类型检查通过；Job 服务定向测试 26 条通过。

### 2026-10-01：自动评审 Git 输出解析

- `packages/server/src/application/auto-review/git-run-change-inspector.ts` 从 668 行降至 442 行，继续负责调用 Git、读取仓库状态及比对运行前后。NUL 分隔输出解析、路径规范化、状态映射和补丁组装归入同目录 `git-change-parsing.ts`；原 `GIT_PATCH_LIMIT_BYTES` 导出路径保留。
- 验证：server 包类型检查通过；Git 改动检查 24 条真实仓库测试与自动评审 8 条集成测试通过。

### 2026-10-01：浏览器开发者诊断

- `browser-developer-inspector.ts` 从 780 行降至 585 行，保留诊断会话、事件监听和采集状态。DOM／网络结果脱敏与大小限制归入同目录 `browser-developer-projection.ts`，HTTP 和工作区文件的作用域校验归入 `browser-developer-scope.ts`；原 `sanitizeUrl`、`resolveDeveloperScope` 等公开路径保留。
- 初次检查发现检查器仍使用已搬出的 DOM 深度常量和作用域函数，补齐本地导入后重新验证。
- 验证：桌面 Node 类型检查通过；浏览器诊断与服务测试共 2 个文件、56 条通过。
