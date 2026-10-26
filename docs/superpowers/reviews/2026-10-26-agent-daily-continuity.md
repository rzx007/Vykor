# Agent 日常续做与交付闭环验收

状态：实现、提交前深度复核及两项边界修复已完成，相关回归与独立打包验证通过；提交和推送结果以 Git 记录及最终回复为准。

## 范围与工作区

落实原架构评审前三点：S1 日常可用性、日常重开续做验收、结构化交付实际消费及状态规则。
第四点简化由另一对话处理，本轮不复制或覆盖 main 中的改动。

基线为 `1ba5452f`，实现收拢到原生工作树 `C:/Users/ruanz/.codex/worktrees/agent-daily-continuity/OpenHarness-ts`，功能分支 `codex/agent-daily-continuity` 已提交并推送 `a1ab945a`。用户随后明确要求合并 main 后推送；本次在主工作区 `D:/code/personal-project/OpenHarness-ts` 从 `748c9de1` 开始整合。
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

## main 合并与职责复核

main 原有三个提交及 CI 通过状态已核对。三处冲突分别整合为：Client 保留显式参数与元数据限制；操作阻断使用 `listSafetyStates().find`，只搬运有限状态且仍返回阻断操作 ID；结果读取保留授权、分页后读取正文，并从同一 Runtime 包识别真实结果读取工具。

职责链保持为：Client 提交请求，HTTP 处理认证与响应，ReviewService 检查人工请求的会话、版本与证据，ToolOperationService 检查实际调用是否结束，Repository 在原 SQLite 事务内保存操作和尝试审计，再返回有限摘要。Core 报告真实调用结束，Runtime 组装工具和系统子合同；业务完成判断由 Server 控制。没有新增结果副本、调度器或恢复数据库。

完整架构检查发现三类接入问题，已按原规则修正：结果引用、分页和搜索的纯数据声明归入既有 `tool-data.ts`，宿主读写能力留在 `result-data.ts`；人工核对服务按同目录既有方式捕获事务与 owner 检查能力；HTTP 真实应用和 SQLite 的两项组装测试移到 `http/__test__/`，应用层七项服务测试留在原目录。规则、例外和旧 Store 调用基线均未放宽。实际检查器反例验证纯数据可以传输，故意传入 `RunToolResultStore` 仍被拒绝。

两项维护整理不阻塞合并：评审数据可直接进入共同校验器，减少对象转字符串再解析；实际调用登记只需 Attempt ID 和状态，可后续改用有限查询，避免复制完整输入。两处都不需要新框架；宿主核验、消费端复核、调用存活保护及持久审计仍需保留。

| 合并结果的实际验证 | 结果 |
|---|---|
| Server 九个交叉路径文件 | 149 项通过：人工核对、调用保护、完整结果授权、关闭重开、准入、执行与 HTTP 参数 |
| Core 工具执行三个文件 | 56 项通过 |
| Services 操作与结果查询 | 35 项通过 |
| Client 交付及人工核对 | 11 项通过 |
| Runtime 绑定、手工调用、系统子 Agent 与工具注册 | 33 项通过 |
| 独立真实 Git / Node 自动评审、调用存活反例、实际 dist 身份 | 分别 11、9、3 项通过，不与主回归重复累计 |
| 边界修正后的人工核对服务及 HTTP、调用保护 | 16 项通过；HTTP 组装位置调整后 2 项再次通过 |
| 纯数据函数回归 | 10 项通过 |
| 类型与构建 | 八个受影响包与 Server/Client 通过；边界修正后五包类型和 Runtime 声明再次通过 |
| 合并后的独立消费者打包 | `verify-pack.mjs` 退出 0；既有 node-pty 辅助日志的限制同前 |
| 完整架构检查 | `pnpm check:architecture` 通过，含公开 Client、纯数据来源、依赖边界、clean-slate 和旧引用检查；旧 Store 调用 104，例外 0 |
| 文档与历史引用 | `pnpm check-docs`、`pnpm check:retired-ui` 通过，731 条历史引用、无错误 |

最终架构、文档、远端提交及 CI 以本次收尾检查和最终回复记录为准。

## 后续局部整理与旧工作树核对

按用户补充要求，在 main `9f734e5a` 基础上落实两处整理：结构化报告直接使用共同的字段及业务校验，只序列化计算字节上限；文本入口仍只解析一次。容量、路径、条数、结论、交付状态与真实回执检查保留。回归先证明 root 和 finding 的非法附加 undefined 字段会被原序列化步骤抹掉，再证明修正后拒绝。

调用登记改用原操作仓库的 `isCurrentDispatch`，只检查当前派发状态和 Attempt 是否匹配，不复制完整输入或结果。owner、事务和 pending 保护沿用原服务。回归先禁止完整 `get`，观察原登记失败，再验证正常登记与错误 Attempt 拒绝；未增加查询层或新数据合同。

上次 main 的 CI `40353262125` 在 Tools 测试失败，唯一失败用例仍把 Shell 日志不可用视为未知执行。已核对实际日志读取返回的是查询不可用，与本轮 Read 的 completed / precondition 语义一致；局部复现失败后修正旧断言，生产读取逻辑未改动。Tools 的 Shell 日志和 Read 两文件共 70 项通过。

旧工作树审计结论：没有遗漏的有效代码需要再次合入。`codex/s1-tool-operation-safety` 的 `13459829`、旧目录实际分支 `codex/result-reading-and-structured-delivery` 的 `1ba5452f` 都是 main 的祖先，独有提交均为 0。旧目录的 52 个已跟踪修改和 11 个未跟踪文件共 63 项，逐文件核对为 62 项已交付阶段副本，以及一份已撤回的 S2.1 草稿；42 项与 a1ab / main 一致，4 项等于 a1ab 但 main 已有后续更新，另 16 项逐一确认是 main 后续保护、简化、测试迁移或文档更新。没有把旧版本回灌 main，也未修改或清理旧工作树。

本次定向 Server 六文件 93 项、操作仓库 27 项通过；Services / Server 类型检查通过。独立安全探针验证 27 组报告数据在四种交付状态及文本入口的新旧决策一致，非法附加字段拒绝，窄查询不读取正文。最终架构、文档、提交与 CI 以本轮收尾证据和最终回复为准。

独立职责复核无新增问题。另有 5 项独立反例探针通过，检查恰好 64 KiB 与超限一字节、路径限制、pass / fail / partial、未核验回执，以及错误 owner、已结算操作、旧 Attempt。架构入口检查通过，旧 Store 调用仍为 104、例外为 0；本地未生成 CLI / 桌面的迁移库存，因此 clean-slate 的这两项产物检查按脚本规则跳过，远端构建及 CI 状态另行核对。

## 保留的边界

- 人工核对入口在 HTTP 和客户端，本轮没有新增桌面按钮。
- applied 缺少可信 completed 结果时仍为 unknown；仅“目标存在”的证据不会直接解除保护。
- 摘录仍有容量上限，不承诺保留所有历史，也不保证模型在所有任务上决策正确。
- 不增加跨进程执行恢复、持久审批、调度框架、表或依赖。
- main 中并行简化的 listSafetyStates、schema 和绑定改动与本轮阻断 ID、可信包装和来源核验一并保留。
- 合并开始时主工作区为 `748c9de1` 且干净，未暂存、清除或覆盖其他未提交内容。
- CI 只匹配 main 推送或面向 main 的 PR；功能分支推送未触发 CI，本次 main 推送后核对新的运行状态。

[设计](../specs/2026-10-26-agent-daily-continuity-design.md) · [计划](../plans/2026-10-26-agent-daily-continuity.md)
