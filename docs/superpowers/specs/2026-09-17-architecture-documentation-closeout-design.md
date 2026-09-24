# 架构重构文档收口设计

> 日期：2026-09-17
>
> 状态：已实施（可交互架构图由维护者后续单独调整）
>
> 范围：只修订文档，不修改代码、协议、数据库或开发数据

## 1. 背景

按业务域重组代码、收窄公开 API、拆分运行时职责以及删除兼容层的工作已经完成，代码现状不再处于“等待下一阶段”的迁移中。

当前文档仍混合了三类内容：

1. 描述现在如何运行的权威文档；
2. 记录 Stage 0–8 如何实施的历史计划与设计；
3. 已经过时的迁移措辞或调用示例。

如果继续把这三类内容放在同一层级，后续维护者很难判断应该相信哪一份文档，也容易把已经删除的接口或兼容策略重新带回代码。

## 2. 目标

本次收口要得到一套面向长期维护的文档结构：

- 从文档首页可以直接找到“系统现在如何运行”的权威说明；
- 用一份收口记录说明 Stage 0–8 已完成、最终边界是什么、由哪些检查长期守护；
- 校准核心架构文档，使名称、调用入口、协议版本和职责边界与当前代码一致；
- 历史计划继续可查，但明确它们是决策和实施记录，不再作为当前规范；
- 后续新增功能时，维护者能够判断代码应该进入哪个层、通过哪个入口返回结果。

## 3. 不在本次范围内

- 不修改任何生产代码、测试代码、协议版本、数据库 schema 或构建配置；
- 不执行开发数据重置；
- 不逐篇重写历史设计、实施计划、审查记录和复盘；
- 不把历史计划里的未勾选任务机械改成已完成；
- 不为了排版重新生成所有图，只修复与当前实现矛盾的图或文字；
- 不把临时测试数量写成长期承诺，避免以后正常增删测试造成文档失真。

## 4. 文档分层

### 4.1 当前权威文档

以下文档共同描述当前系统，内容必须与代码一致：

| 文档 | 长期职责 |
| --- | --- |
| `README.md` | 项目入口、主要能力、最短使用路径，以及指向详细架构文档的链接 |
| `docs/README.md` | 文档导航、阅读顺序、当前规范与历史记录的区分 |
| `docs/architecture-overview.md` | 全局分层、包职责、依赖方向、主要运行链路 |
| `docs/session-runtime-storage-architecture.md` | Repository、Transaction、`SessionStore` 和数据库生命周期边界 |
| `docs/daemon-application-architecture.md` | HTTP route 到应用服务、`SessionOperationRunner`、事件发布和结果返回的流程 |
| `docs/client-sync-flow.md` | Resource API、snapshot、SSE、断线恢复和客户端状态同步流程 |
| `docs/architecture-migration-status.md` | Stage 0–8 最终收口记录、最终边界、验收证据和长期门禁 |
| `docs/vykor-current-architecture.architecture.json` | 当前架构图的唯一可编辑图源 |
| `docs/vykor-current-architecture.html` | 从图源生成的可交互架构图 |

`docs/architecture-migration-status.md` 保留现有文件名，避免制造无意义的链接迁移；正文标题和定位改为“架构重构收口与当前边界”，不再描述“下一阶段”。

### 4.2 操作手册

操作手册描述需要人工执行的具体流程，例如 `docs/development-data-reset.md`。它们可以被权威架构文档引用，但不能反向定义架构边界。

### 4.3 历史记录

`docs/superpowers/specs/`、`docs/superpowers/plans/` 以及阶段审查、复盘材料保留原文，作为“为什么这样设计、当时如何迁移”的证据。现有 `docs/session-storage-design.md` 描述已经退场的项目级 JSON snapshot，也继续作为历史设计保留，不能改写成当前 SQLite/Repository 架构。

处理原则：

- 当前索引把它们放在“历史设计与实施记录”下；
- 已经被替代且容易被误认为当前方案的文档，可以在开头补一条简短状态说明；
- 不重写历史正文，不用今天的结论覆盖当时的上下文；
- 当前行为发生变化时，优先更新权威文档，而不是回改每一份历史计划。

## 5. 各文档修订设计

### 5.1 架构收口记录

重构 `docs/architecture-migration-status.md`，至少包含：

1. Stage 0–8 完成矩阵，按阶段概括目标、最终结果和主要证据；
2. 当前四层边界：Client、Server Application、Services、Desktop；
3. 当前协议与数据基线，包括协议版本 4 和单一 migration；
4. 已删除兼容面的明确结论，避免把旧入口当成仍受支持的能力；
5. 长期门禁及各自防止的问题；
6. 开发数据重置与代码收口相互独立的说明；
7. 指向当前权威文档、最终设计和历史计划的链接。

这份文档只报告最终状态，不继续维护“待迁移清单”。以后若发生新的大规模重构，应新建独立设计与计划，不复用 Stage 0–8 编号。

### 5.2 全局架构概览

校准 `docs/architecture-overview.md`：

- 更新核对日期；
- 用当前包名和公开入口说明依赖方向；
- 说明每层的入口、关键步骤、状态存放位置和结果返回位置；
- 明确禁止的反向依赖和跨层捷径；
- 链接到存储、daemon 应用层和 Client 同步三份专题文档；
- 删除已经结束的迁移语气和过时接口名。

### 5.3 Session 存储边界

新增 `docs/session-runtime-storage-architecture.md`，从当前代码重新说明：

- Repository 分别拥有哪类业务状态；
- Transaction 怎样承载原子写入；
- `SessionStore` 仅保留哪些数据库生命周期和运行时协调职责；
- owner lease、waiter/listener、恢复和维护入口分别放在哪里；
- 单一当前 schema 的启动假设，以及不读取旧数据库的边界；
- 新增持久化功能时应该扩展 Repository 还是 Store 的判断规则。

`docs/session-storage-design.md` 只保留历史状态说明，并链接到这份新文档，不重写其历史正文。

### 5.4 Daemon 应用层

校准 `docs/daemon-application-architecture.md`：

- route 如何进入 Query、Command、Interaction、Run Control 等窄服务；
- `SessionOperationRunner` 如何负责串行、ready、owner lease、checkpoint 和 publish；
- 写入、事件发布、错误和取消的返回路径；
- 示例中的协议版本统一为当前版本 4；
- 区分业务编排与单纯转发，避免重新引入无意义 facade。

### 5.5 Client 同步流程

校准 `docs/client-sync-flow.md`：

- 业务调用只通过各领域 Resource，例如 `client.sessions.admitPrompt()`；
- Client 在首个业务请求前完成版本握手；
- snapshot 建立状态基线，SSE 增量更新，断线后从 checkpoint 恢复；
- ID 生成、可靠重试和幂等责任写到实际拥有它们的层；
- 删除顶层业务转发方法或底层 transport 可直接使用的暗示。

### 5.6 两级入口 README

修订 `docs/README.md`：

- 把当前架构文档放在首要阅读路径；
- 将 `architecture-migration-status.md` 描述为完成后的收口记录；
- 增加当前 Session Runtime 存储架构和可交互架构图入口；
- 将 `compatibility-surface-audit.md` 放入历史实施审计，不再与当前架构并列；
- 明确“当前规范”和“历史计划”的权威级别；
- 避免同一规则在索引页复制一遍。

修订根 `README.md`：

- 保持面向使用者，不塞入阶段实施细节；
- 修复已经删除的调用入口或过时示例；
- 按实际 `apps/`、`packages/` 目录重写项目结构，删除不存在的目录并补齐当前包；
- 更新 ASCII 架构图、模块表、print/TUI 同步流程和固定能力数量，避免继续把 `SessionStore` 写成业务总入口；
- 增加一条清晰的架构文档入口；
- 只用简短文字说明重构已收口，详细证据交给 `docs/`。

### 5.7 架构图与流程图

图分为三类处理：

1. 根 `README.md` 的 ASCII 架构图只保留首次阅读所需的高层主链路；
2. `docs/daemon-application-architecture.md` 等权威文档中的 Mermaid 图随正文一起校准，确保 Resource、Application Service、Runner、Repository 和 Runtime 的方向正确；
3. `docs/vykor-current-architecture.architecture.json` 是独立架构图的唯一图源，使用 Archify 重新生成 HTML 和视觉检查资产。

独立架构图当前固定在 2026-08-31 的旧 revision，并把持久层概括成单体 `SessionStore / SQLite`。新图需要表达：

- 产品入口通过领域 Resource 和协议层连接 HTTP routes；
- routes 调用 Query、Command、Interaction、Run Control 等应用服务；
- `SessionOperationRunner` 负责 session 内串行与事件提交；
- 领域 Repository 拥有业务持久状态，`SessionStore` 负责数据库生命周期和少量运行时协调；
- Agent Runtime 继续只负责正在运行的 Agent 循环；
- snapshot/SSE 从 daemon 权威状态返回 Client，再交给产品界面展示。

生成流程遵守 Archify 的单一图源规则：修改 JSON 后先进行 showcase validation，再 deliver HTML，最后做 1440×900、1600×1000、1920×1080 和 2048×1320 的 visual-check，并人工查看明暗主题截图。HTML、检查页、截图和 JSON receipt 都由同一次图源生成，不分别手改。

## 6. 事实来源与冲突处理

文档修订时按以下顺序判定当前事实：

1. 当前代码中的公开类型、导出和运行路径；
2. 当前自动化测试与架构检查；
3. 当前权威文档之间可相互验证的描述；
4. 已完成阶段的设计、实施计划和复盘。

如果历史计划与代码冲突，以代码和当前检查为准，并在收口记录中只写最终结论。若两个当前文档冲突，应找到实际拥有该行为的模块，不凭措辞投票决定。

文档描述重要流程时统一回答四个问题：

1. 从哪里进入；
2. 中间经过哪些关键步骤；
3. 状态保存在哪里；
4. 结果或事件从哪里返回。

## 7. 链接与可维护性规则

- 链接优先指向稳定的文件或目录，不绑定容易变化的行号；
- 当前文档中的代码路径必须在仓库中真实存在；
- 一个约束只选择一份主要文档详细解释，其他文档用链接引用；
- 版本号、header 名称、脚本名等精确值必须从代码或配置中复核；
- 不把兼容、旧版、临时别名写成当前可用能力；
- “已完成”必须能对应到代码、测试、检查脚本或合并记录，而不是只引用计划中的复选框。

## 8. 验收标准

文档收口完成后应满足：

- `docs/README.md` 能清楚区分当前文档、操作手册和历史记录；
- `docs/architecture-migration-status.md` 完整覆盖 Stage 0–8，并明确重构已经结束；
- 当前核心架构文档不存在已删除的顶层 Client 业务方法、旧协议版本或“等待下一阶段”等当前时态表述；
- 根 `README.md` 的项目目录与实际一级目录一致，示例只使用领域 Resource API；
- 当前存储架构由新文档说明，历史 `session-storage-design.md` 不再承担当前规范职责；
- 独立架构图通过 Archify showcase validation 和 visual-check，图源、HTML 与截图来自同一版本；
- 文档内引用的仓库路径存在，Markdown 链接通过仓库文档检查；
- `pnpm check-docs` 通过；
- `pnpm check:architecture` 通过，证明文档修订没有伴随架构代码漂移；
- 对权威文档执行定向文本搜索，不再命中已知的过时入口和阶段措辞；
- `git diff --check` 通过。

## 9. 实施顺序

获得本设计确认后，再编写可执行计划，并按以下批次实施：

1. 先从代码和检查脚本建立事实清单；
2. 重写架构收口记录；
3. 新增当前 Session Runtime 存储架构，并校准其余核心架构专题文档；
4. 更新 `docs/README.md` 和根 `README.md`；
5. 从统一 JSON 图源重新生成独立架构图和视觉检查资产；
6. 只对确实会误导读者的历史文档补状态说明；
7. 运行定向搜索、文档检查、架构检查和 diff 检查；
8. 最后复读所有当前权威文档并人工查看架构图，消除重复定义、相互矛盾和视觉误导。

## 10. 风险控制

- **把历史写成现在：** 导航中显式分区，当前文档不以旧计划作为唯一事实来源。
- **为了完整而复制大量内容：** 采用“一个主题一份主文档，其他位置链接”的规则。
- **只修文字、不核对代码：** 每一项精确名称都从当前导出、route、脚本或测试复核。
- **收口记录再次变成项目看板：** 它只保留最终结果和长期门禁，新工作使用新的设计与计划。
- **修订范围失控：** 限定在权威文档、入口索引以及少量会造成误导的历史状态头，不全面润色历史材料。
