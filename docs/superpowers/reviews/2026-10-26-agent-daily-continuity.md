# Agent 日常续做与交付闭环验收

状态：实现、提交前深度复核及两项边界修复已完成，相关回归与独立打包验证通过；提交和推送结果以 Git 记录及最终回复为准。

## 范围与工作区

落实原架构评审前三点：S1 日常可用性、日常重开续做验收、结构化交付实际消费及状态规则。
第四点简化由另一对话处理，本轮不复制或覆盖 main 中的改动。

基线为 `1ba5452f`，最终改动保存在原生工作树 `C:/Users/ruanz/.codex/worktrees/agent-daily-continuity/OpenHarness-ts`，分支 `codex/agent-daily-continuity`。用户随后要求复核并推送，本轮提交到当前功能分支，不合并 main。
迁移时核对了全部 62 个实现、测试和模块文档文件的 SHA-256；本验收和契约索引随后在最终工作树补齐。
原有未跟踪 S2.1 计划未迁移，保持在旧工作树。
旧工作树中仍保留阶段性实现副本，正式交付以原生工作树为准。清理旧副本的操作被自动审批以 blocked by policy 拒绝，未执行删除；拒绝信息没有提供更具体原因。

## 已实现

- 只信任实际内置 Read、Glob、Grep、ToolResult 及经核验的宿主附件读取包装；核对来源、定义身份、执行函数和捕获绑定。
- Read 实际查询失败报告 completed 与 isError，参数、策略和执行前取消仍未启动；真正未知写入继续阻断。
- 阻断提示包含操作 ID 和核对地址；HTTP/Client 提供身份列表、单条有界预览和人工核对，不注册模型工具，也不自动重试。
- 核对检查 owner、就绪、同根归属、原 Run 终态、revision、evidence 与结果身份，保留原 Attempt；已归档子会话可经活跃父会话核对。
- 原文摘录保留执行状态、错误标记和完整结果引用；重复压缩和无正文结果仍能携带这些字段。
- 自动评审只消费真实 delivery.data，保留路径、大小和结论一致性校验；合法 fail/partial 报告能通过宿主核验。
- 交付未完成却显式完成 Goal 时暂停；交付本身不改变 Goal。没有真实事件回执时清空自填交付声明。
- 自定义旧宿主可以缺省新核对服务，相关路由返回 404，普通会话路由仍可用。
- Server 的工具身份函数从同一 Runtime 包导入，避免独立 Core 副本与发行包各持一份身份表；没有增加全局状态。

## 红绿证据

先观察缺失文件执行语义、真实 daemon 只读读取、同名与来源伪造、缺失 completed 的 applied、核对入口、阻断提示、归档子会话和旧宿主兼容测试失败，再实现最小修复。

压缩测试先证明 executionState、isError、resultRef 会丢失；无正文回执也会丢失引用。修复后重复压缩和旧摘要兼容通过。
关闭重开与压缩后继续的真实 daemon 测试检查目标、最新约束、产物、结果补读和输入数量；未知写入不会被自动重发，副作用次数保持一次。

交付测试先证明普通 JSON 冒充、缺少核验的回执、receipt.data 被忽略及 Goal 状态矛盾；真实 Node 系统子 Agent 的 SubmitResult 与 pass/fail/partial 场景修复后通过。
投影测试先证明无真实回执时会残留自填 metadata.delivery，修复后清空。

实际发行包探针证明独立 Core 副本识别不了 Runtime 的四个内置工具，宿主包装经冻结捕获后同样失败。实际 dist 测试先取得 3 项失败，改用 Runtime 自有标记和识别函数后 3 项通过；这项检查已接入发布验证。

## 实施阶段的验证记录

| 检查 | 结果 |
|---|---|
| 原生工作树 Server 九个定向文件 | 210 项通过，覆盖投影、Goal、评审消费、操作安全、人工核对、真实读取与重开 |
| 打包身份修复后的 reader/service 两文件增量回归 | 17 项通过；与前一行重叠，不重复累计 |
| 原生工作树 Runtime 四个定向文件 | 36 项通过，覆盖注册表、系统子 Agent、子配置与启动绑定顺序 |
| 原生工作树 Core 两个压缩文件 | 37 项通过 |
| 原生工作树 Repository、Read、Client | 分别 26、51、1 项通过 |
| 实际 dist 身份回归 | 3 项通过，已接入 verify-pack |
| 先行实施时的真实 Node 自动评审 Git 集成 | 11 项通过，包含 pass、fail、partial；相关实现和测试迁移时逐文件核对 |
| 受影响九个包的类型检查 | agent-contracts、Runtime、Core、Domain、Protocol、Services、Tools、Client、Server 通过 |
| Server/Client 跨包类型 | `pnpm check-types:server-client` 通过 |
| Runtime 公开声明与三个 bundle | 生成成功，Kernel 声明及构建边界检查通过 |
| 独立消费者打包验证 | `verify-pack.mjs` 退出 0，公开声明、跨包错误身份、Native Tool、TerminalOpen/JobCancel、父子运行、事件和幂等关闭通过 |
| 文档与历史引用 | `pnpm check-docs` 通过；`pnpm check:retired-ui` 无错误，731 条引用；`git diff --check` 通过 |

初次新环境检查缺少 Runtime 构建声明和桌面声明依赖，补齐构建及本地声明链接后复跑通过，没有修改产品源码绕过类型检查。打包脚本通过其已有 VYKOR_PNPM_CLI 配置执行。
Windows 的 node-pty 辅助进程仍输出既有 AttachConsole failed 日志，打包断言及进程退出码为 0；本轮未修改终端实现。

先行实施工作树的已通过测试与原生工作树复跑不重复累计为覆盖量。

## 提交前复核及修复

对全部改动、新增文件及打包入口进行深度复核，并由安全、职责划分及反例检查分别交叉验证。发现并修复两项 P2 问题；修复后再次独立复核，未发现本轮范围内仍需阻塞提交的问题。

1. 原 Run 结束但结果保存失败时，dispatching 会阻断新写入，却不出现在核对列表中。现在列表包含此类记录，列表、详情和拒绝响应提供恢复提示；仍须先排查存储、等待实际调用结束、确认旧 daemon 停止并重启，经过既有启动恢复后再核对，不能直接释放。
2. Run 超时或取消时，底层调用仍可能继续执行。现在 Core 在调用前将实际 Promise 交给宿主；实际结束前只能追加 unknown 证据，不能人工确认已生效或未生效。实际结束后清理进程内跟踪；同一 activeAttempt 的合法迟到完成可以更新 not_applied，保留人工历史，新 Attempt 仍拒绝旧回执。

两项问题均先观察失败，再补最小修复和永久回归。独立 SQLite 探针还覆盖保存失败、副作用次数、unknown/reject/abort、登记失败无副作用、重复迟到回执与旧 Attempt 拒绝，探针只留在 ignored 目录。

| 本次复核实际执行 | 结果 |
|---|---|
| Server 八个定向文件 | 180 项通过：操作调用、人工核对、操作安全、日常重开、补读、评审消费、Goal 和回执投影 |
| Core 四个定向文件 | 60 项通过：调用前登记、执行限制、操作执行和压缩事实 |
| Services 操作仓库、Client 核对资源 | 分别 27、1 项通过 |
| 两组独立 SQLite 反例探针 | 各 9 项通过；与永久回归场景重叠，不累计覆盖量 |
| 受影响类型检查 | Contracts、Core、Services、Server 以及 Domain、Protocol、Client、Runtime 通过；Server/Client 跨包检查通过 |
| Runtime 声明、三个 bundle 与实际 dist 身份 | 构建成功；dist 身份 3 项通过 |
| 独立消费者打包 | `verify-pack.mjs` 退出 0，公开声明、跨包错误身份、Native Tool、终端/Job、父子运行、事件和关闭检查通过 |
| 最后文档与历史引用检查 | `pnpm check-docs`、`pnpm check:retired-ui`、`git diff --check` 通过；历史引用 731 条、无错误 |

文档、历史引用及补充 HTML 在最后修改后再次检查。上表只记录本次复核实际执行；未重复完整仓库测试。Windows 打包仍有前述 node-pty 辅助日志，断言和退出码通过。

## 保留的边界

- 人工核对入口在 HTTP 和客户端，本轮没有新增桌面按钮。
- applied 缺少可信 completed 结果时仍为 unknown；仅“目标存在”的证据不会直接解除保护。
- 摘录仍有容量上限，不承诺保留所有历史，也不保证模型在所有任务上决策正确。
- 不增加跨进程执行恢复、持久审批、调度框架、表或依赖。
- main 中并行简化的 listSafetyStates、schema 和绑定改动尚未合并到本分支；后续整合需同时保留本轮阻断 ID、可信包装和来源核验。
- 本次只读核对时主工作区为 `748c9de1`，工作区干净；其他对话的简化及测试提交未纳入本分支，也未被改动。
- CI 只匹配 main 推送或面向 main 的 PR；仅推送本功能分支不会自动触发该流程。本轮不创建 PR，远端提交及实际 CI 状态在推送后核对。

[设计](../specs/2026-10-26-agent-daily-continuity-design.md) · [计划](../plans/2026-10-26-agent-daily-continuity.md)
