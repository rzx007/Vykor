# S1 工具操作安全验收记录

> 状态：S1 实施与合并前限定范围验收记录；实现起点为 `25812866`，提交与合并结果以 Git 历史为准。S2 的检查点续跑、子执行恢复、Workflow 恢复和 S3 的持久审批尚未实施。
> 日期：2026-10-26。工作分支：`codex/s1-tool-operation-safety`。

对应[分阶段方案](../specs/2026-10-26-agent-core-capability-completion-design.md)与[实施计划](../plans/2026-10-26-s1-tool-operation-safety.md)。先写计划和合同，再以失败测试建立要求，随后实现、独立审查和验证。

## 已接入的能力

- daemon 默认提供 AgentToolSafety。独立 SDK 默认不创建数据库，可显式提供操作记录和强制规则，配置不完整就拒绝。
- root、child、手动 runTool、嵌套及代理调用经过同一工具管道；参数与工具绑定在检查期间固定。
- 每个逻辑操作有 operationId，每次实际派发有独立 toolAttemptId。派发意图先保存，完整结果保存后才推进下一步；等待审批不伪造实际尝试。
- 新 Execution 头、Operation 和 Attempt 共用现有事务、owner、回滚日志和 SQLite/memory 路由；新增 `0009_exotic_owl.sql` 增量，不修改旧迁移。
- 强制规则在原有权限与审批流程中单独生效，默认 5 秒超时；失败、拒绝和取消均不派发。可选 Hook 保留原合同。
- 结果未知、旧运行遗留派发或回执提交失败时，同一根会话树停止新危险派发；已启动项仍可结算。合法迟到回执只补审计，不重开终态 Run。
- 核对证据追加保存。相同已确认调用复用结果，独立相同参数的操作不合并；确认未生效后重新授权，重试创建新 Attempt。
- 按时间批量清理在预览和执行时保护整棵树的未决记录；单独明确删除会话仍沿用原删除入口。

## 设计落实时的调整

Services 新目录使用 `execution-records/`，避免恢复已退役的旧 `executions/` 实现路径。架构策略只登记两个新存储分类，旧路径禁令和环境依赖禁令保留。

Repository 使用纯数据 commands。内容块、结果、操作票据和派发回执集中到已有 `agent-contracts/tool-data` 入口，原公开入口继续导出同一类型；存储不接收工具函数或环境句柄。

宿主捕获已绑定的事务与 owner 检查能力，根树策略统一执行。架构例外为 0，旧 Store 调用数量保持 104；没有抬高基线。旧 UI 引用只更新 10 条原文未变的行号，没有新增批准条目。

## 首轮实施验证记录

下表保存首次实施时的验证范围与结果；合并前复跑证据见下一节，不能把未复跑项目视为本轮新结果。

| 检查 | 命令或入口 | 结果 |
|---|---|---|
| 六个受影响包类型 | `pnpm -r --workspace-concurrency=2 --filter @vykor/agent-contracts --filter @vykor/domain-contracts --filter @vykor/core --filter @vykor/services --filter @vykor/agent-runtime --filter @vykor/server run check-types` | 通过 |
| core 完整测试 | `pnpm --filter @vykor/core test` | 36 文件，465 测试通过 |
| Agent 数据合同 | `pnpm --filter @vykor/agent-contracts test` | 5 文件，27 测试通过 |
| 操作仓库、数据库、事务与路由 | Services 的 tool-operation-repository、session-database、transaction-coordinator、chat-persistence 测试 | 4 文件，37 测试通过，其中操作仓库 23 项 |
| SDK 与 Kernel 接线 | Runtime 的 `src/__test__/tool-safety-wiring.test.ts`、Kernel index 测试 | 2 文件，18 测试通过 |
| 宿主策略、清理与身份投影 | Server 的 tool-operation-service、cleanup-settings、tool-lifecycle-identity 测试 | 3 文件，21 测试通过 |
| 原有消息投影回归 | Server 的 transcript-projection、daemon-agent-event-projector 与新身份测试 | 3 文件，72 测试通过，与上行部分重叠 |
| 真实管道与真实崩溃 | Agent integration 的 s1-tool-safety-pipeline、durable-tool-operations | 2 文件，7 测试通过，其中 3 项强制杀独立 worker |
| HTTP 定向回归 | server-client/http：文本、工具、child、permission 相关名称筛选 | 8 项通过，58 项未运行 |
| 数据库增量 | `pnpm --filter @vykor/services db:check` | 通过 |
| CLI / Desktop 数据库打包 | `pnpm --filter @vykor/services test:bundled-baseline` | 两种打包的空库与重开通过 |
| Kernel 依赖边界 | `node --test packages/agent-runtime/scripts/__test__/kernel-boundary.test.mjs` | 8 项通过 |
| SDK tarball | `pnpm --filter @vykor/agent-runtime test:pack` | 声明消费、跨 bundle、Native Tool、Terminal/Jobs、root/child 通过，退出码 0 |
| 架构 | `node scripts/architecture-boundaries.mjs` | 通过，0 例外，旧 Store 调用 104 |
| 旧 UI 引用 | `pnpm check:retired-ui` | 通过，733 条精确引用、90 个退役路径 |
| 文档与空白 | `pnpm check-docs`、`git diff --check` | 通过 |

跨进程测试分别终止在：派发意图已经提交但未调用、外部效果已经发生但回执未保存、完整结果已确认。新进程重新打开同一 SQLite，以新 owner 检查操作与独立效果文件；已生效项可通过只读证据找回回执，不再次写入。

独立审查用真实 SQLite 复现并修复了两个问题：同根树其他运行绕过未决操作，年龄清理删除未决审计。随后补充“子 Run 仍活跃、回执提交刚失败、兄弟运行已授权”的窗口，以及多项失败各自解除阻塞的回归。限定复审未发现剩余实质问题。

## 合并前独立审查与复跑

2026-10-26 按用户授权再次审查。三路独立审查覆盖工具派发与权限、存储与接管、公开合同与模块边界。新发现的五项问题均先复现，再修复并复核：

| 问题 | 修复与证据 |
|---|---|
| P1：接管进程先构造 Store，漏掉旧 owner 最后提交的派发 | 在取得写入权的同一事务内重新读取持久状态，再切换共享读模型；保留本地 memory 会话与事件序号。双 Store 实测从第二次写入成功变为 unknown 阻断，效果文件仅保留第一次写入 |
| P2：固定 ownerId 重启被当作当前活体而跳过 | 启动恢复全部遗留 dispatching；相同 ownerId、generation 2 也恢复为可核对的 unknown |
| P2：维护子运行遗漏 preparation 提供的安全能力 | 准备安全对后传入子运行，所有退出路径释放；真实 QueryEngine 探针从写效果 1 次、检查 0 次变为写效果 0 次、检查 1 次 |
| P2：不同模型回合使用相同 provider 调用 ID，错误复用旧结果 | 宿主 generationId 参与意图与组合唯一键；两回合产生两个操作和两次独立效果，显式 executeTool 的同身份重投仍只执行一次 |
| P2：准备前拒绝的调用被投影为虚构 Attempt | not_started 不生成尝试 ID；未知工具、缺少参数的真实管道均为效果 0、Operation 0、Attempt 为空 |

修复后的定向复审未保留未解决的正确性或安全发现。

| 本轮重新执行 | 结果 |
|---|---|
| `pnpm check-types` | 72 个 workspace 任务成功，随后 server-client 类型检查通过；Turbo 提示部分 build 没有输出文件，不是类型错误 |
| core 完整测试 | 36 文件、465 项通过 |
| Services 操作仓库、数据库、回滚、保存与路由 | 5 文件、46 项通过；操作仓库含 25 项 |
| SessionStore 原有回归 | 70 项通过 |
| Server 宿主、清理与尝试身份投影 | 3 文件、23 项通过 |
| Runtime 安全接线与 Kernel | 2 文件、20 项通过 |
| 真实管道与独立进程终止 | 2 文件、8 项通过；包含跨回合同 ID 回归及 3 个强制终止窗口 |
| `db:check` 与 `test:bundled-baseline` | 增量检查、CLI/Desktop 空库与重开通过 |
| 架构与 Kernel 边界 | 0 例外，旧 Store 调用 104；Kernel 边界 8 项通过 |
| 文档、精确退役引用与空白 | 与最新主分支合并后通过：4 项文档策略测试、898 份 Markdown（含 398 份模块 README）、731 条精确引用及 90 个退役路径 |

主工作区原有三个暂存文件均为 S1 初稿，单独保存为文档提交；另一批文档入口整理提交需要完整保留。主分支合入采用保留双方提交的方式，不通过丢弃工作区内容取得干净状态。

S1 实现提交为 `4240f574`，主工作区初稿提交为 `26c8853f`，保留的文档整理提交为 `1597185b`。合并冲突仅涉及文档：保留新的入口结构，并使用 S1 最终方案与实施记录。整合后的生产源码与已测试的 S1 提交一致，额外变动为主分支文档及其检查脚本。

## 当前限制

- 验证环境为 Windows；Linux、macOS 的跨进程 SQLite 行为未验证。
- SDK 打包测试退出码为 0，但 Windows node-pty 的控制台辅助进程输出 `AttachConsole failed`。相关终端创建和取消断言通过，这不是无警告的打包运行。
- daemon 当前默认把工具声明为 non_replayable。具体只读、业务去重和文件效果核对适配器仍按后续阶段逐个接入；工具超时不能据此自动重发。
- S1 的实现身份在当前宿主中固定；重启后不会把同名新函数当成旧实现。跨进程检查点续跑与稳定版本重建属于 S2。
- 未执行整个仓库的完整测试，也未把 43 项 P0 场景全部计为通过。S2/S3 场景仍保留为待验收。
- H2 的十倍历史与结果规模尚未验收。当前完整结果在 Operation 与 Attempt 各保存一份，另有原消息记录；大结果会增加存储和启动读取量，后续可在同一 SQLite 中共享正文引用。本次不据此承诺性能目标已经达成。
- 提交与本地合并按用户授权执行，结果以 Git 历史为准；未授权推送或发布。
