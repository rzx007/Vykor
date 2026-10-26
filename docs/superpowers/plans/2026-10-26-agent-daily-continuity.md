# Agent 日常续做与交付闭环实施计划

**目标：** 落实架构评审前三点，保留已有安全规则，补齐可用入口和回归验收。

**方案：** [本轮设计](../specs/2026-10-26-agent-daily-continuity-design.md)。

**基线：** main `1ba5452f`；主工作区正在执行另一轮简化，本轮先在旧隔离工作树按独立模块实施，再逐文件核对 SHA-256 收拢到原生工作树 `C:/Users/ruanz/.codex/worktrees/agent-daily-continuity/OpenHarness-ts`，分支 `codex/agent-daily-continuity`。旧工作树的 S2.1 计划保持原样，不纳入本轮提交。功能分支已提交并推送 `a1ab945a`；用户随后明确要求合并 main 后推送，合并从主分支 `748c9de1` 开始。

**技术：** TypeScript、现有 S1 Repository、SQLite、Vitest。无新增依赖或数据库表。涉及 Core、Runtime、Tools、Server、Protocol、Client，超过八个文件；按独立行为验收，不扩展公共抽象。

## 1. 可信只读及失败语义

文件：core `engine/tools` 身份核验；runtime `node/tools/default-tool-registry.ts` 登记；server `application/daemon-application.ts` 分类；tools `file/read.ts` 失败结果。

- [x] 先跑基线的 daemon 补读和评审解析定向测试。
- [x] 添加失败回归：Read 不存在文件后仍能继续读取和写入；未知写入后真实 Read 能核查，同名替换不能获取只读承诺。
- [x] 用定义身份和执行函数登记可信只读，保持来源核验；读取已发生的错误报告 completed。
- [x] 运行身份核验、文件读取和 daemon 定向用例。
- [x] 用真实 dist 验证工具身份与宿主包装；Server 从同一 Runtime 包导入既有身份函数，发布验证接入该回归。

```ts
expect(operations.find(row => row.toolName === "Read")).toMatchObject({ kind: "read_only", state: "confirmed" });
expect(writeCount).toBe(1);
```

## 2. 人工核对入口

文件：services `tool-operations` 有限查询；server `application/session/execution` 核对服务、HTTP 独立路由；protocol `session` 纯数据合同；client `resources/session` 独立资源。

- [x] 先写失败用例：未知操作能列出；跨根会话、活跃 Run、旧 revision、空 evidence 被拒绝。
- [x] 只列身份和状态；单条检查返回有界预览；复用 reconcile 保存证据和结果。
- [x] 接通 HTTP 与客户端，模型不获得核对工具；文档提供具体调用示例。
- [x] 核对不自动重试，缺少 confirmed 结果的 applied 仍阻断；验证重开后证据保留。

```ts
await operations.reconcile(sessionId, operationId, { expectedRevision: revision, outcome: "not_applied", evidence: "人工只读核查，目标记录不存在" });
```

## 3. 日常续做验收与摘要补缺

文件：core `engine/compaction/compact-continuity.ts`、`compact-prompt.ts`；server `application/__test__/` 真实 daemon 续做测试。

- [x] 添加未知结果经压缩和再次压缩后仍保留 executionState、isError 的失败用例。
- [x] 摘录只携带已有执行字段，兼容旧摘录；提示区分确认事实和计划。
- [x] SQLite 关闭重开后提交新的“继续”，检查目标、最新约束、结果引用与输入数量。
- [x] 未知写入重开后不得再次执行；可信读取和授权结果补读仍可用。

## 4. 自动评审消费结构化交付

文件：contracts `execution` 宿主子运行选项；runtime Kernel/Node 系统子 Agent；server `application/auto-review` 合同、消费和测试。

- [x] 先写失败用例：普通 JSON 文本不能获得 passed；合法 done/partial 回执可以消费；fail 报告通过核验后仍为评审失败。
- [x] 合同经宿主专用参数进入系统子 Agent，普通子 Agent 不继承合同；仅内部 SubmitResult 可见。
- [x] 宿主核验复用已有评审解析规则；按 receipt.data 消费，拒绝缺失或未经核验回执。
- [x] 运行真实 Node 子 Agent 和自动评审集成测试，保留用户抢占、超时与截断规则。

## 5. Goal 状态规则与收尾

- [x] 添加交付未完成却显式完成 Goal 的回归，使用现有暂停与 run_error 原因记录矛盾。
- [x] done 不自动结束 Goal、waiting 不自动等用户，保留原显式 GoalUpdate 行为。
- [x] 更新相关模块 README、HTTP/客户端用法、本轮验收记录。
- [x] 运行受影响包类型检查、pnpm check-docs、pnpm check:retired-ui、git diff --check。
- [x] 以本轮设计生成独立 HTML，避免覆盖另一对话正在维护的简化页面。
- [x] 核对主工作区、旧 S2.1 计划和本轮修改清单，报告实际结果及限制。

## 6. 提交前复核发现的边界修复

- [x] 为“原 Run 已终止但回执保存失败，Operation 仍为 dispatching”补失败回归；核对列表展示此类记录并给出既有重启恢复步骤，继续拒绝直接解除。
- [x] 用真实执行器、工具服务、核对入口和 SQLite 证明：Run 超时结束不代表底层调用已结束。仍在本进程执行时只能追加 unknown 证据，不能先行标记 applied/not_applied。
- [x] 只在进程内跟踪实际调用 Promise，不持久化调用对象，不新增恢复调度。实际调用结束后清理跟踪。
- [x] 同一 activeAttempt 的真实迟到完成可更新人工核对后的结论，保留核对历史；旧 Attempt 不能覆盖新 activeAttempt。
- [x] 针对两项边界跑红绿和相关回归，刷新复核与文档记录。

提交与推送：功能分支已推送 `a1ab945a`；本次按补充授权整合 main，最终完成情况以 Git 记录及最终回复为准。

## 7. main 合并与职责复核

- [x] 核对 main 干净且原有 CI 通过，保留其参数入口、有限结果查询、统一绑定和测试修复。
- [x] 三处冲突同时保留参数元数据限制、有限状态投影、操作 ID 提示，以及 Runtime 的真实工具身份。
- [x] 检查 HTTP、应用用例、执行核心和持久记录的职责；区分必要检查与可选小整理。
- [x] 修复架构检查发现的纯数据声明归属、事务与 owner 接入方式及 HTTP 组装测试归属，不放宽边界规则。
- [x] 完成合并结果的定向回归、类型、打包、架构与文档检查。

最终交付：按授权提交 main 并推送，核对远端 SHA 和 CI；结果见 Git 记录及最终回复。
