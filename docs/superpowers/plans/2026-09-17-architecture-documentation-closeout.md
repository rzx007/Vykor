# 架构重构文档收口实现计划

> **面向 AI 代理的工作者：** 必需子技能：使用 superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans 逐任务实现此计划。步骤使用复选框（`- [ ]`）语法来跟踪进度。

**目标：** 把 Stage 0–8 重构后的真实代码边界写回当前权威文档、根 README、文档目录和可交互架构图，同时把迁移材料明确降为历史记录。

**架构：** 先从当前导出、应用服务、Repository、检查脚本和测试建立事实清单，再分别收口“最终状态”“当前运行架构”“使用入口”三层文字。独立架构图只修改 Archify JSON 图源，并由该图源重新生成 HTML、检查页和截图，历史计划正文不重写。

**技术栈：** Markdown、Mermaid、Archify architecture JSON/HTML、PowerShell、ripgrep、Node.js 文档与架构检查脚本、Git。

---

## 文件结构

### 创建

- `docs/session-runtime-storage-architecture.md`：当前 SQLite、Repository、Transaction、`SessionStore` 和运行时协调边界的权威说明。

### 修改

- `docs/architecture-migration-status.md`：从阶段状态页改为 Stage 0–8 最终收口记录。
- `docs/architecture-overview.md`：更新全局分层、依赖方向和继续阅读入口。
- `docs/daemon-application-architecture.md`：校准 route、应用服务、Runner、Repository、Runtime 和协议版本。
- `docs/client-sync-flow.md`：校准领域 Resource、握手、snapshot、SSE、checkpoint 和可靠重试责任。
- `docs/session-storage-design.md`：仅在历史状态栏补当前存储文档链接，不改历史正文。
- `docs/README.md`：重排当前架构、操作手册、验证入口与历史记录。
- `README.md`：更新项目目录、架构摘要、模块表和客户端调用流程。
- `docs/openharness-current-architecture.architecture.json`：独立架构图唯一可编辑图源。
- `docs/openharness-current-architecture.html`：由 Archify 从图源重新生成。
- `docs/openharness-current-architecture.visual-check.html`：由 visual-check 重新生成的联系表。
- `docs/openharness-current-architecture.visual-check.json`：由 visual-check 重新生成的检查结果。
- `docs/openharness-current-architecture.visual-check.1440x900.light.png`
- `docs/openharness-current-architecture.visual-check.1440x900.dark.png`
- `docs/openharness-current-architecture.visual-check.2048x1320.light.png`
- `docs/openharness-current-architecture.visual-check.2048x1320.dark.png`

### 只读事实来源

- `packages/client/src/index.ts`
- `packages/client/src/resources/*.ts`
- `packages/client/src/transport/*.ts`
- `packages/client/src/state/*.ts`
- `packages/server/src/application/daemon-application.ts`
- `packages/server/src/application/session/*.ts`
- `packages/services/src/session-runtime/store.ts`
- `packages/services/src/database/storage-context.ts`
- `packages/services/src/database/transaction-coordinator.ts`
- `packages/services/src/{sessions,conversations,runs,projects,channels,permissions,goals,attachments,schedules,workflows}/*.ts`
- `packages/services/src/session-runtime/migrations/0000_current_schema.sql`
- `packages/services/src/session-runtime/migrations/meta/_journal.json`
- `packages/protocol/src/**/*.ts`
- `scripts/architecture-boundaries.mjs`
- `scripts/verify-clean-slate.mjs`
- `scripts/check-docs.mjs`

## 任务 1：建立当前事实清单并完成 Stage 0–8 收口页

**文件：**
- 修改：`docs/architecture-migration-status.md`
- 参考：`docs/superpowers/specs/2026-09-14-business-domain-codebase-reorganization-design.md`
- 参考：`docs/superpowers/specs/2026-09-16-clean-slate-compatibility-removal-design.md`
- 参考：`docs/superpowers/plans/2026-09-16-clean-slate-compatibility-removal.md`
- 参考：上述只读代码和检查脚本

- [ ] **步骤 1：记录可复核的当前事实**

运行：

```powershell
rg -n "readonly (projects|channels|permissions|sessions|runs)|new (Project|Channel|Permission|Session|Run|Attachment|Goal)Repository" packages/services/src/session-runtime/store.ts
rg -n "SessionOperationRunner|SessionQueryService|SessionCommandService|SessionInteractionService|RunControlService" packages/server/src/application
rg -n "PROTOCOL_VERSION|x-openharness-protocol-version" packages scripts
Get-ChildItem packages/services/src/session-runtime/migrations -File -Recurse | Select-Object FullName
```

预期：能直接确认领域 Repository、应用服务、协议版本 4 和单 migration 基线；不要从旧计划复选框推断完成状态。

- [ ] **步骤 2：重写收口页结构**

正文按以下固定顺序编写：

```text
状态与用途
Stage 0–8 完成矩阵
当前四层边界
协议与数据基线
明确删除的兼容面
长期架构门禁
开发数据重置边界
当前文档与历史依据
```

Stage 矩阵每行只写“目标、最终结果、证据入口”，不重新展开实施步骤，也不保留“下一阶段”。

- [ ] **步骤 3：搜索迁移时态和未经证明的结论**

运行：

```powershell
rg -n "下一步|未开始|计划进行|等待下一|兼容发行|双发行" docs/architecture-migration-status.md
rg -n "check:architecture|check:clean-slate|test:clean-slate|check-docs" package.json docs/architecture-migration-status.md
```

预期：第一条无匹配；第二条中的命令名称与 `package.json` 完全一致。

- [ ] **步骤 4：验证并提交任务 1**

运行：

```powershell
node scripts/check-docs.mjs
git diff --check
git add docs/architecture-migration-status.md
git commit -m "docs: close out architecture reorganization stages"
```

预期：文档检查和 diff 检查退出码均为 0；提交只包含收口页。

## 任务 2：建立当前存储架构并校准核心运行文档

**文件：**
- 创建：`docs/session-runtime-storage-architecture.md`
- 修改：`docs/session-storage-design.md`
- 修改：`docs/architecture-overview.md`
- 修改：`docs/daemon-application-architecture.md`
- 修改：`docs/client-sync-flow.md`
- 参考：`packages/services/src/session-runtime/store.ts`
- 参考：`packages/services/src/database/storage-context.ts`
- 参考：`packages/services/src/database/transaction-coordinator.ts`
- 参考：`packages/server/src/application/session/*.ts`
- 参考：`packages/client/src/{resources,transport,state}/*.ts`

- [ ] **步骤 1：列出 Store、Repository 和 Transaction 的实际所有权**

运行：

```powershell
rg -n "^export class|^export interface|^  readonly |^  async |^  [a-zA-Z].*\(" packages/services/src/session-runtime/store.ts packages/services/src/database packages/services/src/sessions packages/services/src/conversations packages/services/src/runs packages/services/src/projects packages/services/src/channels packages/services/src/permissions packages/services/src/goals packages/services/src/attachments
```

预期：得到真实类型和入口；文档只使用搜索结果中存在的名称。

- [ ] **步骤 2：创建当前存储架构文档**

`docs/session-runtime-storage-architecture.md` 必须包含：

```text
状态与适用范围
入口：SessionStore 的创建和公开组合
Repository 职责表
Transaction 与跨领域原子操作
数据库生命周期、owner lease 和启动恢复
waiter/listener 与事件注册等运行时协调
单 migration 与不读取旧数据库的边界
新增持久化功能的放置判断树
测试与长期门禁
```

判断树必须明确：单领域 CRUD 进入对应 Repository；跨领域原子写进入 transaction 模块；数据库开关、lease、恢复和连接级能力进入 Store；HTTP/运行编排不得进入 services 存储层。

- [ ] **步骤 3：只更新历史存储文档的指向**

在 `docs/session-storage-design.md` 开头的历史状态栏增加 `session-runtime-storage-architecture.md` 链接。不要改写后面的旧 JSON snapshot 背景、决策或测试记录。

- [ ] **步骤 4：校准全局架构与 daemon 主链路**

更新 `docs/architecture-overview.md` 和 `docs/daemon-application-architecture.md`，统一使用：

```text
Product Surface -> Client Resource -> HTTP Route
-> Query / Command / Interaction / Run Control
-> SessionOperationRunner
-> Repository + Transaction
-> Agent Runtime（只负责 live execution）
```

Mermaid 和示例中的协议版本必须是 4。说明入口、关键步骤、状态位置和结果返回，不把 `DaemonApplication` 或 `SessionStore` 描述成所有业务逻辑的实现体。

- [ ] **步骤 5：校准 Client 同步文档**

从 `packages/client/src/index.ts` 和 `packages/client/src/resources/session-resource.ts` 核实公开入口，将业务示例写成 `client.sessions.*` 等领域 Resource。明确首个业务请求前的协议握手、snapshot 基线、SSE 增量、checkpoint 恢复、reducer 合并和稳定 ID 的调用方责任。

- [ ] **步骤 6：执行定向过时内容检查**

运行：

```powershell
rg -n "OpenHarnessClient\.admitPrompt|protocol.*version.: 2|\"version\": 2|下一阶段" docs/architecture-overview.md docs/daemon-application-architecture.md docs/client-sync-flow.md docs/session-runtime-storage-architecture.md
rg -n "client\.sessions\.|SessionOperationRunner|Repository|Transaction|version.: 4" docs/daemon-application-architecture.md docs/client-sync-flow.md docs/session-runtime-storage-architecture.md
```

预期：第一条无匹配；第二条命中相应当前边界。

- [ ] **步骤 7：验证并提交任务 2**

运行：

```powershell
node scripts/check-docs.mjs
git diff --check
git add docs/architecture-overview.md docs/daemon-application-architecture.md docs/client-sync-flow.md docs/session-storage-design.md docs/session-runtime-storage-architecture.md
git commit -m "docs: document current application and storage boundaries"
```

预期：检查退出码为 0；提交只包含五份核心架构文档。

## 任务 3：收口根 README 与文档目录

**文件：**
- 修改：`README.md`
- 修改：`docs/README.md`
- 参考：`apps/*`
- 参考：`packages/*`
- 参考：任务 1、2 完成后的当前权威文档

- [ ] **步骤 1：用真实目录建立 README 项目树**

运行：

```powershell
Get-ChildItem apps -Directory | Sort-Object Name | Select-Object -ExpandProperty Name
Get-ChildItem packages -Directory | Sort-Object Name | Select-Object -ExpandProperty Name
```

按输出更新 `README.md` 的项目结构。删除不存在的 `bridge`、`utils`、`keybindings`、`vim`、`voice`，补入实际存在的 Desktop、Website、Agent Runtime、Context、Environment、Jobs、Plugin Converters/Sources、Terminal/Terminal Node 等目录。

- [ ] **步骤 2：精简并校准根 README 架构说明**

高层 ASCII 图只保留以下链路：

```text
CLI / TUI / Desktop / Web / Bot
-> @openharness/client Resources + protocol
-> HTTP routes
-> application services + SessionOperationRunner
-> repositories / transactions + SQLite
-> Agent Runtime -> Provider / Tools / MCP / Sandbox / Terminal
```

模块表和 print/TUI 流程必须使用领域 Resource，不写死工具或 Provider 数量；详细边界链接到 `docs/`，不在根 README 重复契约全文。

- [ ] **步骤 3：重排文档目录**

在 `docs/README.md` 中：

1. 将架构收口记录、当前存储架构和可交互架构图加入系统鸟瞰或 Durable Application 区；
2. 将 compatibility audit 移到历史区；
3. 将 `session-storage-design.md` 标为历史存储设计；
4. 保持当前代码/测试 > 当前权威文档 > ADR > 历史计划的优先级；
5. 增加“改 Resource、Application Service、Repository 或图源时同步更新哪些文档”的维护提示。

- [ ] **步骤 4：检查目录和调用示例是否仍漂移**

运行：

```powershell
rg -n "packages/(bridge|utils|keybindings|vim|voice)|OpenHarnessClient\.admitPrompt|@openharness/client admitPrompt|下一步" README.md docs/README.md
rg -n "session-runtime-storage-architecture|architecture-migration-status|openharness-current-architecture.html" README.md docs/README.md
```

预期：第一条无匹配；第二条包含当前文档入口。

- [ ] **步骤 5：验证并提交任务 3**

运行：

```powershell
node scripts/check-docs.mjs
git diff --check
git add README.md docs/README.md
git commit -m "docs: refresh project and architecture entry points"
```

预期：检查退出码为 0；提交只包含两级 README。

## 任务 4：从统一图源重新生成当前架构图

**文件：**
- 修改：`docs/openharness-current-architecture.architecture.json`
- 生成：`docs/openharness-current-architecture.html`
- 生成：`docs/openharness-current-architecture.visual-check.html`
- 生成：`docs/openharness-current-architecture.visual-check.json`
- 生成：四张 `.png` 视觉检查截图
- 参考：任务 1–3 完成后的权威文档和真实代码
- 工具：`C:/Users/ruanz/.agents/skills/archify`

- [ ] **步骤 1：读取架构图 schema 和一个同类型示例**

运行：

```powershell
Get-Content -Raw C:/Users/ruanz/.agents/skills/archify/schemas/common.schema.json
Get-Content -Raw C:/Users/ruanz/.agents/skills/archify/schemas/architecture.schema.json
Get-Content -Raw C:/Users/ruanz/.agents/skills/archify/examples/production-deployment.architecture.json
```

预期：只读取 common、architecture schema 和一个 architecture 示例，不检查 renderer 内部实现。

- [ ] **步骤 2：更新 JSON 图源**

保留 `architecture` 类型和 `showcase` 质量级别，主路径控制在 12 个以内的核心节点。节点至少表达产品入口、Client Resources、Protocol、HTTP Routes、Application Services、SessionOperationRunner、Repositories/Transactions、SQLite、Agent Runtime、Provider 与执行能力；边界说明产品状态、durable 状态和 live execution 的唯一负责人。

更新 `meta.repository.revision` 为执行时的 `git rev-parse HEAD`，并重新核实每条 source evidence 的文件与行号。不要手工修改 HTML 或截图。

- [ ] **步骤 3：运行 Archify 更新检查并验证候选图源**

运行：

```powershell
node C:/Users/ruanz/.agents/skills/archify/scripts/check-update.mjs
node C:/Users/ruanz/.agents/skills/archify/bin/archify.mjs validate architecture docs/openharness-current-architecture.architecture.json --quality showcase --json
```

预期：validation 报告 9 项 artifact checks、0 composition errors、0 warnings。若失败，只按诊断修复 JSON 后重新验证。

- [ ] **步骤 4：交付 HTML 并生成视觉检查资产**

仅在最终 validation 通过后运行：

```powershell
node C:/Users/ruanz/.agents/skills/archify/bin/archify.mjs deliver architecture docs/openharness-current-architecture.architecture.json docs/openharness-current-architecture.html --quality showcase --json
node C:/Users/ruanz/.agents/skills/archify/bin/archify.mjs visual-check docs/openharness-current-architecture.html --json
```

预期：deliver 退出码为 0 并给出 specification/artifact SHA-256；visual-check 在四种桌面尺寸无横向或纵向溢出，并生成明暗截图和 JSON receipt。

- [ ] **步骤 5：人工查看明暗主题截图**

逐张检查 1440×900 和 2048×1320 的 light/dark PNG：主链路清楚、标签不遮挡、连线不穿过无关节点、边界框不压住节点、最大尺寸没有明显空白下带。发现问题时只改 JSON，重新执行 validate、deliver 和 visual-check。

- [ ] **步骤 6：验证并提交任务 4**

运行：

```powershell
git diff --check
git add docs/openharness-current-architecture.architecture.json docs/openharness-current-architecture.html docs/openharness-current-architecture.visual-check.html docs/openharness-current-architecture.visual-check.json docs/openharness-current-architecture.visual-check.1440x900.light.png docs/openharness-current-architecture.visual-check.1440x900.dark.png docs/openharness-current-architecture.visual-check.2048x1320.light.png docs/openharness-current-architecture.visual-check.2048x1320.dark.png
git commit -m "docs: regenerate current architecture diagram"
```

预期：提交仅包含图源及其生成物，不包含手工修改的生成文件。

## 任务 5：全局复读、交叉验证与最终收尾

**文件：**
- 复查：`README.md`
- 复查：`docs/README.md`
- 复查：任务 1–4 修改和创建的全部文件
- 必要时修改：仅限上述文件中的事实冲突、坏链接或措辞重复

- [ ] **步骤 1：搜索已知过时入口和迁移时态**

运行：

```powershell
rg -n "OpenHarnessClient\.admitPrompt|OpenHarnessClient\.createSession|protocol.*version.: 2|\"version\": 2|等待下一|下一阶段|双发行|兼容发行" README.md docs/README.md docs/architecture-overview.md docs/architecture-migration-status.md docs/daemon-application-architecture.md docs/client-sync-flow.md docs/session-runtime-storage-architecture.md
```

预期：无匹配。历史文档不纳入该负向搜索，因为它们需要保留当时语境。

- [ ] **步骤 2：逐项核对设计规格**

打开 `docs/superpowers/specs/2026-09-17-architecture-documentation-closeout-design.md`，逐项检查第 2、4、5、7、8 节。每项要求必须能指向一个当前文档段落、Archify receipt 或检查命令结果。

- [ ] **步骤 3：运行文档和架构门禁**

先运行不依赖 pnpm 启动器联网的脚本：

```powershell
node scripts/check-docs.mjs
node scripts/architecture-boundaries.mjs
node scripts/verify-clean-slate.mjs
git diff --check
```

如果本机 `pnpm` 可直接使用，再运行聚合入口：

```powershell
pnpm check:architecture
```

预期：所有已运行命令退出码为 0。若 `pnpm` 只因启动器访问 registry 失败，保留三个本地 Node 脚本的结果并如实记录环境限制，不把网络失败描述成架构失败。

- [ ] **步骤 4：确认工作区只包含预期文档**

运行：

```powershell
git status --short
git diff --stat HEAD~4..HEAD
git log -5 --oneline
```

预期：没有未提交变更；最近提交对应收口页、核心架构文档、README/目录和架构图四个独立交付物。

- [ ] **步骤 5：记录最终验证结果**

最终汇报必须列出：修改的权威文档、保留的历史文档、Archify validation/deliver/visual-check 结果、文档检查、架构检查、clean-slate 检查，以及任何真实存在的环境限制。未获得新鲜输出前不得声称完成。
