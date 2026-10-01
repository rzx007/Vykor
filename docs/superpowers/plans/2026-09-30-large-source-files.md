# 超长源码整理与分阶段拆分计划

> 状态：分阶段持续实施。初次盘点 2026-09-30；最近一次复盘 2026-10-01。

**目标：** 降低超长源码的阅读和修改成本，同时保持现有功能、公开导出、持久化格式和事件顺序。

**当前实施范围：** `packages/` 中超过 600 个物理行的非测试源码。`apps/desktop/` 和 `apps/frontend/` 不再处理；原盘点和已完成记录保留为历史。继续排除测试、测试夹具、构建产物、依赖目录、JSON 数据、迁移快照及 API 契约。

**统计结果：** 初次 48 个文件，其中 Desktop 19 个、Frontend 1 个、其余包 28 个；2026-10-01 全仓复盘剩余 20 个，按当前范围剩余 8 个。行数只是发现线索，不是必须把每个文件压到 600 行以下的指标。

## 实施约束

- 按运行职责拆分，保留原有入口；不要为了行数增加单一实现的接口、工厂或转发层。
- 优先抽出纯转换、格式化、解析和已有的独立子组件。拥有运行状态的对象先留在原模块；需要移动状态时单独安排并验证生命周期。
- 同一职责的源码、类型和定向测试放在同一现有领域目录。新建子目录须能容纳至少两个紧密相关的文件，避免一文件一文件夹。
- 仅改变文件位置和内部组织时，保持命令输出、错误文字、事件顺序、数据库事务边界、UI 可见行为和公开导出路径。
- 每批修改前重新查看 `git status`，保留并避开其他工作中的修改；不要依据初次盘点时的工作区状态判断文件归属。
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

## 2026-10-01 剩余清单与下一轮选择

以下只列当前范围内超过 600 行的 8 个非测试文件。早期阶段表格仍保留初始全仓盘点，不表示桌面端或 `apps/frontend` 继续在实施范围内。数字是本次扫描的物理行数；“先观察”不是永不拆分，而是需要先证明独立职责或测试保护，不为过线数字增加包装层。

| 下一轮处理 | 文件与当前行数 | 判断依据 |
|---|---|---|
| 继续按职责拆 | `packages/core/src/engine/query-engine.ts` 1156；`packages/agent-runtime/src/child-agent.ts` 836；`packages/services/src/session-runtime/store.ts` 875；`packages/services/src/conversations/conversation-transactions.ts` 784 | 已有同目录子模块，下一批仍应一次移动一个完整职责，保留引擎轮次、子代理预算和存储事务边界 |
| 先做流程边界检查 | `packages/server/src/application/agent/daemon-agent-event-projector.ts` 1063；`packages/services/src/executions/detached-process-supervisor.ts` 691 | 都持有长期状态；只抽有明确输入输出的步骤，重点测试取消、重连与失败收尾 |
| 先观察，暂不按行数硬拆 | `packages/server/src/application/daemon-application.ts` 1213；`packages/services/src/session-runtime/schema.ts` 685 | 前者是有顺序的应用装配，后者主要是数据库表声明；只有出现可验证的维护边界时再整理 |

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

### 2026-10-01：文件工具的 Host 搜索辅助

- `packages/tools/src/file/operations.ts` 从 628 行降至 509 行；Host 上的 ripgrep 查找、参数构造、输出过滤和 glob 正则转换归入同目录 `host-search.ts`，原 `globToRegex` 导出路径保留。Host／WSL 文件读写和回退搜索仍在原模块。
- 删除没有调用者的内嵌文件助手脚本。初次检查发现 Host glob 仍需要 `existsSync`，恢复导入后重新验证。
- 验证：tools 包类型检查通过；完整 Vitest 共 37 个文件，444 条通过、1 条原有跳过。

### 2026-10-01：子代理预算注册表

- `packages/agent-runtime/src/child-agent.ts` 从 1091 行降至 955 行；共享子代理索引、深度／并发／累计预算的预留和释放归入同包 `child-registry.ts`。原 `AgentChildRegistry` 与默认预算的导出路径保留，管理器继续持有子代理运行和关闭状态。
- 验证：agent-runtime 包类型检查通过；完整 Vitest 共 37 个文件、349 条通过。

### 2026-10-01：脱离会话进程辅助

- `packages/services/src/executions/detached-process-supervisor.ts` 从 824 行降至 692 行；环境进程适配、输入帧编码、进程退出等待和进程树终止归入同目录 `process-support.ts`。主类仍管理任务状态、重启和监听器。
- 验证：services 包类型检查通过；相关执行测试 3 个文件、42 条通过，包括真实进程树终止。

### 2026-10-01：工作流持久化解码

- `packages/coordinator/src/workflow/store.ts` 从 637 行降至 502 行；快照与事件的 JSON 解码和字段校验归入同目录 `store-decoding.ts`，原公开导出保持可用。文件存储、运行取消及活动运行索引仍在原模块。
- 验证：coordinator 包类型检查通过；完整 Vitest 共 6 个文件、107 条通过。

### 2026-10-01：SessionStore 的 SQL 落盘

- `packages/services/src/session-runtime/store.ts` 从 1487 行降至 1166 行；变更集合的删除与逐表写入归入同目录 `store-persistence.ts`。`TransactionCoordinator` 仍通过原 `persistChanges()` 回调在同一事务中执行，活动状态与回滚仍由 `SessionStore` 管理。
- 初次完整测试发现事务协调器测试依赖原私有入口；保留薄入口委托后重新验证。
- 验证：services 包类型检查通过；完整 Vitest 共 44 个文件、442 条通过。

### 2026-10-01：会话树事务

- `packages/services/src/conversations/conversation-transactions.ts` 从 972 行降至 784 行；复制历史创建分支会话、删除会话树与树遍历归入同目录 `conversation-tree-operations.ts`。原类方法保留入口，事务仍在这些操作内部开始，测试钩子和提示词准入回调按调用时的当前值传入。
- 验证：services 包类型检查通过；会话事务与 SessionStore 测试共 2 个文件、121 条通过。

### 2026-10-01：桌面新会话首条提交

- `apps/desktop/src/renderer/src/stores/desktop-session/session-actions.ts` 从 950 行降至 581 行；新会话创建、首条提示词提交和草稿清理／恢复归入同目录 `start-session-action.ts`。原 Store 动作入口不变，导航代数和打开会话回调在调用时传入。
- 验证：桌面 Web 类型检查通过；会话动作、提示词动作和 Store 集成测试共 3 个文件、84 条通过。

### 2026-10-01：QueryEngine 工具调用准备

- `packages/core/src/engine/query-engine.ts` 从 1530 行降至 1465 行；重复失败拦截、工具查找、输入规范化及校验归入同目录 `query-tool-preparation.ts`。权限判断、钩子、执行并发及结果回填仍在原调用顺序中。
- 抽取时修正新文件的一处注册表类型别名；随后通过类型检查和完整 core 测试（31 个文件、306 条）。

### 2026-10-01：服务端运行准入工作段

- `packages/server/src/application/session/run-admission-service.ts` 从 709 行降至 488 行；已接收输入的持久化、恢复、steer 物化及投递失败收尾归入同目录 `run-admission-work.ts`。主服务保留停机检查、目标优先级及同 ID 请求的在途去重。
- 在隔离工作区先构建 `@vykor/agent-runtime` 声明文件后，server 类型检查通过；完整 Vitest 共 121 个文件、1183 条通过。

### 2026-10-01：SessionStore 保留策略与审计

- `packages/services/src/session-runtime/store.ts` 从 1166 行降至 1024 行；已结束记录的保留期清理及审计读写归入同目录 `session-retention.ts`。原方法和默认策略导出保持可用，所有权检查仍在 `SessionStore` 入口，清理和审计仍在同一个数据库事务中完成。
- 验证：services 包类型检查通过；完整 Vitest 共 44 个文件、442 条通过。

### 2026-10-01：SessionStore 投影结算

- `packages/services/src/session-runtime/store.ts` 从 1024 行降至 876 行；结算记录的创建、查询、重试、失败、解决和放弃，以及数据库行转换归入同目录 `projection-settlements.ts`。原方法保留，在写操作前继续检查 Application Owner。
- 验证：services 包类型检查通过；完整 Vitest 共 44 个文件、442 条通过。

### 2026-10-01：桌面主进程会话操作辅助

- `apps/desktop/src/main/features/session/session-operations.ts` 从 726 行降至 501 行；会话输入和权限／供应商校验归入 `session-operation-input.ts`，项目 Git 命令及项目信息转换归入 `project-operations-support.ts`。原公开辅助函数仍从 `session-operations.ts` 导出。
- 隔离工作区的 Electron 依赖未执行安装脚本，测试时复用主工作区已有 Electron 路径；桌面 Node 类型检查与相关测试 2 个文件、18 条通过。

### 2026-10-01：协议会话类型归类

- `packages/protocol/src/session.ts` 从 835 行降至 270 行，保留基础会话、消息、运行记录和原导出路径。模型重试／用量解析归入 `session-model.ts`，定时任务类型归入 `scheduled.ts`，创建与查询请求类型归入 `session-requests.ts`。
- 验证：protocol 包类型检查及完整 Vitest 13 个文件、146 条通过；全仓 `pnpm check-types` 61 项通过。

### 2026-10-01：Core 运行类型归类

- `packages/core/src/types/runtime.ts` 从 738 行降至 409 行；子代理输入、预算、句柄和错误类归入 `runtime-child.ts`，Agent 运行事件及订阅类型归入 `runtime-events.ts`。原 `runtime.ts` 重导出这些成员，运行配置和 `RuntimeBundle` 留在原文件。
- 验证：core 包类型检查与完整 Vitest 31 个文件、306 条通过；全仓 `pnpm check-types` 61 项通过。

### 2026-10-01：Client 公开类型归类

- `packages/client/src/types/index.ts` 从 690 行降至 442 行；附件存储类型归入 `attachment-types.ts`，插件／技能／Agent 信息归入 `extension-types.ts`，会话同步状态归入 `sync-types.ts`。原入口重导出所有成员，client 的公开 API 形状保持不变。
- 验证：client 包类型检查及完整 Vitest 12 个文件、132 条通过（含公开 API 契约）；全仓 `pnpm check-types` 61 项通过。

### 2026-10-01：QueryEngine 工具权限与执行前钩子

- `packages/core/src/engine/query-engine.ts` 从 1465 行降至 1355 行；并行权限检查、用户确认和执行前钩子归入同目录 `query-tool-permissions.ts`，与既有 `query-tool-preparation.ts` 顺序相接。实际工具执行、执行后钩子及结果回填仍由引擎持有。
- 验证：core 包类型检查通过；完整 Vitest 共 31 个文件、306 条通过。

### 2026-10-01：压缩服务摘要流程与类型

- `packages/core/src/engine/compact-service.ts` 从 896 行降至 592 行；摘要提示词与上下文拼装归入 `compact-prompt.ts`，流式摘要收集、格式化及超窗错误识别归入 `compact-summary.ts`，公开类型归入 `compact-types.ts`。原公开导出路径保留，压缩服务继续控制重试、检查点和消息替换。
- 验证：core 包完整 Vitest 共 31 个文件、306 条通过；全仓 `pnpm check-types` 61 项通过。

### 2026-10-01：服务端运行自动审查

- `packages/server/src/application/session/session-run-executor.ts` 从 619 行降至 537 行；自动审查的基线获取、已完成运行审查和未审查运行收尾归入同目录 `run-auto-review.ts`。原执行器仍控制调用顺序和运行状态结算。
- 验证：server 包类型检查通过；运行执行器及装配测试共 2 个文件、17 条通过。

### 2026-10-01：会话记录中图片元数据解析

- `packages/server/src/application/session/transcript-projection.ts` 从 625 行降至 583 行；工具结果中的图片资产字段校验归入同目录 `transcript-image-metadata.ts`。投影器仍决定何时写入消息部件及发送事件。
- 验证：server 包类型检查通过；会话记录投影测试 25 条通过。

### 2026-10-01：MCP 连接配置与类型

- `packages/mcp/src/index.ts` 从 633 行降至 554 行；传输方式校验、连接描述和准备／激活结果类型归入同目录 `connection-types.ts`。原包入口继续重导出这些公开成员，连接管理器仍负责连接、切换和资源调用。
- 验证：MCP 包类型检查通过；完整 Vitest 共 10 个文件、156 条通过。

### 2026-10-01：目标外部等待观察器

- `packages/server/src/application/session/session-goal-service.ts` 从 652 行降至 580 行；外部任务等待的定时器、重试、完成后续跑派发与失败暂停归入同目录 `goal-external-wait-observer.ts`。目标服务仍决定何时开始或清除观察，恢复运行的输入构造复用原方法。
- 验证：server 包类型检查通过；目标服务、等待校验和派发事件测试共 3 个文件、28 条通过。

### 2026-10-01：会话交互类型归类

- `packages/server/src/application/session/session-interaction-service.ts` 从 605 行降至 553 行；依赖接口及编辑、恢复、排队命令的输入／结果类型归入同目录 `session-interaction-types.ts`。原服务模块继续重导出这些类型，运行操作和纯辅助函数保留在服务中。
- 首次类型检查发现返回类型仍引用 `RunControlService`，补回类型导入后验证通过；交互服务测试 9 条通过。

### 2026-10-01：桌面浏览器页面检查与结果限额

- `apps/desktop/src/main/features/browser/browser-agent-service.ts` 从 871 行降至 721 行；注入页面的检查脚本、页面变化等待和指纹归入 `browser-page-inspection.ts`，开发者检查结果的大小限制归入 `browser-developer-result-limits.ts`。浏览器服务仍持有标签页、导航及操作队列状态。
- 验证：桌面 Node 类型检查通过；浏览器服务与开发者检查相关测试共 3 个文件、64 条通过。

### 2026-10-01：QueryEngine 模型请求辅助

- `packages/core/src/engine/query-engine.ts` 从 1355 行降至 1268 行；单次模型请求的取消／截止时间信号、失败分类和结束事件构造归入同目录 `query-model-attempt.ts`。用量累加仍由引擎持有，避免改变请求结算点。
- 首次类型检查发现压缩客户端回调仍引用 `ModelAttemptFinishedEvent`，补回类型导入后通过；core 完整 Vitest 共 31 个文件、306 条通过。

### 2026-10-01：QueryEngine 工具限制规则

- `packages/core/src/engine/query-engine.ts` 从 1268 行降至 1205 行；输出截断阈值、超时配置与超时错误归入同目录 `query-tool-limits.ts`。引擎在原位置应用限制，工具结果及图片块处理顺序不变。
- 验证：core 包类型检查通过；完整 Vitest 共 31 个文件、306 条通过。

### 2026-10-01：本轮统一验收与已知测试问题

- 全仓 `pnpm check-types`：61 项通过。server 完整 Vitest：121 个文件、1183 条通过。MCP 完整 Vitest：10 个文件、156 条通过。core 完整 Vitest：31 个文件、306 条通过。
- desktop 完整 Vitest：207 个文件中 206 个通过，1320 条中 1319 条通过。唯一失败是 `project-actions.test.ts` 的恢复会话用例；单独复跑仍报 `document is not defined`。调用来自本轮拆分前已有的 `bootstrap-actions.ts` → `startup-overlay.ts` 默认参数，不在本轮改动路径内；本计划不顺带修改该功能。浏览器相关定向测试 64 条通过，桌面 Node 类型检查通过。

### 2026-10-01：桌面终端展示辅助

- `apps/desktop/src/renderer/src/components/desktop/tools/terminal/terminal-tool.tsx` 从 852 行降至 706 行；右键菜单归入同目录 `terminal-context-menu.tsx`，标签名称、坐标、会话匹配和错误文案归入 `terminal-display.ts`。终端连接、事件订阅及生命周期仍由主组件管理，原公开 `TerminalSessionTabInfo` 导出保留。
- 首次桌面 Web 类型检查发现之前 client 类型归类留下未使用的 `AdmitPromptInput` 导入，移除后通过；终端相关定向测试 3 个文件、4 条通过。此批尚未重跑含上述既有失败用例的桌面完整套件。

### 2026-10-01：实施范围收敛

- 按用户决定，后续不再处理 `apps/desktop/` 和 `apps/frontend/`；此前已完成的拆分和测试记录保留，不撤销现有提交。当前只推进 `packages/`，超过 600 行的待评估文件为 9 个。

### 2026-10-01：子代理活动投影

- `packages/agent-runtime/src/child-agent.ts` 从 955 行降至 836 行；可信事件的最近活动投影、文本限额及未完成结果提取归入同目录 `child-activity.ts`。管理器仍负责事件订阅、子代理预算、运行与关闭。
- 验证：agent-runtime 包类型检查通过；完整 Vitest 共 37 个文件、349 条通过。

### 2026-10-01：渠道运行连接类型

- `packages/server/src/daemon/channel-runtime-service.ts` 从 724 行降至 646 行；应用端口、附件下载、运行时句柄、创建参数和配置类型归入同目录 `channel-runtime-types.ts`，旧模块继续重导出公开类型。运行服务继续控制连接状态和启停顺序。
- 首次类型检查发现内部状态类型仍需原位导入，补回后通过；渠道相关测试 4 个文件、74 条通过。

### 2026-10-01：渠道连接器装配

- `packages/server/src/daemon/channel-runtime-service.ts` 从 646 行降至 577 行；实际飞书适配器、消息总线和持久投递桥的组装归入同目录 `channel-runtime-factory.ts`。服务仍持有连接状态、串行启停与回调处理。
- 验证：server 包类型检查通过；渠道相关测试 4 个文件、74 条通过。

### 2026-10-01：QueryEngine 工具执行超时

- `packages/core/src/engine/query-engine.ts` 从 1205 行降至 1156 行；不依赖引擎状态的取消信号、截止时间和工具超时竞赛归入既有 `query-tool-limits.ts`。引擎仍创建工具上下文、运行钩子并回填结果，没有新增目录或包装类。
- 验证：core 包类型检查通过；完整 Vitest 共 31 个文件、306 条通过。
