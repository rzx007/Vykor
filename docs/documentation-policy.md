# 文档维护约定

> 状态：权威文档维护约定。适用于仓库 README、当前手册、提案和历史记录。

文档从 [docs/README.md](./README.md) 进入。根 README 负责安装、开发和目录导航；主题手册说明跨模块行为；包及分类目录的 README 说明本目录的职责、入口、状态归属和新增文件位置。

## 信息以哪里为准

每类信息指定一个维护入口，其他文档链接过去。表中的手册解释行为，源码和相应测试用于核实实际实现。

| 信息 | 维护入口 | 核实位置 |
| --- | --- | --- |
| 系统分层和调用方向 | [架构总览](./architecture-overview.md) | `scripts/architecture-policy.json` 与各包公开入口 |
| Agent 的程序调用方式 | [Agent SDK](./agent-sdk.md) | `packages/agent-runtime/package.json` 的 exports |
| Run、工具、子 Agent 的结束与失败规则 | [生命周期契约](./agent-lifecycle-contract.md) | [契约与测试索引](./contract-test-index.md) |
| 运行记录与数据库格式 | [持久运行数据](./durable-execution-data-model.md)、[存储架构](./session-runtime-storage-architecture.md) | `packages/services/src/session-runtime/migrations` |
| HTTP/SSE 格式和协议版本 | [协议契约](./protocol-contract.md) | `packages/protocol/src/runtime/capabilities.ts` |
| 客户端安装和调用 | [Client SDK](./client-sdk.md) | `packages/client/package.json` 与 `packages/client/src/index.ts` |
| CLI 参数与子命令 | [CLI README](../apps/cli/README.md) | `apps/cli/src/index.ts` 和 `apps/cli/src/commands` |
| 模型、默认轮数与设置 | [认证与模型](./auth-provider-model.md) | `packages/host-config/src/settings/settings.ts` |
| 基础工具和宿主注入能力 | [Agent SDK](./agent-sdk.md) | `packages/agent-runtime/src/node/tools/default-tool-registry.ts` |
| 授权与计划模式 | [权限流程](./permission-flow.md) | `packages/host-config/src/permissions/permission-modes.ts`、`packages/permissions/src` |
| 插件编写、调用和市场 | [作者指南](./native-plugin-authoring.md)、[调用流程](./plugin-capability-invocation-design.md)、[市场](./plugin-marketplace.md) | `packages/plugin-contracts/src`、`packages/plugins/src`、`packages/plugin-sources/src` |
| 提示词和记忆 | [上下文与记忆索引](./context-memory-map.md)、[记忆系统](./memory-system.md) | `packages/prompts/src`、`packages/memory/src` |
| 故障恢复、备份和清理 | [运维与恢复](./operations-and-recovery.md) | `packages/server/src/application/recovery` 与维护服务 |
| 构建和发布 | [发布流程](./release-process.md) | 根 `package.json`、`.github/workflows` 和各包脚本 |

发现代码与手册不一致时，先看实现、测试与已批准的约束，确认是文档落后还是代码违反约束。文档整理不能自行改变产品规则，也不能把现有缺陷改写成预期行为。尚未查证的完成状态应明确标出，不能用旧计划中的勾选或测试数字代替验证。

## 文档状态

`docs/` 顶层 Markdown 的前八行必须有 `> 状态：...`。状态说明本文件的用途，不由文件名中的 design、review 或日期推断。

| 分类 | 写法示例 | 阅读方式 |
| --- | --- | --- |
| 当前实现或规范 | `> 状态：当前实现。` / `> 状态：权威契约。` | 用于理解和修改当前代码；只写已经核实的行为 |
| 提案 | `> 状态：提案，尚未实现。` | 用于讨论和验收目标，不能宣称功能已上线 |
| 历史 | `> 状态：历史记录。当前实现见……` | 保留当时方案、证据和限制；开头链接替代文档 |
| 测试夹具 | `> 状态：测试夹具，不是产品说明。` | 仅供测试读取，不进入产品阅读路径 |

部分实现的手册须在正文列明已接入和未接入的部分。测试结果、研究版本和“最后核对”日期只代表实际核对范围，不能因修改排版而统一更新。

## 计划、研究和历史资料

- `docs/adr/` 保存长期决定；修改决定时补充新的依据，并同步相关当前手册。
- `docs/plans/` 与 `docs/superpowers/` 保存阶段方案、计划和验收记录。近期提案也可能放在其中，是否已实施必须看代码及验收证据。
- `docs/research/` 和标为历史的研究报告记录所分析的版本；其中的建议不自动成为当前需求。
- 根 `PLAN-NEXT.md`、`PLAN-REMAINING.md` 是旧路线快照，不再维护为现行待办；根 `MEMORIES.md` 保留审查发现和自动审查水位线，不是能力手册。

保留旧路径可以避免破坏历史链接。历史正文中的旧源码路径、测试结果和术语不批量改成新版本，否则会失去当时的语境。迁移文件时，当前手册的路径、公开入口、父级导航及精确历史引用登记仍必须同步更新。

## 修改时一起核对什么

1. 修改行为的同时更新对应主题手册；目录变化更新所属及父级 README。
2. 根 README 和文档目录只保留必要摘要，详细参数、状态机和功能清单放在指定手册，其他地方引用它。
3. 当前实现被替代后，旧说明改为历史并链接新入口；仍在讨论的内容归入提案。
4. 只有改变跨模块职责时，才同时更新架构总览、存储或协议说明以及架构图源；普通文案修改不重新生成图。
5. 运行 `pnpm check-docs` 和 `pnpm check:retired-ui`；有代码行为变化时再按受影响范围运行测试。

`check-docs` 检查根说明、全部 `docs/` Markdown 以及 apps、packages、tests、scripts 中的 README：验证本地链接和章节，验证当前文档的仓库源码路径，校验顶层状态及导航，并将明确声明的协议版本与源码比较。检查不执行外链请求，也不证明每一句功能描述都正确，内容仍须根据代码和测试维护。
